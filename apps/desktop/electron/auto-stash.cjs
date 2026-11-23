'use strict'
const { randomUUID } = require('node:crypto')

// Automatic saves are ordinary, visible Git stashes. A paused/failed operation
// leaves that exact record available across restarts; it is never silently lost.
class AutoStashOperations {
  constructor(git) {
    this.git = git
  }
  async run(repo, label, signal, operation, restoreBranch) {
    const git = this.git
    const state = await git.stash.available(repo, signal)
    if (!state.staged.length && !state.unstaged.length) return operation()
    const head = await git.head(repo, signal),
      branch = await git.currentBranch(repo, signal),
      before = await git.stash.list(repo, signal),
      marker = `GitCode auto ${label} ${randomUUID()}`
    const saved = await git.stash.execute(
      repo,
      {
        action: 'stash-create',
        expectedHead: head,
        expectedBranch: branch || 'detached HEAD',
        stashSignature: before.signature,
        includeUntracked: true,
        message: marker,
      },
      signal,
    )
    if (saved.outcome !== 'succeeded')
      return {
        ...saved,
        warning: '自动贮藏未完整完成，尚未开始后续操作。请检查工作区与贮藏记录。',
      }
    const entries = (
      await git.stash.list(repo, signal?.aborted ? AbortSignal.timeout(10000) : signal)
    ).entries
    const entry = entries.find((e) => e.message.includes(marker))
    if (!entry)
      throw new Error('自动贮藏已创建，但无法核实记录身份。未开始后续操作，请检查贮藏列表。')
    const retained =
      '本地更改已自动贮藏并保留。请完成或中止当前操作，再从贮藏记录恢复；不要重复执行。'
    if (signal?.aborted) return { outcome: 'cancelled', output: '', warning: retained }
    let result
    try {
      await git.checkContext(
        repo,
        { expectedHead: head, expectedBranch: branch || 'detached HEAD' },
        signal,
      )
      result = await operation()
    } catch (error) {
      error.message += `\n${retained}`
      throw error
    }
    if (result.outcome !== 'succeeded' || signal?.aborted)
      return {
        ...result,
        ...(signal?.aborted ? { outcome: 'cancelled' } : {}),
        warning: [result.warning, retained].filter(Boolean).join('\n'),
      }
    try {
      await git.noInProgress(repo, signal)
      if ((await git.currentBranch(repo, signal)) !== (restoreBranch ?? branch))
        throw new Error('当前分支与预期结果不一致，未自动恢复本地更改。')
      const current = await git.status(repo, signal)
      if (current.staged.length || current.unstaged.length)
        throw new Error('操作后工作区出现其他更改，为避免混合修改，未自动恢复。')
      const list = await git.stash.list(repo, signal)
      const chosen = list.entries.find((e) => e.oid === entry.oid)
      if (!chosen) throw new Error('自动贮藏已被外部工具移动或删除，请检查实际结果。')
      const restored = await git.stash.execute(
        repo,
        {
          action: 'stash-pop',
          expectedHead: await git.head(repo, signal),
          expectedBranch: (await git.currentBranch(repo, signal)) || 'detached HEAD',
          stashOid: chosen.oid,
          stashRef: chosen.ref,
          stashSignature: list.signature,
          restoreIndex: true,
        },
        signal,
      )
      if (restored.outcome !== 'succeeded')
        return {
          ...result,
          outcome: 'partial',
          warning: `主要操作已完成，但本地更改恢复未完整完成。贮藏记录保留，请检查工作区。\n${restored.error || restored.warning || ''}`,
        }
      return {
        ...result,
        output: [result.output, '本地更改已自动贮藏并恢复。'].filter(Boolean).join('\n'),
      }
    } catch (error) {
      return {
        ...result,
        outcome: signal?.aborted ? 'cancelled' : 'partial',
        warning: [result.warning, git.safeError(error), retained].filter(Boolean).join('\n'),
      }
    }
  }
}
module.exports = { AutoStashOperations }
