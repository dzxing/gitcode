'use strict'
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const digest = (v) => createHash('sha256').update(v).digest('hex')
const oid = (v) => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)
const limit = 100
class HistoryTools {
  constructor(git, filePath) {
    this.git = git
    this.filePath = filePath
    this.queries = new Map()
  }
  request(repo, request) {
    const scope = request?.scope
    if (scope !== undefined && (typeof scope !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(scope)))
      return Promise.reject(Error('无效的读取标识。'))
    const key = scope ? `${repo}\0${scope}` : ''
    if (key && ['query', 'cancel'].includes(request.kind)) this.queries.get(key)?.abort()
    if (request?.kind === 'cancel') return Promise.resolve({})
    const controller = new AbortController()
    if (key && request?.kind === 'query') this.queries.set(key, controller)
    return this.git
      .job(
        async (signal) => {
          if (controller.signal.aborted) throw Error('历史查询已取消。')
          const combined = AbortSignal.any([signal, controller.signal])
          return this.read(await this.git.repository(repo, combined), request, combined)
        },
        { background: true, preemptible: true },
      )
      .finally(() => {
        if (key && this.queries.get(key) === controller) this.queries.delete(key)
      })
  }
  async read(repo, request, signal) {
    if (!request || !['file', 'diff', 'three', 'query'].includes(request.kind))
      throw Error('无效的历史工具请求。')
    if (request.kind === 'query') return this.query(repo, request, signal)
    this.filePath(request.path)
    if (request.kind === 'three') return this.three(repo, request.path, signal)
    if (request.kind === 'file' && request.revision === '') return { commits: [], nextOffset: null }
    if (!oid(request.revision)) throw Error('无效的历史起点。')
    if (request.kind === 'diff' && request.local) {
      const original = await this.blobAt(
        repo,
        request.revision,
        request.oldPath ? this.filePath(request.oldPath) : request.path,
        signal,
      )
      const absolute = await this.git.merge.safePath(repo, request.path)
      const stat = await fs.stat(absolute).catch((e) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      if (original.binary || (stat && stat.size > 256 * 1024))
        throw Error('此文件类型或大小不支持文本比较。')
      const buffer = stat ? await fs.readFile(absolute, { signal }) : Buffer.alloc(0)
      if (buffer.includes(0)) throw Error('二进制文件不支持文本比较。')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-file-history-'))
      try {
        const before = path.join(directory, 'before'),
          after = path.join(directory, 'after')
        await fs.writeFile(before, original.text || '')
        await fs.writeFile(after, text)
        const diff = await this.git.git(
          repo,
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--',
            before,
            after,
          ],
          { signal, allowedCodes: [0, 1] },
        )
        const beforeLabel = JSON.stringify(`a/${request.oldPath || request.path}`)
        const afterLabel = JSON.stringify(`b/${request.path}`)
        let insideHunk = false
        return {
          diff: diff
            .split('\n')
            .map((line) => {
              if (line.startsWith('@@')) insideHunk = true
              if (insideHunk) return line
              if (line.startsWith('diff --git ')) return `diff --git ${beforeLabel} ${afterLabel}`
              if (line.startsWith('--- ')) return `--- ${beforeLabel}`
              if (line.startsWith('+++ ')) return `+++ ${afterLabel}`
              return line
            })
            .join('\n'),
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
    if (request.kind === 'diff') {
      if (request.base && !oid(request.base)) throw Error('无效的比较版本。')
      const args = request.local
        ? ['diff', request.revision]
        : request.base
          ? ['diff', request.base, request.revision]
          : ['show', '--format=', '--root', request.revision]
      const diff = await this.git.git(
        repo,
        [
          ...args,
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--find-renames',
          '--',
          request.path,
          ...(request.oldPath ? [this.filePath(request.oldPath)] : []),
        ],
        { signal },
      )
      return {
        diff: diff.length > 300000 ? diff.slice(0, 300000) + '\n…差异过大，预览已截断。' : diff,
      }
    }
    const offset = this.offset(request.offset)
    // Name-status records preserve the path at each historical revision. Git
    // follows one file only; never use the current path for an older rename.
    const raw = await this.git.git(
      repo,
      [
        'log',
        `--skip=${offset}`,
        `--max-count=${limit + 1}`,
        '--follow',
        '--find-renames',
        '--name-status',
        '-z',
        '--format=%x00HISTORY_RECORD%x00%H%x00%P%x00%s%x00%an%x00%ae%x00%aI',
        request.revision,
        '--',
        request.path,
      ],
      { signal },
    )
    const records = raw.split('\0HISTORY_RECORD\0').slice(1)
    let historicalPath = request.path
    const commits = []
    for (const record of records) {
      const fields = record.split('\0')
      const [hash, parents, subject, author, email, date] = fields
      const status = fields[6]?.trim()
      const oldPath = status?.startsWith('R') ? fields[7] : undefined
      const path = status?.startsWith('R') ? fields[8] : fields[7] || historicalPath
      commits.push({
        hash,
        parents: parents.split(' ').filter(Boolean),
        subject,
        author,
        email,
        date,
        refs: [],
        path,
        oldPath,
      })
      historicalPath = oldPath || path
    }
    return {
      commits: commits.slice(0, limit),
      nextOffset: commits.length > limit ? offset + limit : null,
    }
  }
  offset(value = 0) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10000000)
      throw Error('无效的分页位置。')
    return value
  }
  async query(repo, request, signal) {
    const frame = this.git.history.frames.get(request.token)
    if (!frame || frame.repo !== repo || Date.now() - frame.touched > 1800000)
      throw Error('历史读取已过期，请刷新仓库。')
    if (
      frame.graphVersion &&
      frame.graphVersion !== (await this.git.historyGraphBasis(repo, signal))
    )
      throw Error('历史结构已变化，请刷新仓库。')
    const text = (value) => {
      if (value === undefined || value === '') return ''
      if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value))
        throw Error('无效的筛选条件。')
      return value
    }
    const offset = this.offset(request.offset)
    let tips = frame.lookupTips || frame.tips
    if (request.branch) {
      const branch = frame.branches.find(
        (b) =>
          (b.kind === 'local'
            ? 'refs/heads/'
            : b.kind === 'remote'
              ? 'refs/remotes/'
              : 'refs/tags/') +
            b.name ===
          request.branch,
      )
      if (!branch) throw Error('筛选分支已不存在。')
      tips = [branch.commitHash || branch.hash]
      if (!oid(tips[0])) throw Error('此引用不是提交。')
    }
    const args = [
      'log',
      '--date-order',
      '--no-show-signature',
      '--no-color',
      '--fixed-strings',
      '--regexp-ignore-case',
      '--all-match',
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
      '-z',
      '--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI',
    ]
    const query = text(request.query),
      author = text(request.author)
    if (query) args.push(`--grep=${query}`)
    if (author) args.push(`--author=${author}`)
    for (const [key, flag] of [
      ['since', '--since'],
      ['until', '--until'],
    ])
      if (request[key]) {
        if (typeof request[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request[key]))
          throw Error('无效的日期。')
        args.push(`${flag}=${request[key]}T${key === 'since' ? '00:00:00' : '23:59:59'}`)
      }
    if (request.since && request.until && request.since > request.until)
      throw Error('开始日期不能晚于结束日期。')
    const path = text(request.path)
    if (path) this.filePath(path.replace(/\/$/, ''))
    if (!tips.length) return { commits: [], nextOffset: null }
    // full-history prevents path filtering from rewriting real parent IDs.
    if (path) args.push('--full-history')
    const fields = (
      await this.git.git(repo, [...args, '--stdin', '--', ...(path ? [path] : [])], {
        signal,
        input: tips.join('\n') + '\n',
      })
    ).split('\0')
    const commits = []
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const [hash, parents, subject, author, email, date] = fields.slice(i, i + 6)
      commits.push({
        hash,
        parents: parents.split(' ').filter(Boolean),
        subject,
        author,
        email,
        date,
        refs: [],
      })
    }
    return {
      commits: commits.slice(0, limit),
      nextOffset: commits.length > limit ? offset + limit : null,
    }
  }
  async blobAt(repo, revision, file, signal) {
    if (!revision) return { exists: false, text: '', binary: false }
    const raw = await this.git.git(repo, ['ls-tree', '-z', revision, '--', file], { signal })
    const entry = raw.split('\0').find((r) => r.slice(r.indexOf('\t') + 1) === file)
    if (!entry) return { exists: false, text: '', binary: false }
    const [mode, type, id] = entry.split('\t')[0].split(' ')
    if (type !== 'blob') return { exists: true, text: null, binary: true }
    return this.git.merge.blob(repo, { mode, oid: id }, signal)
  }
  async three(repo, file, signal) {
    const read = async () => {
      const head = await this.git.head(repo, signal)
      const stages = (
        await this.git.git(repo, ['ls-files', '--stage', '-z', '--', file], { signal })
      )
        .split('\0')
        .filter(Boolean)
      if (stages.some((r) => !r.split('\t')[0].endsWith(' 0')))
        throw Error('此文件存在冲突，请使用冲突编辑器。')
      const absolute = await this.git.merge.safePath(repo, file)
      const stat = await fs.stat(absolute).catch((e) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      const buffer = stat && stat.size <= 2 * 1024 * 1024 ? await fs.readFile(absolute) : null
      const working = !stat
        ? { exists: false, text: '', binary: false }
        : { exists: true, text: null, binary: true }
      if (buffer && !buffer.includes(0)) {
        try {
          working.text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
          working.binary = false
        } catch {
          /* unsupported encoding */
        }
      }
      const index = stages[0]?.split('\t')[0].split(' ')
      return {
        head,
        index,
        working,
        signature: digest(
          JSON.stringify([
            head,
            stages,
            buffer ? digest(buffer) : stat && [stat.size, stat.mtimeMs],
          ]),
        ),
      }
    }
    const state = await read()
    const versions = [
      await this.blobAt(repo, state.head, file, signal),
      state.index
        ? await this.git.merge.blob(repo, { mode: state.index[0], oid: state.index[1] }, signal)
        : { exists: false, text: '', binary: false },
      state.working,
    ]
    if ((await read()).signature !== state.signature)
      throw Error('文件或暂存区已变化，请重新读取。')
    for (const version of versions)
      if (
        version.text &&
        (version.text.length > 256 * 1024 || version.text.split('\n').length > 10000)
      ) {
        version.text = null
        version.binary = true
      }
    return { versions, signature: state.signature }
  }
}
module.exports = { HistoryTools }
