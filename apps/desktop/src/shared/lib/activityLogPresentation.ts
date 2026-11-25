import type { OperationLogEntry } from '../contracts'

export function fetchFailureSummary(value: string) {
  if (/host key verification|主机.*验证/i.test(value))
    return 'SSH 主机验证失败，请检查主机密钥后重试。'
  if (
    /authentication|permission denied|publickey|could not read (?:username|password)|credential|认证/i.test(
      value,
    )
  )
    return '认证或权限检查失败，请确认凭据与仓库访问权限。'
  if (/certificate|SSL|证书/i.test(value)) return '远端证书验证失败，请检查证书配置。'
  if (/could not resolve|name or service not known|解析/i.test(value))
    return '无法解析远端地址，请检查网络和仓库地址。'
  if (/timed? out|timeout|超时/i.test(value)) return '连接远端超时，请检查网络后重试。'
  if (
    /does not appear to be a git repository|repository.*not found|not a git repository/i.test(value)
  )
    return '远端仓库不存在或无法访问，请检查地址与权限。'
  if (
    /could not read from remote|unable to access|failed to connect|connection refused|network.*unreachable/i.test(
      value,
    )
  )
    return '无法连接远端，请检查网络与访问权限。'
  if (/取消|cancelled|canceled/i.test(value)) return '获取已取消，请核对已经更新的远端。'
  // Preserve short application-authored explanations; raw Git output stays in details.
  const line = value.trim().split('\n')[0] || ''
  if (/[\u4e00-\u9fff]/.test(line) && line.length <= 180 && !/fatal:|https?:\/\//i.test(line))
    return line
  return '获取未完成，请展开原始输出查看原因。'
}

export function fetchLogPresentation(record: OperationLogEntry) {
  const remotes = (record.steps || []).map((step) => ({
    remote: step.remote,
    ok: step.ok,
    summary: step.ok ? '已获取' : fetchFailureSummary(step.message || ''),
    output: step.message || '',
  }))
  const failed = remotes.filter((step) => !step.ok).length
  const succeeded = remotes.length - failed
  let summary: string
  if (record.state === 'running') summary = '正在获取远端更新…'
  else if (record.state === 'cancelled') summary = '获取已取消，部分远端可能已经更新。'
  else if (record.state === 'unknown') summary = '上次获取的结果待核对，请先检查仓库状态。'
  else if (record.refreshError || /刷新失败|显示未能刷新/.test(record.message))
    summary = '获取已结束，但仓库显示未能刷新，请手动刷新仓库状态。'
  else if (failed) summary = `${succeeded} 个远端已获取，${failed} 个远端未完成。`
  else if (record.state === 'succeeded')
    summary = remotes.length ? `已获取 ${remotes.length} 个远端。` : '远端获取已完成。'
  else if (record.warning && record.warning.length <= 300 && /[\u4e00-\u9fff]/.test(record.warning))
    summary = record.warning
  else summary = fetchFailureSummary(record.message || record.output)

  // Older logs may contain the same aggregate error in both fields. Retain one
  // complete copy, and don't repeat a remote's output in the aggregate section.
  const chunks = [
    ...new Set(
      [record.message, record.output]
        .map((text) => {
          let clean = (text || '').replace(/\r\n/g, '\n').trim()
          for (const remote of remotes)
            if (remote.output)
              clean = clean.replaceAll(remote.output.replace(/\r\n/g, '\n').trim(), '').trim()
          if (record.warning && summary === record.warning)
            clean = clean.replaceAll(record.warning, '').trim()
          return clean
        })
        .filter(Boolean),
    ),
  ]
  const raw = chunks
    .filter(
      (chunk, index) =>
        !chunks.some((other, otherIndex) => index !== otherIndex && other.includes(chunk)),
    )
    .join('\n\n')
  return { summary, remotes, raw }
}
