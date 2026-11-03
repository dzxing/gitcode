'use strict'

const { createHash } = require('node:crypto')
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const signature = (entries) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')

class StashOperations {
  constructor(git, validators) {
    this.git = git
    this.validators = validators
  }
  async list(repo, signal) {
    const raw = await this.git.git(
      repo,
      ['stash', 'list', '-z', '--format=%gd%x00%H%x00%gs%x00%cI%x00%P'],
      { signal },
    )
    const parts = raw.split('\0'),
      entries = []
    for (let i = 0; i + 4 < parts.length; i += 5) {
      const [ref, oid, message, date, parents] = parts.slice(i, i + 5)
      if (!/^stash@\{\d+\}$/.test(ref) || !oidPattern.test(oid))
        throw new Error('贮藏列表无法解析，请刷新后重试。')
      const branch = message.match(/^(?:On|WIP on) ([^:]+):/)?.[1] || '未知来源'
      entries.push({ ref, oid, message, date, branch, base: parents.split(' ')[0] })
    }
    return { entries, signature: signature(entries) }
  }
  async resolve(repo, oid, signal) {
    if (typeof oid !== 'string' || !oidPattern.test(oid)) throw new Error('无效的贮藏对象。')
    const list = await this.list(repo, signal)
    const entry = list.entries.find((item) => item.oid === oid)
    if (!entry) throw new Error('贮藏已变化或不存在，请刷新列表。')
    const parents = (await this.git.git(repo, ['show', '-s', '--format=%P', oid], { signal }))
      .trim()
      .split(' ')
    if (![2, 3].includes(parents.length) || parents.some((parent) => !oidPattern.test(parent)))
      throw new Error('贮藏结构异常，无法操作。')
    return { entry, parents, list }
  }
  async read(repo, oid, file, signal) {
    const { parents } = await this.resolve(repo, oid, signal)
    const options = { signal }
    const names = async (from, to) => {
      const fields = (
        await this.git.git(
          repo,
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--name-status',
            '-z',
            from,
            to,
            '--',
          ],
          options,
        )
      ).split('\0')
      const result = []
      for (let i = 0; i + 1 < fields.length; i += 2)
        result.push({ status: fields[i], path: fields[i + 1] })
      return result
    }
    const files = await names(parents[0], oid)
    const indexFiles = await names(parents[0], parents[1])
    const stagedPaths = indexFiles.map((item) => item.path)
    for (const item of indexFiles)
      if (!files.some((file) => file.path === item.path)) files.push(item)
    const untracked = parents[2]
      ? (await this.git.git(repo, ['ls-tree', '-r', '--name-only', '-z', parents[2]], options))
          .split('\0')
          .filter(Boolean)
      : []
    for (const name of untracked) {
      const existing = files.find((file) => file.path === name)
      if (existing) existing.status = '?'
      else files.push({ path: name, status: '?' })
    }
    let diff = null,
      indexDiff = null
    if (file !== null && file !== undefined) {
      this.validators.filePath(file)
      if (!files.some((item) => item.path === file)) throw new Error('该文件不在贮藏记录中。')
      const from = untracked.includes(file)
        ? (
            await this.git.git(repo, ['hash-object', '-t', 'tree', '--stdin'], {
              signal,
              input: '',
            })
          ).trim()
        : parents[0]
      const to = untracked.includes(file) ? parents[2] : oid
      const text = await this.git.git(
        repo,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-color', from, to, '--', file],
        options,
      )
      const chars = Array.from(text)
      diff = { diff: chars.slice(0, 300000).join(''), truncated: chars.length > 300000 }
      if (stagedPaths.includes(file)) {
        const indexText = Array.from(
          await this.git.git(
            repo,
            [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-color',
              parents[0],
              parents[1],
              '--',
              file,
            ],
            options,
          ),
        )
        indexDiff = {
          diff: indexText.slice(0, 300000).join(''),
          truncated: indexText.length > 300000,
        }
      }
    }
    return { files, stagedPaths, base: parents[0], diff, indexDiff }
  }
  async available(repo, signal) {
    await this.git.noInProgress(repo, signal)
    if (!(await this.git.head(repo, signal))) throw new Error('首次提交后才能使用贮藏。')
    const state = await this.git.status(repo, signal)
    if ([...state.staged, ...state.unstaged].some((file) => file.status === 'U'))
      throw new Error('请先解决工作区冲突。')
    return state
  }
  async execute(repo, request, signal) {
    const before = await this.list(repo, signal)
    if (request.stashSignature !== before.signature)
      throw new Error('贮藏列表已变化，请刷新后重新确认。')
    let entry
    if (request.action !== 'stash-create') {
      entry = before.entries.find(
        (item) => item.oid === request.stashOid && item.ref === request.stashRef,
      )
      if (!entry) throw new Error('目标贮藏已变化，请刷新后重新确认。')
    }
    let args
    if (request.action === 'stash-create') {
      const state = await this.available(repo, signal)
      if (typeof request.includeUntracked !== 'boolean')
        throw new Error('请选择是否包含未跟踪文件。')
      const message = this.validators
        .string(request.message, '贮藏说明', { empty: true, max: 500 })
        .trim()
      if (/[\r\n]/.test(message)) throw new Error('贮藏说明不能包含换行。')
      const files = [
        ...state.staged,
        ...state.unstaged.filter((file) => request.includeUntracked || file.status !== '?'),
      ]
      if (!files.length) throw new Error('没有符合范围的修改可贮藏。')
      const submodules = (await this.git.git(repo, ['ls-files', '--stage', '-z'], { signal }))
        .split('\0')
        .filter((line) => line.startsWith('160000 '))
        .map((line) => line.slice(line.indexOf('\t') + 1))
      if (files.some((file) => submodules.includes(file.path)))
        throw new Error('子模块内部修改不能随父仓库贮藏，请先在对应子模块中处理。')
      // No pathspec is accepted here. Literal mode interferes with stash's internal
      // quoted untracked-file cleanup (notably spaces/Unicode); leave its own parser intact.
      args = [
        '--no-literal-pathspecs',
        '-c',
        'submodule.recurse=false',
        'stash',
        'push',
        '--no-keep-index',
        ...(request.includeUntracked ? ['--include-untracked'] : []),
        '-m',
        message || `GitCode · ${request.expectedBranch} · ${new Date().toISOString()}`,
      ]
    } else if (request.action === 'stash-apply' || request.action === 'stash-pop') {
      const state = await this.available(repo, signal)
      if (state.staged.length) throw new Error('恢复前请先提交或取消暂存当前已暂存的修改。')
      if (state.unstaged.length && request.confirmUnstaged !== true)
        throw new Error('当前工作区有未暂存修改，请确认后再恢复；恢复可能产生冲突。')
      if (typeof request.restoreIndex !== 'boolean') throw new Error('请选择是否恢复原暂存状态。')
      await this.resolve(repo, entry.oid, signal)
      // Native stash apply may overwrite ignored files when restoring a staged
      // addition. Ignored files are outside the dirty-worktree confirmation.
      await this.git.merge.checkIgnoredPaths(repo, entry.oid, signal)
      args = [
        '-c',
        'stash.index=false',
        '-c',
        'submodule.recurse=false',
        'stash',
        'apply',
        ...(request.restoreIndex ? ['--index'] : []),
        entry.oid,
      ]
    } else if (request.action === 'stash-drop') {
      if (request.confirmDelete !== true) throw new Error('请先确认删除具体贮藏。')
      args = ['stash', 'drop', entry.ref]
    } else throw new Error('不支持的贮藏操作。')

    // Do not resolve a stale ordinal after another app has changed the stash stack.
    if ((await this.list(repo, signal)).signature !== before.signature)
      throw new Error('贮藏列表已变化，未开始操作。')
    try {
      const output = await this.git.git(repo, args, { signal, timeout: 300000 })
      if (request.action === 'stash-pop') {
        const next = await this.list(repo, signal)
        if (next.signature !== before.signature)
          return {
            output,
            outcome: 'partial',
            warning: '内容已恢复，但贮藏列表发生变化，已保留记录。请核对后手动删除。',
          }
        try {
          await this.git.git(repo, ['stash', 'drop', entry.ref], { signal })
        } catch (error) {
          return {
            output,
            outcome: 'partial',
            warning: `内容已恢复，贮藏移除未完成。请核对后手动删除：${this.git.safeError(error)}`,
          }
        }
      }
      if (request.action === 'stash-create') {
        const after = await this.list(repo, signal)
        if (after.signature === before.signature)
          return { output, outcome: 'failed', error: '未创建新的贮藏，请刷新核对修改范围。' }
        const remaining = await this.git.status(repo, signal)
        if (
          remaining.staged.length ||
          remaining.unstaged.some((file) => request.includeUntracked || file.status !== '?')
        )
          return {
            output,
            outcome: 'partial',
            warning: '已创建贮藏，但工作区仍有修改，请检查后再切换分支。',
          }
      }
      return { output, outcome: 'succeeded' }
    } catch (error) {
      // Git can modify files before failing or being cancelled; never retry or discard automatically.
      const restoring = ['stash-apply', 'stash-pop'].includes(request.action)
      return {
        output: '',
        outcome: signal?.aborted ? 'cancelled' : 'partial',
        error: this.git.safeError(error),
        warning: restoring
          ? '恢复未完整完成，可能有部分文件已恢复。贮藏记录保留，请检查工作区并解决冲突，不要重复恢复。'
          : '贮藏操作未完整完成，请刷新核对记录与工作区，不要重复执行。',
      }
    }
  }
}
module.exports = { StashOperations }
