'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const TRUST_READ = Symbol('repository-trust-inspection')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const required = () => Error('请先确认信任此仓库，再读取工作区或执行 Git 操作。')
const storageQueues = new Map()
const fingerprint = /^[a-f0-9]{64}$/
// Ignore only routine metadata written by our own branch/GitFlow operations.
// Unknown configuration is included, so new Git execution settings fail closed.
const benign =
  /^(?:branch\..*\.(?:remote|merge|pushremote|description)$|gitflow\.|user\.(?:name|email)$)/i
function metadataPath(root, value) {
  // Do not probe a share named by an untrusted .git/commondir file before
  // consent: even filesystem reads may authenticate to a UNC server.
  if (/^(?:\\\\|\/\/)/.test(value))
    throw Error('仓库元数据指向网络路径；请先在本机核对该工作副本。')
  return path.resolve(root, value)
}
async function small(file, optional = false) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('仓库元数据文件过大或格式无效。')
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (optional && error.code === 'ENOENT') return ''
    throw error
  }
}
class RepositoryTrust {
  constructor(git, { directory } = {}) {
    this.git = git
    this.file = directory ? path.join(directory, 'repository-trust.json') : null
    this.grants = new Map()
    this.challenges = new Map()
  }
  async readSaved() {
    if (!this.file) return new Map()
    try {
      const stat = await fs.stat(this.file)
      if (!stat.isFile() || stat.size > 1024 * 1024) return new Map()
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (data?.version !== 1 || !Array.isArray(data.grants)) return new Map()
      return new Map(
        data.grants
          .slice(-5000)
          .filter(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              fingerprint.test(entry[0]) &&
              typeof entry[1]?.configuration === 'string' &&
              fingerprint.test(entry[1].configuration),
          )
          .map(([key, value]) => [key, { configuration: value.configuration }]),
      )
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return new Map()
      throw Error('无法读取仓库信任记录，请检查应用数据目录的访问权限。')
    }
  }
  async grant(key) {
    if (!this.file) return this.grants.get(key)
    await storageQueues.get(this.file)
    // Separate browser sessions share the same user profile. Re-read the
    // registry so approvals and invalidations are visible across services.
    return (await this.readSaved()).get(key)
  }
  async persist(key, value) {
    if (!this.file) return
    const previous = storageQueues.get(this.file) || Promise.resolve()
    const write = previous.then(async () => {
      const grants = await this.readSaved()
      grants.delete(key)
      if (value) grants.set(key, value)
      const data = JSON.stringify({ version: 1, grants: [...grants].slice(-5000) }) + '\n'
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, this.file)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
      }
    })
    const settled = write.catch(() => {})
    storageQueues.set(this.file, settled)
    try {
      await write
    } catch {
      throw Error('无法保存仓库信任记录，请检查应用数据目录的访问权限后重试。')
    } finally {
      if (storageQueues.get(this.file) === settled) storageQueues.delete(this.file)
    }
  }
  async identity(value) {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.includes('\0') ||
      value.length > 32768
    )
      throw Error('无效的仓库路径。')
    let root = await fs.realpath(value)
    if (!(await fs.stat(root)).isDirectory()) throw Error('请选择仓库目录。')
    while (true) {
      const marker = path.join(root, '.git')
      const stat = await fs.lstat(marker).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (stat) {
        if (stat.isSymbolicLink()) throw Error('仓库 .git 是符号链接；请打开实际仓库目录。')
        let gitDir = marker
        if (stat.isFile()) {
          const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await small(marker))
          if (!match) throw Error('仓库 .git 文件格式无效。')
          gitDir = metadataPath(root, match[1])
        } else if (!stat.isDirectory()) throw Error('仓库 .git 格式无效。')
        if ((await fs.lstat(gitDir)).isSymbolicLink())
          throw Error('Git 元数据目录是符号链接，请先在本机核对。')
        gitDir = await fs.realpath(gitDir)
        const common = (await small(path.join(gitDir, 'commondir'), true)).trim()
        const commonDir = await fs.realpath(common ? metadataPath(gitDir, common) : gitDir)
        const identities = await Promise.all(
          [root, gitDir, commonDir].map(async (p) => {
            const s = await fs.stat(p)
            if (!s.isDirectory()) throw Error('仓库元数据目录无效。')
            return [p, String(s.dev), String(s.ino)]
          }),
        )
        const key = digest(JSON.stringify(identities))
        const stamp = digest(
          JSON.stringify(
            await Promise.all(
              [path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')].map((p) =>
                small(p, true),
              ),
            ),
          ),
        )
        return { path: root, gitDir, commonDir, key, stamp }
      }
      const parent = path.dirname(root)
      if (parent === root) throw Error('未找到带工作区的 Git 仓库。')
      root = parent
    }
  }
  async configurationRecords(info, signal) {
    // Only reached after explicit or recorded consent. `git config` reads effective includes,
    // but does not run filters, hooks, credential helpers or external diff tools.
    const raw = await this.git.git(
      info.path,
      ['config', '--includes', '--null', '--show-origin', '--list'],
      // This private capability is issued only after a validated challenge or
      // a recorded grant. It authorizes inspection of this canonical root.
      { signal, [TRUST_READ]: info.path },
    )
    const fields = raw.split('\0'),
      selected = []
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const record = fields[i + 1],
        newline = record.indexOf('\n')
      const key = newline < 0 ? record : record.slice(0, newline)
      // Our process-local ownership exception is derived from existing consent,
      // not user configuration. Excluding it preserves pre-existing grants.
      if (fields[i] === 'command line:' && key === 'safe.directory') continue
      if (!benign.test(key)) selected.push([fields[i], record])
    }
    return selected
  }
  async configuration(info, signal) {
    return digest(JSON.stringify(await this.configurationRecords(info, signal)))
  }
  // Internal to the explicit fetch-scope action. Do not make remote.*.fetch
  // globally benign: an external change could map a fetch into local branches.
  async approvedFetchChange(value, remote, mappings, signal) {
    const info = await this.assert(value, signal)
    const key = `remote.${remote}.fetch`
    for (const mapping of mappings) {
      const [source, destination, extra] = mapping.replace(/^\+/, '').split(':')
      if (
        extra !== undefined ||
        !source.startsWith('refs/heads/') ||
        destination !== `refs/remotes/${remote}/${source.slice('refs/heads/'.length)}`
      )
        throw Error('不允许的获取信任变更。')
    }
    const local = path.join(info.commonDir, 'config')
    const target = ([origin, record]) => {
      const end = record.indexOf('\n')
      return (
        origin.startsWith('file:') &&
        path.resolve(info.path, origin.slice(5)) === local &&
        record.slice(0, end) === key
      )
    }
    const previous = await this.configurationRecords(info, signal)
    if (!previous.some(target)) throw Error('获取规则不属于当前仓库配置，未调整信任记录。')
    const remaining = previous.filter((record) => !target(record))
    let consumed = false
    return async () => {
      if (consumed) throw Error('获取配置确认已失效。')
      consumed = true
      // The config has committed. Cancellation must not interrupt its verification.
      const recovery = AbortSignal.timeout(20000)
      const after = await this.identity(value)
      const records = await this.configurationRecords(after, recovery)
      const values = records
        .filter(target)
        .map(([, record]) => record.slice(record.indexOf('\n') + 1))
      if (
        after.key !== info.key ||
        JSON.stringify(records.filter((record) => !target(record))) !== JSON.stringify(remaining) ||
        JSON.stringify(values) !== JSON.stringify(mappings)
      )
        throw Error('除已确认的获取范围外，其他仓库配置也发生变化，请重新确认信任。')
      const stable = await this.identity(value)
      if (stable.key !== after.key || stable.stamp !== after.stamp)
        throw Error('仓库配置再次变化，请重新确认信任。')
      const grant = { configuration: digest(JSON.stringify(records)) }
      await this.persist(after.key, grant)
      this.grants.set(after.key, grant)
    }
  }
  async inspect(value, signal) {
    const info = await this.identity(value)
    let trusted = false
    if (await this.grant(info.key)) {
      try {
        await this.assert(value, signal)
        trusted = true
      } catch (error) {
        if (await this.grant(info.key)) throw error
      }
    }
    if (trusted) return { path: info.path, gitDir: info.gitDir, trusted: true, token: '' }
    const token = randomUUID()
    if (this.challenges.size >= 16) this.challenges.delete(this.challenges.keys().next().value)
    this.challenges.set(token, { ...info, expires: Date.now() + 300000 })
    return { path: info.path, gitDir: info.gitDir, trusted: false, token }
  }
  async approve(value, token, signal) {
    const challenge = this.challenges.get(token)
    this.challenges.delete(token)
    const info = await this.identity(value)
    if (
      !challenge ||
      challenge.expires < Date.now() ||
      challenge.key !== info.key ||
      challenge.stamp !== info.stamp
    )
      throw Error('仓库位置或配置已变化，请重新打开并确认。')
    const configuration = await this.configuration(info, signal)
    const after = await this.identity(value)
    if (after.key !== info.key || after.stamp !== info.stamp)
      throw Error('仓库配置已变化，请重新确认。')
    // Do not report success until the approval has reached persistent storage.
    await this.persist(info.key, { configuration })
    this.grants.set(info.key, { configuration })
    return { path: info.path }
  }
  async assert(value, signal) {
    const info = await this.identity(value),
      grant = await this.grant(info.key)
    if (!grant) throw required()
    if (grant.configuration !== (await this.configuration(info, signal))) {
      this.grants.delete(info.key)
      await this.persist(info.key, null)
      throw Error('仓库的执行相关配置已变化，请重新打开仓库并确认信任。')
    }
    return info
  }
}
module.exports = { RepositoryTrust, TRUST_READ }
