'use strict'
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const absent = (error) => {
  if (error.code === 'ENOENT') return null
  throw error
}
const stale = () => Error('文件、分支或暂存区已变化，请重新读取差异后再选择。')

function parseDiff(diff) {
  const lines = diff.split('\n'),
    hunks = []
  let hunk = null
  for (let id = 0; id < lines.length; id++) {
    const text = lines[id],
      match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (match) {
      hunk = {
        id,
        old: +match[1],
        oldCount: +(match[2] ?? 1),
        next: +match[3],
        nextCount: +(match[4] ?? 1),
        lines: [],
        changed: [],
        hunkOnly: false,
      }
      hunks.push(hunk)
    } else if (hunk && /^[ +\-]/.test(text)) {
      const line = { id, type: text[0], content: text.slice(1) + '\n' }
      hunk.lines.push(line)
      if (line.type !== ' ') hunk.changed.push(id)
    } else if (hunk && text.startsWith('\\ No newline at end of file')) {
      const previous = hunk.lines.at(-1)
      if (!previous) throw Error('差异换行标记无效，请使用整文件操作。')
      previous.content = previous.content.slice(0, -1)
      hunk.hunkOnly = true
    } else if (hunk && text !== '') throw Error('暂不支持此差异格式，请使用整文件操作。')
  }
  if (
    !hunks.length ||
    hunks.some(
      (h) =>
        !h.changed.length ||
        h.lines.filter((l) => l.type !== '+').length !== h.oldCount ||
        h.lines.filter((l) => l.type !== '-').length !== h.nextCount,
    )
  )
    throw Error('没有可局部操作的文本修改，请使用整文件操作。')
  return hunks
}

function selectedContent(base, hunks, ids, unstage) {
  const selected = new Set(ids),
    available = new Set(hunks.flatMap((h) => h.changed))
  if (
    !ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || !available.has(id)) ||
    selected.size !== ids.length
  )
    throw Error('请选择有效的修改行。')
  const input = base.match(/[^\n]*\n|[^\n]+$/g) || [],
    output = []
  let cursor = 0
  for (const h of hunks) {
    if (
      h.hunkOnly &&
      h.changed.some((id) => selected.has(id)) &&
      !h.changed.every((id) => selected.has(id))
    )
      throw Error('缺少结尾换行的修改块需整块操作。')
    const count = unstage ? h.nextCount : h.oldCount
    const start = (unstage ? h.next : h.old) - (count ? 1 : 0)
    if (start < cursor || start > input.length) throw stale()
    for (let i = cursor; i < start; i++) output.push(input[i])
    cursor = start
    for (const line of h.lines) {
      const consumes = unstage ? line.type !== '-' : line.type !== '+'
      if (consumes) {
        if (input[cursor] !== line.content) throw stale()
        cursor++
      }
      if (line.type === ' ') output.push(line.content)
      else if (unstage) {
        if (
          (line.type === '+' && !selected.has(line.id)) ||
          (line.type === '-' && selected.has(line.id))
        )
          output.push(line.content)
      } else if (
        (line.type === '-' && !selected.has(line.id)) ||
        (line.type === '+' && selected.has(line.id))
      )
        output.push(line.content)
    }
  }
  for (let i = cursor; i < input.length; i++) output.push(input[i])
  // Never silently concatenate two logical lines at a missing EOF newline.
  if (output.slice(0, -1).some((line) => !line.endsWith('\n')))
    throw Error('该选区会改变结尾换行，请改为整块操作。')
  return output.join('')
}

class PartialStageOperations {
  constructor(git, validators) {
    this.git = git
    this.validators = validators
    this.plans = new Map()
  }
  async supported(repo, file, signal) {
    await this.git.noInProgress(repo, signal)
    if (await this.git.flowFinish.state(repo, signal)) throw Error('请先完成或停止 GitFlow 流程。')
    for (const key of ['core.sparseCheckout', 'core.splitIndex'])
      if (
        (
          await this.git.git(repo, ['config', '--bool', '--get', key], {
            signal,
            allowedCodes: [0, 1],
          })
        ).trim() === 'true'
      )
        throw Error('稀疏或拆分暂存区请使用整文件操作。')
    if ((await this.git.git(repo, ['rev-parse', '--shared-index-path'], { signal })).trim())
      throw Error('拆分暂存区请使用整文件操作。')
    const flags = await this.git.git(repo, ['ls-files', '-v', '-z', '--', file], { signal })
    if (flags.split('\0').some((line) => line && /^[a-zS]/.test(line)))
      throw Error('文件设有忽略索引变化标记，请使用整文件操作。')
    const hook = (
      await this.git.git(repo, ['rev-parse', '--git-path', 'hooks/post-index-change'], { signal })
    ).trim()
    if (await fs.stat(path.resolve(repo, hook)).catch(absent))
      throw Error('仓库配置了索引 Hook，请使用整文件操作。')
    if (
      (
        await this.git.git(repo, ['config', '--get-regexp', '^hook\..*\.event$'], {
          signal,
          allowedCodes: [0, 1],
        })
      )
        .split('\n')
        .some((line) => /\s+post-index-change$/.test(line))
    )
      throw Error('仓库配置了索引 Hook，请使用整文件操作。')
    const location = (
        await this.git.git(repo, ['rev-parse', '--git-path', 'index'], { signal })
      ).trim(),
      indexPath = path.resolve(repo, location)
    const stat = await fs.lstat(indexPath).catch(absent)
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw Error('暂存区文件类型异常，请使用外部 Git 检查。')
    const working = await fs.lstat(path.join(repo, file)).catch(absent)
    if (working && !working.isFile()) throw Error('符号链接、目录或子模块请使用整文件操作。')
    return { indexPath, mode: stat ? stat.mode & 0o777 : 0o666 }
  }
  async capture(repo, file, signal) {
    const attributes = await this.git.git(
      repo,
      ['check-attr', '-z', 'text', 'eol', 'filter', 'working-tree-encoding', 'ident', '--', file],
      { signal },
    )
    const fields = attributes.split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3)
      if (
        ['filter', 'working-tree-encoding', 'ident'].includes(fields[i + 1]) &&
        !['unspecified', 'unset'].includes(fields[i + 2])
      )
        throw Error('LFS、内容过滤器或编码转换文件请使用整文件操作。')
    const config = await this.git.git(
      repo,
      ['config', '--null', '--get-regexp', '^core\\.(autocrlf|eol|safecrlf|attributesfile)$'],
      { signal, allowedCodes: [0, 1] },
    )
    return {
      format: createHash('sha256').update(attributes).update('\0').update(config).digest('hex'),
      index: await this.git.indexFingerprint(repo, signal),
      content: await this.git.selectedCommit.fingerprint(repo, [file], signal),
    }
  }
  async read(repo, request, signal) {
    if (!request || !['staged', 'unstaged'].includes(request.source))
      throw Error('请选择暂存或未暂存差异。')
    const file = this.validators.filePath(request.file)
    if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
      throw Error('缺少仓库上下文，请重新读取。')
    await this.git.checkContext(repo, request, signal)
    await this.supported(repo, file, signal)
    const before = await this.capture(repo, file, signal),
      state = await this.git.status(repo, signal)
    const entries = request.source === 'staged' ? state.staged : state.unstaged,
      entry = entries.find((value) => value.path === file)
    if (!entry) throw Error('此来源已没有修改，请重新选择文件。')
    if (entry.oldPath || entry.status === 'U')
      throw Error('重命名或冲突文件请使用整文件或冲突处理操作。')
    const staged = request.source === 'staged'
    const common = [
      '-c',
      'diff.noprefix=false',
      '-c',
      'diff.mnemonicPrefix=false',
      'diff',
      '--patch',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--unified=3',
      '--inter-hunk-context=0',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-relative',
      '--diff-algorithm=myers',
    ]
    let diff = await this.git.git(repo, [...common, ...(staged ? ['--cached'] : []), '--', file], {
      signal,
    })
    if (!diff && !staged && entry.status === '?')
      diff = await this.git.git(
        repo,
        [...common, '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file],
        { signal, allowedCodes: [0, 1] },
      )
    if (
      diff.length > 300000 ||
      /^(?:old mode|new mode|Binary files|GIT binary patch|Submodule )/m.test(diff) ||
      diff.includes('\0')
    )
      throw Error('二进制、权限变更或较大文件请使用整文件操作。')
    const index = (await this.git.git(repo, ['ls-files', '--stage', '-z', '--', file], { signal }))
      .split('\0')
      .filter(Boolean)
    if (index.length > 1) throw Error('冲突文件请使用冲突处理操作。')
    const info = index[0]?.match(/^(\d{6}) ([a-f0-9]+) 0\t/)
    const mode =
      info?.[1] ||
      /^new file mode (\d{6})$/m.exec(diff)?.[1] ||
      /^deleted file mode (\d{6})$/m.exec(diff)?.[1]
    if (!['100644', '100755'].includes(mode)) throw Error('此文件类型请使用整文件操作。')
    let base = ''
    if (info) {
      if (
        Number((await this.git.git(repo, ['cat-file', '-s', info[2]], { signal })).trim()) >
        16 * 1024 * 1024
      )
        throw Error('较大文件请使用整文件操作。')
      // Batch's object header preserves a leading UTF-8 BOM through the decoder.
      const batch = await this.git.git(repo, ['cat-file', '--batch'], {
        input: info[2] + '\n',
        signal,
      })
      base = batch.slice(batch.indexOf('\n') + 1, -1)
      let lineCount = 0
      for (let i = 0; i < base.length; i++)
        if (base[i] === '\n' && ++lineCount > 200000)
          throw Error('文件行数较多，请使用整文件操作。')
      if (base.includes('\0')) throw Error('二进制文件请使用整文件操作。')
    }
    const hunks = parseDiff(diff)
    selectedContent(
      base,
      hunks,
      hunks.flatMap((h) => h.changed),
      staged,
    )
    await this.git.checkContext(repo, request, signal)
    const after = await this.capture(repo, file, signal)
    if (
      after.index !== before.index ||
      after.content !== before.content ||
      after.format !== before.format
    )
      throw stale()
    for (const [id, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(id)
    while (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value)
    const plan = {
      id: randomUUID(),
      repo,
      file,
      source: request.source,
      expectedHead: request.expectedHead,
      expectedBranch: request.expectedBranch,
      ...before,
      base,
      diff,
      hunks,
      mode,
      newFile: /^new file mode /m.test(diff),
      deletedFile: /^deleted file mode /m.test(diff),
      expires: Date.now() + 300000,
    }
    this.plans.set(plan.id, plan)
    return {
      id: plan.id,
      file,
      source: plan.source,
      diff,
      hunks: hunks.map((h) => ({ id: h.id, lines: h.changed, hunkOnly: h.hunkOnly })),
    }
  }
  async execute(repo, request, signal) {
    const plan = this.plans.get(request.planId)
    this.plans.delete(request.planId)
    if (!plan || plan.repo !== repo || plan.expires < Date.now())
      throw Error('局部操作预览已过期，请重新读取。')
    if (!Array.isArray(request.lines) || request.lines.length > 100000)
      throw Error('请选择有效的修改行。')
    if (
      request.expectedHead !== plan.expectedHead ||
      request.expectedBranch !== plan.expectedBranch
    )
      throw stale()
    const unstage = plan.source === 'staged',
      content = selectedContent(plan.base, plan.hunks, request.lines, unstage)
    const { indexPath, mode } = await this.supported(repo, plan.file, signal)
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-partial-stage-'))
    const hooksPath = path.join(temporary, 'empty-hooks'),
      nextIndex = path.join(temporary, 'index')
    await fs.mkdir(hooksPath)
    let lock, lockIdentity
    try {
      const zero = '0'.repeat(
        plan.expectedHead.length ||
          (await this.git.git(repo, ['hash-object', '--stdin'], { signal, input: '' })).trim()
            .length,
      )
      await this.git.git(repo, ['update-ref', '--stdin'], {
        signal,
        hooksPath,
        input: `start\nverify HEAD ${plan.expectedHead || zero}\nprepare\n`,
        onPrepared: async (signal) => {
          await this.git.checkContext(repo, plan, signal)
          lock = await fs.open(indexPath + '.lock', 'wx', mode).catch((error) => {
            if (error.code === 'EEXIST')
              throw Error('暂存区正被其他 Git 操作使用，请稍后重新读取。')
            throw error
          })
          lockIdentity = await lock.stat()
          const original = await this.capture(repo, plan.file, signal)
          if (
            original.index !== plan.index ||
            original.content !== plan.content ||
            original.format !== plan.format
          )
            throw stale()
          const bytes = await fs.readFile(indexPath).catch(absent)
          const options = { indexFile: nextIndex, hooksPath, signal }
          if (bytes) await fs.writeFile(nextIndex, bytes)
          else await this.git.git(repo, ['read-tree', '--empty'], options)
          const remove =
            content === '' && ((unstage && plan.newFile) || (!unstage && plan.deletedFile))
          const oid = remove
            ? zero
            : (
                await this.git.git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], {
                  signal,
                  input: content,
                })
              ).trim()
          await this.git.git(repo, ['update-index', '-z', '--index-info'], {
            ...options,
            input: `${remove ? '0' : plan.mode} ${oid}\t${plan.file}\0`,
          })
          await this.git.checkContext(repo, plan, signal)
          const final = await this.capture(repo, plan.file, signal)
          if (
            final.index !== plan.index ||
            final.content !== plan.content ||
            final.format !== plan.format
          )
            throw stale()
          const held = await lock.stat(),
            actual = await fs.lstat(indexPath + '.lock')
          if (
            !actual.isFile() ||
            actual.isSymbolicLink() ||
            held.ino !== actual.ino ||
            held.dev !== actual.dev
          )
            throw Error('暂存区锁已变化，未覆盖索引。')
          if (signal?.aborted) throw Error('操作已取消，请核对暂存区。')
          await lock.writeFile(await fs.readFile(nextIndex))
          await lock.sync()
          await lock.close()
          if (signal?.aborted) throw Error('操作已取消，请核对暂存区。')
          await fs.rename(indexPath + '.lock', indexPath)
          lock = null
        },
      })
      return {
        outcome: 'succeeded',
        output: unstage ? '所选修改已取消暂存，工作文件保留。' : '所选修改已暂存，工作文件保留。',
      }
    } finally {
      if (lock) {
        const held = lockIdentity,
          actual = await fs.lstat(indexPath + '.lock').catch(absent)
        await lock.close().catch(() => {})
        if (
          held &&
          actual?.isFile() &&
          !actual.isSymbolicLink() &&
          held.ino === actual.ino &&
          held.dev === actual.dev
        )
          await fs.unlink(indexPath + '.lock').catch(() => {})
      }
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
module.exports = { PartialStageOperations, parseDiff, selectedContent }
