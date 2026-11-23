'use strict'
const { createHash } = require('node:crypto')
function quietSsh(command) {
  const match = /^("[^"\r\n]*[\\/]ssh(?:\.exe)?"|(?:[^\s"\r\n]*[\\/])?ssh(?:\.exe)?)(\s.*)?$/i.exec(
    command.trim(),
  )
  return match ? `${match[1]} -o BatchMode=yes -o StrictHostKeyChecking=yes${match[2] || ''}` : null
}
const signature = (entry) => createHash('sha256').update(JSON.stringify(entry)).digest('hex')

async function autoFetch(git, value) {
  if (typeof value !== 'string' || value.length > 32768) throw Error('无效的仓库路径。')
  const journal = git.journal
  const interval = journal.settings.autoFetchInterval * 60000
  if (!interval || git.current || git.pendingJobs || git.closing || journal.leases.size)
    return { skipped: true }
  // Reserve synchronously, before filesystem validation, so concurrent renderer ticks coalesce.
  const lease = { controller: null, interrupted: false }
  journal.leases.set(value, lease)
  try {
    return await git.job(
      async (signal) => {
        // A foreground job may arrive after reservation but before this microtask.
        // In that case there is no controller to abort yet: yield before any Git work.
        if (lease.interrupted || git.pendingJobs > 1 || !journal.settings.autoFetchInterval)
          return { skipped: true }
        lease.controller = git.current
        const repo = await git.repository(value, signal)
        const previous = journal.status(repo)
        if (
          journal.now() >= previous.lastAttempt &&
          journal.now() - previous.lastAttempt < interval
        )
          return { skipped: true, status: previous }
        const remotes = (await git.git(repo, ['remote'], { signal })).trim()
        if (!remotes) return { skipped: true, status: previous }
        // Even planning failures must be throttled, rather than retried every heartbeat.
        journal.fetches[repo] = { ...previous, lastAttempt: journal.now() }
        let record
        try {
          const context = {
            expectedHead: await git.head(repo, signal),
            expectedBranch: (await git.currentBranch(repo, signal)) || 'detached HEAD',
          }
          const plan = await git.sync.plan(repo, 'fetch', context, signal)
          const internal = git.sync.plans.get(plan.id)
          const signatures = Object.fromEntries(
            internal.entries.map((entry) => [entry.remote, signature(entry)]),
          )
          const skipped = internal.entries.filter(
            (entry) =>
              previous.remotes[entry.remote]?.paused &&
              previous.remotes[entry.remote]?.signature === signatures[entry.remote],
          )
          if (skipped.length === internal.entries.length) {
            git.sync.plans.delete(plan.id)
            return { skipped: true, status: journal.status(repo) }
          }
          // Preserve the verified target: execute() rechecks the full plan fingerprint.
          // Filtering changes the fingerprint inputs, so use an explicit exclusion at execution.
          internal.backgroundSkip = skipped.map((entry) => entry.remote)
          const ssh =
            process.env.GIT_SSH_COMMAND ||
            (await git.git(repo, ['config', '--get', 'core.sshCommand'], {
              signal,
              optional: true,
            })) ||
            process.env.GIT_SSH ||
            'ssh'
          const needsSsh = internal.entries.some(
            (entry) =>
              /^ssh:\/\//i.test(entry.url) ||
              (!/^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url) &&
                !/^[a-z]:[\\/]/i.test(entry.url) &&
                /^[^/\\]+:/.test(entry.url)),
          )
          const sshCommand = quietSsh(ssh)
          if (needsSsh && !sshCommand) {
            git.sync.plans.delete(plan.id)
            throw Error('自定义 SSH 工具需手动获取；后台获取不能确认其非交互模式。')
          }
          // OpenSSH takes the first value of an option: place quiet options before
          // user-provided options, otherwise an existing BatchMode=no can win.
          git.backgroundSsh = sshCommand
          record = journal.start('fetch', repo, { background: true })
          git.activeLog = record
          git.startActivity('fetch', repo)
          const result = await git.sync.execute(repo, { action: 'fetch', planId: plan.id }, signal)
          if (skipped.length && result.outcome === 'succeeded') {
            result.outcome = 'partial'
            result.warning = '部分远端等待认证处理，已跳过后台重试。请手动获取。'
          }
          journal.updateFetch(repo, result, signatures)
          let snapshot = null
          if (!signal.aborted) {
            try {
              snapshot = await git.snapshot(repo, signal)
            } catch (error) {
              if (signal.aborted) {
                // A foreground job deliberately preempted this read; this is not
                // a failed network fetch or a new condition requiring user action.
                if (result.outcome === 'succeeded') result.outcome = 'cancelled'
              } else {
                result.refreshError = git.safeError(error)
                if (result.outcome === 'succeeded') result.outcome = 'partial'
                result.warning = [
                  result.warning,
                  '获取已结束，但仓库显示未能刷新，请手动刷新仓库状态。',
                ]
                  .filter(Boolean)
                  .join('\n')
                const status = journal.status(repo)
                journal.fetches[repo] = {
                  ...status,
                  error: [status.error, `刷新仓库状态失败：${result.refreshError}`]
                    .filter(Boolean)
                    .join('\n'),
                }
              }
            }
          }
          journal.finish(record, result)
          return { skipped: false, snapshot, status: journal.status(repo), outcome: result.outcome }
        } catch (error) {
          if (!record) record = journal.start('fetch', repo, { background: true })
          const result = {
            outcome: signal.aborted ? 'cancelled' : 'failed',
            error: git.safeError(error),
          }
          journal.updateFetch(repo, result)
          journal.finish(record, result)
          return { skipped: false, status: journal.status(repo), outcome: result.outcome }
        } finally {
          git.activeLog = null
          git.backgroundSsh = null
        }
      },
      { background: true },
    )
  } finally {
    journal.leases.delete(value)
  }
}
module.exports = { autoFetch, quietSsh }
