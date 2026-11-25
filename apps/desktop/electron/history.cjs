'use strict'
const { randomUUID, createHash } = require('node:crypto')
const PAGE_SIZE = 250
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function decorate(commits, branches, head) {
  return commits.map((commit) => ({
    ...commit,
    parents: [...commit.parents],
    refs: branches
      .filter((b) => b.commitHash === commit.hash || (!b.commitHash && b.hash === commit.hash))
      .map((b) =>
        b.kind === 'tag'
          ? `tag: ${b.name}`
          : b.current && commit.hash === head
            ? `HEAD -> ${b.name}`
            : b.name,
      ),
  }))
}
class HistoryOperations {
  constructor(git) {
    this.git = git
    this.frames = new Map()
    this.metadataCache = new Map()
    this.metadataBasis = new Map()
  }
  async metadata(repo, sha, signal) {
    if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))
      throw Error('无效的提交对象 ID。')
    sha = sha.toLowerCase()
    const key = `${repo}\0${this.metadataBasis.get(repo) || ''}\0${sha}`
    if (this.metadataCache.has(key)) return { ...this.metadataCache.get(key) }
    const raw = await this.git.git(
      repo,
      ['show', '-s', '--no-show-signature', '--format=%H%x00%s%x00%an%x00%aI', sha, '--'],
      { signal },
    )
    const [hash, subject, author, date] = raw.trimEnd().split('\0')
    if (!hash || hash.toLowerCase() !== sha.toLowerCase() || date === undefined)
      throw Error('提交信息不可读取。')
    const result = { hash, subject, author, date }
    if (this.metadataCache.size >= 512)
      this.metadataCache.delete(this.metadataCache.keys().next().value)
    this.metadataCache.set(key, result)
    return { ...result }
  }
  async frame(repo, tips, branches, head, signal, basis = '', focus = '', graphVersion = '') {
    const signature = hash([tips, focus, graphVersion])
    let frame = [...this.frames.values()].find(
      (f) => f.repo === repo && f.signature === signature && f.basis === basis,
    )
    if (!frame) {
      const total = tips.length
        ? Number(
            (
              await this.git.git(repo, ['rev-list', '--count', '--stdin'], {
                signal,
                input: tips.join('\n') + '\n',
              })
            ).trim(),
          )
        : 0
      if (!Number.isSafeInteger(total) || total < 0) throw Error('提交数量无效。')
      frame = {
        token: randomUUID(),
        repo,
        tips,
        signature,
        basis,
        focus,
        total,
        graphVersion,
        pages: new Map(),
      }
      if (this.frames.size >= 32) this.frames.delete(this.frames.keys().next().value)
      this.frames.set(frame.token, frame)
    }
    Object.assign(frame, { branches, head, touched: Date.now() })
    return frame
  }
  async initial(repo, branches, head, signal, graphVersion = '') {
    if (this.metadataBasis.size >= 32 && !this.metadataBasis.has(repo))
      this.metadataBasis.delete(this.metadataBasis.keys().next().value)
    this.metadataBasis.set(repo, graphVersion)
    // Resolve only the IDs captured by this snapshot. Never walk moving live
    // refs for subsequent pages; annotated tags peel recursively, blob tags do
    // not become graph roots, and notes/recovery/prefetch refs stay excluded.
    const ids = [...new Set([...branches.map((b) => b.hash), ...(head ? [head] : [])])]
    const raw = ids.length
      ? await this.git.git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
          signal,
          input: ids.map((id) => `${id}^{}`).join('\n') + '\n',
        })
      : ''
    if (/ missing$/m.test(raw)) throw Error('历史引用对象已变化或不可读取，请刷新仓库。')
    const tips = [
      ...new Set(
        raw
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.endsWith(' commit'))
          .map((line) => line.split(' ')[0]),
      ),
    ].sort()
    const frame = await this.frame(repo, tips, branches, head, signal, '', '', graphVersion)
    return { ...(await this.page(frame, 0, signal)), total: frame.total }
  }
  async page(frame, offset, signal) {
    let commits = frame.graphVersion ? frame.pages.get(offset) : null
    const cached = !!commits
    commits ||= []
    if (!cached && frame.tips.length) {
      const fields = (
        await this.git.git(
          frame.repo,
          [
            'log',
            '--date-order',
            `--skip=${offset}`,
            `--max-count=${PAGE_SIZE}`,
            '-z',
            '--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI',
            '--stdin',
          ],
          { signal, input: frame.tips.join('\n') + '\n' },
        )
      ).split('\0')
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
    }
    const nextOffset = offset + commits.length
    if (nextOffset < frame.total && !commits.length)
      throw Error('历史提交不可读取，请刷新仓库后重试。')
    if (!cached && frame.graphVersion) {
      if (frame.pages.size >= 4) frame.pages.delete(frame.pages.keys().next().value)
      frame.pages.set(offset, commits)
    }
    return {
      commits: decorate(commits, frame.branches, frame.head),
      history: {
        token: frame.token,
        signature: frame.signature,
        basis: frame.basis || frame.signature,
        focus: frame.focus || null,
        nextOffset: nextOffset < frame.total ? nextOffset : null,
        total: frame.total,
      },
    }
  }
  async read(repo, request, signal) {
    if (!request || typeof request.token !== 'string') throw Error('无效的历史读取请求。')
    let frame = this.frames.get(request.token)
    if (!frame || frame.repo !== repo || Date.now() - frame.touched > 30 * 60 * 1000)
      throw Error('历史读取已过期，请刷新仓库后重试。')
    frame.touched = Date.now()
    if (
      frame.graphVersion &&
      frame.graphVersion !== (await this.git.historyGraphBasis(repo, signal))
    )
      throw Error('历史结构已变化，请刷新仓库后重试。')
    if (request.sha !== undefined) {
      if (typeof request.sha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(request.sha))
        throw Error('请输入 7 至 64 位十六进制提交 SHA。')
      const oid = (
        await this.git.git(
          repo,
          ['rev-parse', '--verify', '--end-of-options', `${request.sha}^{commit}`],
          { signal },
        )
      ).trim()
      let reachable = false
      const searchTips = frame.lookupTips || frame.tips
      for (const tip of searchTips) {
        const result = await this.git.git(repo, ['merge-base', '--is-ancestor', oid, tip], {
          signal,
          allowedCodes: [0, 1],
          returnCode: true,
        })
        if (result.code === 0) {
          reachable = true
          break
        }
      }
      if (!reachable) throw Error('该提交不在当前历史范围内，请返回全部历史或刷新仓库后重试。')
      frame = await this.frame(
        repo,
        [oid],
        frame.branches,
        frame.head,
        signal,
        frame.basis || frame.signature,
        oid,
        frame.graphVersion,
      )
      frame.lookupTips = searchTips
      return this.page(frame, 0, signal)
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > frame.total)
      throw Error('无效的历史分页位置。')
    return this.page(frame, request.offset, signal)
  }
}
module.exports = { HistoryOperations, PAGE_SIZE }
