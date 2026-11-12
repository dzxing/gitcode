'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const hookNames = new Set([
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-push',
])

// Read only the top-level Git process's hooks. A hook can itself run Git; its
// child ids are local to a different session and must not be attributed here.
function parseHookTrace(text) {
  let root
  const children = new Map()
  for (const line of text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event.sid !== 'string') continue
    root ??= event.sid
    if (event.sid !== root || !Number.isInteger(event.child_id)) continue
    if (
      event.event === 'child_start' &&
      event.child_class === 'hook' &&
      hookNames.has(event.hook_name) &&
      children.size < 32
    )
      children.set(event.child_id, { name: event.hook_name, code: null })
    if (event.event === 'child_exit' && Number.isInteger(event.code)) {
      const hook = children.get(event.child_id)
      if (hook) hook.code = event.code
    }
  }
  return [...children.values()]
}

async function diagnoseCommand(env, run, observe) {
  let directory, trace
  try {
    // The raw trace can contain command arguments. Keep it private, ephemeral,
    // and out of the journal. Only allowlisted hook names and exit codes survive.
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-command-'))
    trace = path.join(directory, 'events.json')
  } catch {
    // Diagnostics must not stop an otherwise usable commit or push.
  }
  let result, failure
  try {
    result = await run(
      trace
        ? {
            ...env,
            GIT_TRACE2_EVENT: trace.replaceAll('\\', '/'),
            GIT_TRACE2_CONFIG_PARAMS: '',
            GIT_TRACE2_ENV_VARS: '',
          }
        : env,
    )
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    let hooks = []
    if (trace) {
      let handle
      try {
        handle = await fs.open(trace, 'r')
        const buffer = Buffer.alloc(Math.min((await handle.stat()).size, 4 * 1024 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        hooks = parseHookTrace(buffer.subarray(0, bytesRead).toString('utf8'))
      } catch {
        // Missing or incomplete tracing is not evidence of a successful hook.
      } finally {
        await handle?.close().catch(() => {})
        await fs
          .rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          .catch(() => {})
      }
    }
    observe({ ...(result || failure?.gitResult || {}), hooks })
  }
}

function hookReport(hooks) {
  return hooks
    .map((hook) => `${hook.name}：${hook.code === null ? '未记录完成结果' : `退出码 ${hook.code}`}`)
    .join('\n')
}

function presentCommandFailure(action, result, hooks) {
  const failed = hooks.find((hook) => hook.code !== 0)
  const isCommit = action === 'commit' || action === 'commit-selected'
  if (failed?.name === 'post-commit' && isCommit && result.outcome !== 'succeeded')
    return {
      error:
        '提交后的 post-commit Hook 未正常结束。提交可能已经生成，请核对提交树和日志，不要重复提交。',
    }
  if (failed && (result.error || result.outcome !== 'succeeded')) {
    const interrupted = failed.code === null
    const environment =
      /(?:command not found|(?:node|npm|npx|bun|pnpm|yarn)(?:\.exe)?[^\r\n]*(?:not found|not recognized)|不是内部或外部命令)/i.test(
        result.error || '',
      )
    return {
      error: `${isCommit ? '提交' : '推送'}${interrupted ? '在' : '被'} ${failed.name} Hook ${interrupted ? '执行期间中断，结果需核对' : '阻止'}。${isCommit ? '提交说明已保留，请检查差异和暂存内容后重试。' : '本地提交保留，请处理检查结果后重新推送。'}${environment ? 'Hook 所需的程序不可用，请检查桌面应用的 PATH 环境。' : ''}`,
      ...(action === 'push' && !interrupted ? { warning: undefined } : {}),
    }
  }
  if (failed && isCommit && result.outcome === 'succeeded')
    return {
      warning: `提交已创建，但 ${failed.name} Hook ${failed.code === null ? '结果未确认' : `失败（退出码 ${failed.code}）`}。请查看日志，无需重复提交。`,
    }
  if (
    isCommit &&
    result.error &&
    /(?:gpg failed to sign|failed to sign|signing failed|sign_and_send_pubkey|Couldn't load public key|No private key found|(?:gpg|ssh-keygen).*No such file|ssh-keygen.*(?:failed|error))/i.test(
      result.error,
    )
  )
    return {
      error: '提交签名未完成。提交说明和暂存内容已保留，请检查签名密钥、签名程序或认证提示后重试。',
    }
  return {}
}

module.exports = { parseHookTrace, diagnoseCommand, hookReport, presentCommandFailure }
