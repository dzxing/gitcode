'use strict'
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const missing = (error) => {
  if (error.code === 'ENOENT') return null
  throw error
}
const MAX_TEXT = 256 * 1024
class MergeOperations {
  constructor(git, validators) {
    this.git = git
    this.validators = validators
    this.reads = new Map()
  }
  async gitFile(repo, name, signal, locations) {
    const location =
      locations?.get(name) ||
      path.resolve(
        repo,
        (await this.git.git(repo, ['rev-parse', '--git-path', name], { signal })).trim(),
      )
    return fs.readFile(location, { signal }).catch(missing)
  }
  async state(repo, signal, locations) {
    const rebase = await this.git.rebase.state(repo, signal, locations)
    const raw = await this.git.git(repo, ['ls-files', '--unmerged', '-z'], { signal }),
      incoming =
        (await this.gitFile(repo, 'MERGE_HEAD', signal, locations))?.toString('utf8').trim() || ''
    const cherry = (await this.gitFile(repo, 'CHERRY_PICK_HEAD', signal, locations))
      ?.toString('utf8')
      .trim()
    const revert = (await this.gitFile(repo, 'REVERT_HEAD', signal, locations))
      ?.toString('utf8')
      .trim()
    const todo =
      (await this.gitFile(repo, 'sequencer/todo', signal, locations))?.toString('utf8') || ''
    const sequence = cherry
      ? 'cherry-pick'
      : revert
        ? 'revert'
        : /^pick /m.test(todo)
          ? 'cherry-pick'
          : /^revert /m.test(todo)
            ? 'revert'
            : null
    if (!raw && !incoming && !rebase && !sequence) return null
    const files = new Map()
    for (const record of raw.split('\0').filter(Boolean)) {
      const match = record.match(/^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/)
      if (!match) throw new Error('无法解析冲突文件，请通过 Git 检查。')
      const [, mode, oid, stage, file] = match
      this.validators.filePath(file)
      const value = files.get(file) || { path: file, stages: {} }
      value.stages[stage] = { mode, oid }
      files.set(file, value)
    }
    let unsupported = false
    for (const name of [...(!rebase ? ['rebase-apply'] : [])]) {
      const location =
        locations?.get(name) ||
        path.resolve(
          repo,
          (await this.git.git(repo, ['rev-parse', '--git-path', name], { signal })).trim(),
        )
      if (await fs.stat(location).catch(missing)) unsupported = true
    }
    if (incoming && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(incoming)) unsupported = true
    const head = await this.git.head(repo, signal),
      branch = await this.git.currentBranch(repo, signal),
      status = await this.git.status(repo, signal)
    const index = await this.git.indexFingerprint(repo, signal),
      paths = [...new Set([...status.staged, ...status.unstaged].map((f) => f.path))].sort()
    let content,
      unsupportedReason = ''
    try {
      content = await this.git.selectedCommit.fingerprint(repo, paths, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      unsupported = true
      unsupportedReason = this.git.safeError(error)
      content = `unavailable:${unsupportedReason}`
    }
    const config = await this.git.git(repo, ['config', '--null', '--list', '--includes'], {
      signal,
    })
    const attributes = files.size
      ? await this.git.git(
          repo,
          [
            'check-attr',
            '-z',
            '--stdin',
            'filter',
            'working-tree-encoding',
            'ident',
            'conflict-marker-size',
          ],
          { signal, input: [...files.keys()].join('\0') + '\0' },
        )
      : ''
    const formats = new Map()
    const fields = attributes.split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const format = formats.get(fields[i]) || { markerSize: 7, manualReason: '' }
      if (fields[i + 1] === 'conflict-marker-size') {
        const size = Number(fields[i + 2])
        if (Number.isSafeInteger(size) && size > 0 && size <= MAX_TEXT) format.markerSize = size
      } else if (!['unspecified', 'unset'].includes(fields[i + 2]))
        format.manualReason =
          '该文件使用 LFS、内容过滤器或编码转换，不提供手动文本保存。请采用完整版本或外部工具处理。'
      formats.set(fields[i], format)
    }
    const signature = hash(
      JSON.stringify({
        head,
        branch,
        incoming,
        raw,
        index,
        content,
        status,
        unsupported,
        config,
        attributes,
        rebase,
        sequence,
        cherry,
        revert,
        todo,
      }),
    )
    return {
      active: !!incoming || !!rebase || !!sequence,
      incoming: rebase?.pausedOid || cherry || revert || incoming,
      head,
      branch: branch || 'detached HEAD',
      ...(rebase ? { rebase } : {}),
      ...(sequence ? { sequence } : {}),
      signature,
      unsupported,
      unsupportedReason,
      files: [...files.values()].map((f) => ({
        ...f,
        ...formats.get(f.path),
        type: !f.stages[2]
          ? 'added-or-deleted-locally'
          : !f.stages[3]
            ? 'deleted-incoming'
            : !f.stages[1]
              ? 'both-added'
              : 'both-modified',
      })),
      staged: status.staged,
      message:
        rebase?.message ||
        (await this.gitFile(repo, 'MERGE_MSG', signal))?.toString('utf8').trim() ||
        'Merge changes',
    }
  }
  async safePath(repo, file) {
    this.validators.filePath(file)
    const absolute = path.join(repo, file)
    let current = path.dirname(absolute)
    while (current !== repo && current.startsWith(repo + path.sep)) {
      if ((await fs.lstat(current).catch(missing))?.isSymbolicLink())
        throw new Error('冲突路径位于符号链接目录中，请使用外部 Git 处理。')
      current = path.dirname(current)
    }
    const stat = await fs.lstat(absolute).catch(missing)
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error('该冲突文件类型暂不支持内置编辑，请使用外部 Git 处理。')
    return absolute
  }
  async blob(repo, stage, signal) {
    if (!stage) return { exists: false, text: '', binary: false }
    if (!['100644', '100755'].includes(stage.mode))
      return { exists: true, text: null, binary: true }
    const size = Number(
      (await this.git.git(repo, ['cat-file', '-s', stage.oid], { signal })).trim(),
    )
    if (size > MAX_TEXT) return { exists: true, text: null, binary: true }
    try {
      // A batch header keeps a leading BOM away from the transport decoder's
      // start, where TextDecoder would otherwise discard it.
      const framed = await this.git.git(repo, ['cat-file', '--batch'], {
        signal,
        input: stage.oid + '\n',
      })
      const text = framed.slice(framed.indexOf('\n') + 1, -1)
      return { exists: true, text: text.includes('\0') ? null : text, binary: text.includes('\0') }
    } catch (error) {
      if (signal?.aborted) throw error
      return { exists: true, text: null, binary: true }
    }
  }
  async read(repo, file, signal) {
    const state = await this.state(repo, signal)
    if (file === null) return { state, file: null }
    const conflict = state?.files.find((f) => f.path === file)
    if (!conflict || state.unsupported)
      throw new Error('冲突状态已变化或该操作暂不支持，请刷新冲突列表。')
    const absolute = await this.safePath(repo, file),
      buffer = await fs.readFile(absolute, { signal }).catch(missing)
    const [base, ours, theirs] = await Promise.all(
      [1, 2, 3].map((stage) => this.blob(repo, conflict.stages[stage], signal)),
    )
    let working = null
    try {
      if (buffer && buffer.length <= MAX_TEXT && !buffer.includes(0))
        working = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    } catch {}
    const editable =
      !conflict.manualReason && [base, ours, theirs].every((v) => !v.binary) && working !== null
    let markerSize = conflict.markerSize || 7
    // Attributes may have changed since Git wrote the markers. Retain the
    // actual complete marker block's width when re-reading such a conflict.
    const widths = [
      ...new Set(
        Array.from((working || '').matchAll(/^(<+)(?: |\r?$)/gm), (match) => match[1].length),
      ),
    ].sort((a, b) => a - b)
    for (const size of widths) {
      if (
        new RegExp(`^={${size}}\\r?$`, 'm').test(working) &&
        new RegExp(`^>{${size}}(?: |\\r?$)`, 'm').test(working)
      ) {
        markerSize = Math.min(markerSize, size)
        break
      }
    }
    if ((await this.state(repo, signal))?.signature !== state.signature)
      throw new Error('读取期间文件发生变化，请重新打开。')
    const token = randomUUID()
    for (const [k, v] of this.reads) if (v.expires < Date.now()) this.reads.delete(k)
    while (this.reads.size >= 64) this.reads.delete(this.reads.keys().next().value)
    this.reads.set(token, { repo, file, signature: state.signature, expires: Date.now() + 300000 })
    return {
      state,
      file: {
        path: file,
        token,
        base,
        ours,
        theirs,
        working,
        editable,
        markerSize,
        ...(conflict.manualReason ? { manualReason: conflict.manualReason } : {}),
        supported: [...Object.values(conflict.stages)].every((v) =>
          ['100644', '100755'].includes(v.mode),
        ),
        branch: state.branch,
        incoming: state.incoming,
      },
    }
  }
  async verify(repo, request, signal) {
    await this.git.checkContext(repo, request, signal)
    const state = await this.state(repo, signal)
    if (!state || state.unsupported || state.signature !== request.mergeSignature)
      throw new Error('合并或文件状态已变化，请刷新后重新确认。')
    return state
  }
  async checkIgnoredPaths(repo, oid, signal) {
    const added = (
      await this.git.git(
        repo,
        [
          'diff',
          '--no-ext-diff',
          '--no-renames',
          '--name-only',
          '--diff-filter=A',
          '-z',
          'HEAD',
          oid,
          '--',
        ],
        { signal },
      )
    )
      .split('\0')
      .filter(Boolean)
    if (!added.length) return
    const ignored = (
      await this.git.git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
        signal,
      })
    )
      .split('\0')
      .filter(Boolean)
    const files = new Set(ignored),
      directories = new Set()
    for (const file of ignored) {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
    }
    for (const file of added) {
      const parts = file.split('/')
      if (
        files.has(file) ||
        directories.has(file) ||
        parts.some((_, i) => i > 0 && files.has(parts.slice(0, i).join('/')))
      )
        throw new Error(
          `目标新增路径 ${file} 与本地被忽略的文件冲突。请先备份或移走该本地文件，再重新操作；当前未覆盖该文件。`,
        )
    }
  }
  async integrate(repo, oid, signal, options = {}) {
    // Keep start() available for explicit merge preparation and GitFlow steps.
    // Normal non-squash merges finish automatically, like GitKraken.
    await this.git.noInProgress(repo, signal)
    const head = await this.git.head(repo, signal)
    const bases = (
      await this.git.git(repo, ['merge-base', '--all', head, oid], {
        signal,
        allowedCodes: [0, 1],
      })
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    if (!bases.length) throw new Error('未找到共同历史，未执行合并。')
    if (options.ffOnly && !bases.includes(head) && !bases.includes(oid))
      throw new Error('Not possible to fast-forward: 本地与远端已分叉，未开始合并或自动贮藏。')
    await this.checkIgnoredPaths(repo, oid, signal)
    return this.git.autoStash.run(repo, 'merge', signal, async () => {
      const result = await this.start(repo, oid, signal, options)
      const state = await this.state(repo, signal)
      if (state?.active && !state.files.length && result.outcome === 'succeeded') {
        const finished = await this.execute(
          repo,
          {
            action: 'merge-finish',
            expectedHead: state.head,
            expectedBranch: state.branch,
            mergeSignature: state.signature,
            message: state.message || 'Merge branch updates',
          },
          signal,
        )
        return { ...finished, output: [result.output, finished.output].filter(Boolean).join('\n') }
      }
      return result
    })
  }
  async start(repo, oid, signal, { noFF = false, ffOnly = false } = {}) {
    await this.git.noInProgress(repo, signal)
    if (
      (
        await this.git.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          signal,
        })
      ).length
    )
      throw new Error('合并前请先提交或贮藏当前修改。')
    await this.checkIgnoredPaths(repo, oid, signal)
    let output = ''
    try {
      output = await this.git.git(
        repo,
        [
          '-c',
          'merge.autoStash=false',
          '-c',
          'submodule.recurse=false',
          'merge',
          ...(noFF ? ['--no-ff'] : ffOnly ? ['--ff-only'] : ['--ff']),
          '--no-squash',
          '--no-commit',
          '--no-edit',
          '--no-stat',
          '--no-autostash',
          '--no-overwrite-ignore',
          oid,
        ],
        { signal, timeout: 300000 },
      )
    } catch (error) {
      const state = await this.state(repo, AbortSignal.timeout(10000))
      if (state?.active && state.files.length)
        return {
          output,
          outcome: 'partial',
          warning: `发现 ${state.files.length} 个冲突文件，请解决后完成合并。`,
        }
      throw error
    }
    const state = await this.state(repo, signal)
    return {
      output,
      outcome: 'succeeded',
      ...(state?.active ? { warning: '合并结果已准备好，请检查并完成合并提交。' } : {}),
    }
  }
  async execute(repo, request, signal) {
    const state = await this.verify(repo, request, signal)
    if (request.action === 'merge-resolve') {
      const plan = this.reads.get(request.token)
      if (
        !plan ||
        plan.repo !== repo ||
        plan.file !== request.file ||
        plan.signature !== state.signature ||
        plan.expires < Date.now()
      )
        throw new Error('冲突文件读取已失效，请重新打开文件。')
      const conflict = state.files.find((f) => f.path === request.file)
      if (!conflict) throw new Error('该文件已不再冲突。')
      if (!Object.values(conflict.stages).every((v) => ['100644', '100755'].includes(v.mode)))
        throw new Error('该类型冲突请使用外部 Git 处理。')
      const absolute = await this.safePath(repo, request.file)
      if (!['ours', 'theirs', 'manual'].includes(request.choice))
        throw new Error('请选择明确的解决方式。')
      let expectedText
      if (request.choice === 'manual') {
        this.validators.string(request.content, '合并结果', { empty: true, max: MAX_TEXT })
        const read = await this.read(repo, request.file, signal)
        this.reads.delete(read.file.token)
        if (!read.file.editable)
          throw new Error(read.file.manualReason || '二进制或非 UTF-8 文件不支持手动文本保存。')
        if (read.state.signature !== state.signature) throw new Error('文件已变化，请重新打开。')
        const size = read.file.markerSize || 7
        if (
          Buffer.byteLength(request.content) > MAX_TEXT ||
          new RegExp(`^(?:<{${size},}|>{${size},}|\\|{${size},})(?: |\\r?$)`, 'm').test(
            request.content,
          )
        )
          throw new Error('合并结果仍含冲突标记或内容过大，请继续处理。')
        expectedText = read.file.working
      }
      this.reads.delete(request.token)
      let wrote = false
      try {
        if (request.choice === 'manual') {
          const handle = await fs.open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW || 0))
          try {
            const stat = await handle.stat()
            if (!stat.isFile() || stat.size > MAX_TEXT) throw new Error('文件类型或大小已变化。')
            const current = await handle.readFile({ signal })
            if (hash(current) !== hash(Buffer.from(expectedText)))
              throw new Error('文件内容已变化，请重新打开。')
            const data = Buffer.from(request.content)
            wrote = true
            for (let offset = 0; offset < data.length;) {
              if (signal?.aborted) throw new Error('保存已取消，请检查文件状态。')
              const result = await handle.write(data, offset, data.length - offset, offset)
              if (!result.bytesWritten) throw new Error('文件未能完整写入。')
              offset += result.bytesWritten
            }
            await handle.truncate(data.length)
          } finally {
            await handle.close()
          }
          await this.git.git(repo, ['add', '--', request.file], { signal })
        } else {
          const stage = request.choice === 'ours' ? 2 : 3
          if (conflict.stages[stage]) {
            await this.git.git(repo, ['checkout', `--${request.choice}`, '--', request.file], {
              signal,
            })
            wrote = true
            await this.git.git(repo, ['add', '--', request.file], { signal })
          } else {
            await this.git.git(repo, ['rm', '-f', '--', request.file], { signal })
            wrote = true
          }
        }
        if ((await this.state(repo, signal))?.files.some((f) => f.path === request.file))
          throw new Error('Git 仍将该文件标记为冲突，请检查。')
        return { output: '', outcome: 'succeeded' }
      } catch (error) {
        if (wrote)
          return {
            output: '',
            outcome: 'partial',
            error: this.git.safeError(error),
            warning: '文件可能已保存，但未完整标记解决，请检查工作区后重新打开。',
          }
        throw error
      }
    }
    if (state.rebase) throw new Error('当前正在变基，请使用继续、跳过或中止变基。')
    if (state.sequence) throw Error('请使用优选或还原的继续、跳过或中止操作。')
    if (!state.active) throw new Error('当前不是未完成的合并；贮藏恢复冲突解决后无需完成合并。')
    if (request.action === 'merge-abort')
      return {
        output: await this.git.git(repo, ['-c', 'merge.autoStash=false', 'merge', '--abort'], {
          signal,
          timeout: 300000,
        }),
        outcome: 'succeeded',
      }
    if (request.action !== 'merge-finish') throw new Error('不支持的冲突操作。')
    if (state.files.length) throw new Error('仍有未解决的冲突文件。')
    if ((await this.git.status(repo, signal)).unstaged.length)
      throw new Error('工作区仍有未保存到暂存区的修改，请先检查。')
    const message = this.validators.string(request.message, '合并提交说明', { max: 20000 }).trim()
    if (!message) throw new Error('请填写合并提交说明。')
    return {
      output: await this.git.git(repo, ['commit', '-m', message], { signal, timeout: 300000 }),
      outcome: 'succeeded',
    }
  }
}
module.exports = { MergeOperations }
