import { fetchFailureSummary } from './activityLogPresentation'

export function noticePresentation(value: string, error = false) {
  const raw = value
    // eslint-disable-next-line no-control-regex -- Git hooks may include ANSI color sequences.
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1…@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1')
    .replace(/\r\n/g, '\n')
    .trim()
  const wrapped = /Error invoking remote method\s+['"][^'"]+['"]:\s*/g
  const hasStack = /^\s*at\s+.+(?::\d+|\(native\))\)?\s*$/m.test(raw)
  const hasWrapper = /Error invoking remote method\s+['"]/.test(raw)
  if (!hasStack && !hasWrapper && raw.length <= 240 && raw.split('\n').length <= 3)
    return { text: raw }

  const first = (raw.replace(wrapped, '').split('\n')[0] || '')
    .replace(/^(?:(?:Error|TypeError|RangeError|SyntaxError|ReferenceError):\s*)+/, '')
    .trim()
  let text: string
  if (
    !error ||
    (/[\u4e00-\u9fff]/.test(first) && !/\b(?:TypeError|ReferenceError|SyntaxError):/.test(first))
  )
    text = first.length <= 160 ? first : first.slice(0, 157) + '…'
  else if (
    /authentication|permission denied|publickey|credential|certificate|SSL|could not resolve|timed? out|timeout|unable to access|failed to connect|connection refused|network.*unreachable/i.test(
      first,
    )
  )
    text = fetchFailureSummary(first)
  else if (/not a git repository/i.test(first)) text = '所选目录不是 Git 仓库，请检查仓库目录。'
  else if (/ENOENT|not found|找不到/.test(first)) text = '找不到操作所需的程序或文件，请查看详情。'
  else text = '操作未完成，请查看错误详情。'
  return { text, details: raw }
}
