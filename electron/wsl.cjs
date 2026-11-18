'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createHash } = require('node:crypto')
const {
  ROOT,
  parseWslPath,
  isWslRoot,
  toUnc,
  mapResult,
  validDistribution,
} = require('./wsl-path.cjs')
const { RepositoryTrust } = require('./repository-trust.cjs')
const probe = promisify(execFile)
const repositoryMethods = new Set([
  'git-console',
  'repository-trust',
  'repository-trust-approve',
  'partial-stage-read',
  'recovery-read',
  'repository-changes',
  'background-snapshot',
  'auto-fetch',
  'fetch-status',
  'gitflow-plan',
  'selected-commit-plan',
  'fetch-settings-read',
  'sync-plan',
  'rebase-menu-read',
  'navigation-read',
  'commit-operation-read',
  'merge-read',
  'stash-read',
  'history-metadata',
  'history-tools',
  'history-read',
  'snapshot',
  'refresh-references',
  'commit',
  'diff',
  'action',
])
const backgroundMethods = new Set([
  'git-console',
  'repository-changes',
  'background-snapshot',
  'history-metadata',
  'history-read',
  'history-tools',
  'rebase-menu-read',
  'fetch-status',
  'directory',
])
const controlTimeouts = new Map([
  ['git-console', 10000],
  ['runtime', 30000],
  ['runtime-refresh', 30000],
  ['journal-bootstrap', 30000],
  ['activity-settings', 10000],
  ['cancel', 5000],
  ['cancel-auto-fetch', 5000],
  ['shutdown', 10000],
])

function decode(value) {
  return (value.includes(0) ? value.toString('utf16le') : value.toString('utf8')).replace(
    /^\uFEFF/,
    '',
  )
}
class WslClient {
  constructor(child, { timeout = 600000, trustStore, onJournal } = {}) {
    this.child = child
    this.timeout = timeout
    this.next = 0
    this.pending = new Map()
    this.activity = null
    this.closed = false
    this.exited = false
    this.exitPromise = new Promise((resolve) =>
      child.once('close', () => {
        this.exited = true
        resolve()
      }),
    )
    this.closePromise = null
    let buffer = '',
      stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data) => {
      buffer += data
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
        this.fail(Error('WSL 核心输出过大，请刷新检查仓库状态。'))
        child.stdin.destroy()
        return
      }
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const message = JSON.parse(line)
          if (message.event === 'trust-store') {
            const respond = (value) => {
              if (!child.stdin.destroyed)
                child.stdin.write(
                  JSON.stringify({ storageReply: true, id: message.id, ...value }) + '\n',
                )
            }
            void Promise.resolve()
              .then(async () => {
                if (!trustStore || !/^[a-f0-9]{64}$/.test(message.key))
                  throw Error('无效的信任记录请求。')
                if (message.method === 'grant') return trustStore.grant(message.key)
                if (
                  message.method !== 'persist' ||
                  (message.value != null && !/^[a-f0-9]{64}$/.test(message.value?.configuration))
                )
                  throw Error('无效的信任记录请求。')
                await trustStore.persist(message.key, message.value)
                return null
              })
              .then(
                (result) => respond({ result: result ?? null }),
                (error) => respond({ error: error.message }),
              )
            continue
          }
          if (message.event === 'journal') {
            onJournal?.(message)
            continue
          }
          if (message.event === 'activity') {
            this.activity = message.value
            continue
          }
          const request = this.pending.get(message.id)
          if (!request) continue
          this.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error)
            request.reject(Object.assign(Error(message.error), { code: message.code }))
          else request.resolve(message.result)
        } catch {
          this.fail(Error('WSL 核心通信中断，请刷新确认操作结果，勿重复执行。'))
          child.stdin.destroy()
          return
        }
      }
    })
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString('utf8')).slice(-4000)
    })
    child.stdin.on('error', () => this.fail(Error('WSL 核心连接已关闭，请重新打开仓库。')))
    child.once('error', () => this.fail(Error('无法启动 WSL 核心，请检查 WSL 安装及发行版状态。')))
    child.once('close', () =>
      this.fail(
        Error(`WSL 核心已退出，请刷新确认操作结果，勿重复执行。${stderr ? '\n' + stderr : ''}`),
      ),
    )
  }
  fail(error) {
    this.closed = true
    this.activity = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
  request(method, args = []) {
    if (this.closed) return Promise.reject(Error('WSL 核心连接已关闭，请重新打开仓库。'))
    if (this.pending.size >= 128) return Promise.reject(Error('WSL 请求过多，请稍后重试。'))
    const id = ++this.next
    const frame = JSON.stringify({ id, method, args }) + '\n'
    if (Buffer.byteLength(frame) > 8 * 1024 * 1024) return Promise.reject(Error('WSL 请求过大。'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.fail(Error('等待 WSL 核心超时，请重新打开仓库核对状态，勿重复执行。'))
          this.child.stdin.destroy()
        },
        Math.min(this.timeout, controlTimeouts.get(method) || this.timeout),
      )
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(frame)
    })
  }
  close() {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      try {
        if (!this.closed) await this.request('shutdown')
      } finally {
        if (!this.child.stdin.destroyed) this.child.stdin.end()
        if (!this.exited) {
          let timer
          try {
            await Promise.race([
              this.exitPromise,
              new Promise((resolve) => {
                timer = setTimeout(() => {
                  // Kill only our relay, never terminate the user's distribution.
                  try {
                    this.child.kill()
                  } catch {}
                  resolve()
                }, 3000)
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
        }
      }
    })()
    return this.closePromise
  }
}

class WslManager {
  constructor(git, options = {}) {
    this.git = git
    this.options = options
    this.wslExe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')
    this.clients = new Map()
    this.connected = new Map()
    this.generation = 0
    this.closing = false
    this.probeController = new AbortController()
    this.startingClients = new Set()
    this.runProbe =
      options.wslProbe ||
      ((args) =>
        probe(this.wslExe, args, {
          encoding: 'buffer',
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          cwd: process.env.SystemRoot || 'C:\\Windows',
          signal: this.probeController.signal,
        }))
    this.spawnWorker =
      options.wslSpawn ||
      ((args) =>
        spawn(this.wslExe, args, {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: process.env.SystemRoot || 'C:\\Windows',
        }))
  }
  isRepository(value) {
    return !!parseWslPath(value)
  }
  async distributions() {
    try {
      const result = await this.runProbe(['--list', '--quiet'])
      return [
        ...new Set(
          decode(result.stdout)
            .split(/[\r\n]+/)
            .map((name) => name.trim())
            .filter(validDistribution),
        ),
      ]
    } catch {
      throw Error('无法读取 WSL 发行版，请确认已安装 WSL，并在终端执行 wsl --list --quiet 检查。')
    }
  }
  async hostPath(distribution, value) {
    const parsed = parseWslPath(value)
    if (parsed) {
      if (parsed.distribution.toLowerCase() !== distribution.toLowerCase())
        throw Error('不能跨 WSL 发行版访问应用文件。')
      return parsed.linuxPath
    }
    if (!/^[a-z]:[\\/]/i.test(value)) throw Error('WSL 核心文件必须位于 Windows 本地磁盘。')
    const result = await this.runProbe([
      '--distribution',
      distribution,
      '--cd',
      '/',
      '--exec',
      'wslpath',
      '-u',
      value,
    ])
    const linuxPath = decode(result.stdout).replace(/[\r\n]+$/, '')
    if (!linuxPath.startsWith('/') || linuxPath.includes('\n') || linuxPath.includes('\0'))
      throw Error('无法转换 WSL 核心文件路径。')
    return linuxPath
  }
  async start(distribution) {
    const known = await this.distributions()
    if (this.closing) throw Error('应用正在退出，已停止连接 WSL。')
    const actual = known.find((name) => name.toLowerCase() === distribution.toLowerCase())
    if (!actual) throw Error(`未找到 WSL 发行版 ${distribution}，请检查该发行版是否仍已安装。`)
    const source = __dirname.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
    const worker = path.join(source, 'wsl-worker.cjs')
    const data = path.join(
      this.options.dataDirectory || path.join(os.homedir(), '.gitcode'),
      'wsl',
      createHash('sha256').update(actual.toLowerCase()).digest('hex').slice(0, 16),
    )
    await fs.mkdir(data, { recursive: true })
    const binary = this.options.resourcesPath
      ? path.join(this.options.resourcesPath, 'wsl', 'bin', 'node')
      : path.resolve(__dirname, '../.gitcode-local/wsl-runtime', process.arch, 'bin/node')
    const bundled = await fs.access(binary).then(
      () => true,
      () => false,
    )
    if (this.options.resourcesPath && !bundled)
      throw Error('安装包缺少 WSL 核心运行时，请重新安装 GitCode。')
    const [workerPath, dataPath, nodePath] = await Promise.all([
      this.hostPath(actual, worker),
      this.hostPath(actual, data),
      bundled ? this.hostPath(actual, binary) : Promise.resolve('node'),
    ])
    if (this.closing) throw Error('应用正在退出，已停止连接 WSL。')
    const child = this.spawnWorker([
      '--distribution',
      actual,
      '--cd',
      '/',
      '--exec',
      nodePath,
      workerPath,
      dataPath,
      '--parent-store',
    ])
    const client = new WslClient(child, {
      trustStore: new RepositoryTrust(null, { directory: data }),
      onJournal: (message) => {
        const removed = new Set(message.removed)
        this.git.journal.records = this.git.journal.records.filter(
          (record) => !removed.has(record.id),
        )
        for (const record of message.records) {
          const mapped = mapResult(record, actual)
          const index = this.git.journal.records.findIndex((entry) => entry.id === mapped.id)
          if (index < 0) this.git.journal.records.push(mapped)
          else this.git.journal.records[index] = mapped
        }
        for (const [repo, state] of Object.entries(message.fetches))
          this.git.journal.fetches[toUnc(actual, repo)] = state
        void this.git.journal.save()
      },
    })
    this.startingClients.add(client)
    try {
      const runtime = await client.request('runtime')
      const fetches = Object.fromEntries(
        Object.entries(this.git.journal.fetches).flatMap(([repo, value]) => {
          const parsed = parseWslPath(repo)
          return parsed?.distribution.toLowerCase() === actual.toLowerCase()
            ? [[parsed.linuxPath, value]]
            : []
        }),
      )
      await client.request('journal-bootstrap', [
        { settings: this.git.journal.preferences(), fetches },
      ])
      client.distribution = actual
      client.runtime = runtime
      this.connected.set(actual.toLowerCase(), client)
      return client
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    } finally {
      this.startingClients.delete(client)
    }
  }
  async client(distribution) {
    if (this.closing) throw Error('应用正在退出，无法连接 WSL 仓库。')
    const key = distribution.toLowerCase()
    let pending = this.clients.get(key)
    if (pending && (await pending).closed) {
      this.clients.delete(key)
      pending = null
    }
    if (!pending) {
      if (this.clients.size >= 8) throw Error('已连接过多 WSL 发行版，请重启 GitCode 后再打开。')
      pending = this.start(distribution)
      this.clients.set(key, pending)
      void pending.catch(() => {
        if (this.clients.get(key) === pending) this.clients.delete(key)
      })
    }
    return pending
  }
  async invoke(distribution, method, args) {
    const generation = this.generation
    const client = await this.client(distribution)
    if (generation !== this.generation || this.closing)
      throw Error('Git 操作已取消，请检查仓库状态。')
    if (method !== 'directory' && !client.runtime.gitAvailable) {
      client.runtime = await client.request('runtime-refresh')
      if (!client.runtime.gitAvailable)
        throw Error(
          `WSL ${client.distribution}：请在该发行版中安装 Git 2.46 或更高版本，再重新打开仓库。\n${client.runtime.gitError || ''}`,
        )
    }
    if (generation !== this.generation || this.closing)
      throw Error('Git 操作已取消，请检查仓库状态。')
    const result = mapResult(await client.request(method, args), client.distribution)
    const execution = {
      kind: 'wsl',
      distribution: client.distribution,
      gitPath: client.runtime.gitPath,
      gitVersion: client.runtime.gitVersion,
    }
    if (result?.commits && result.path) result.execution = execution
    if (result?.snapshot) result.snapshot.execution = execution
    return result
  }
  async route(method, args, local) {
    if (method === 'activity') {
      for (const client of this.connected.values()) {
        if (client?.activity?.state === 'running') {
          return mapResult(client.activity, client.distribution)
        }
      }
      return local()
    }
    if (method === 'activity-settings') {
      const result = await local()
      if (args[0] != null)
        await Promise.all(
          [...this.clients.values()].map(async (pending) => {
            const client = await pending.catch(() => null)
            if (client && !client.closed) await client.request(method, [result])
          }),
        )
      return result
    }
    if (method === 'directory' && isWslRoot(args[0])) {
      const folders = (await this.distributions()).map((name) => ({
        name,
        path: toUnc(name, '/'),
        isGit: false,
        hidden: false,
        symlink: false,
      }))
      return {
        path: ROOT,
        parent: null,
        root: ROOT,
        home: os.homedir(),
        folders,
        truncated: false,
        locations: [{ name: 'Linux (WSL)', path: ROOT }],
      }
    }
    const create = method === 'create'
    const value = create ? (args.length === 1 ? args[0]?.path : args[1]) : args[0]
    const parsed =
      (repositoryMethods.has(method) || method === 'directory' || create) && parseWslPath(value)
    if (!parsed) {
      const result = await local()
      return method === 'directory'
        ? { ...result, locations: [{ name: 'Linux (WSL)', path: ROOT }] }
        : result
    }
    const { distribution, linuxPath } = parsed
    if (method === 'fetch-status') return this.git.journal.status(toUnc(distribution, linuxPath))
    if (method === 'auto-fetch') {
      const journal = this.git.journal
      if (
        this.git.current ||
        this.git.pendingJobs ||
        this.closing ||
        journal.leases.size ||
        !journal.settings.autoFetchInterval
      )
        return { skipped: true }
      const key = toUnc(distribution, linuxPath)
      const previous = journal.status(key)
      const elapsed = journal.now() - previous.lastAttempt
      if (elapsed >= 0 && elapsed < journal.settings.autoFetchInterval * 60000)
        return { skipped: true, status: previous }
      const lease = { owner: this, interrupted: false, controller: null }
      journal.leases.set(key, lease)
      try {
        const client = await this.client(distribution)
        if (lease.interrupted || this.closing) return { skipped: true }
        lease.controller = {
          abort: () => {
            void client.request('cancel-auto-fetch', [linuxPath]).catch(() => {})
          },
        }
        return await this.invoke(distribution, method, [linuxPath])
      } finally {
        if (journal.leases.get(key) === lease) journal.leases.delete(key)
      }
    }
    if (!backgroundMethods.has(method))
      for (const lease of this.git.journal.leases?.values() || []) {
        lease.interrupted = true
        lease.controller?.abort()
      }
    let remoteArgs
    if (create) {
      const request = args.length === 1 ? args[0] : { kind: args[0], path: args[1], url: args[2] }
      let url = request.url || ''
      if (parseWslPath(url)) {
        const origin = parseWslPath(url)
        if (origin.distribution.toLowerCase() !== distribution.toLowerCase())
          throw Error('克隆来源与目标不能跨 WSL 发行版。')
        url = origin.linuxPath
      } else if (/^[a-z]:[\\/]/i.test(url)) url = await this.hostPath(distribution, url)
      remoteArgs = [request.kind, linuxPath, url]
    } else remoteArgs = [linuxPath, ...args.slice(1)]
    const result = await this.invoke(distribution, method, remoteArgs)
    if (method === 'directory') {
      result.locations = [
        { name: 'Windows 用户目录', path: os.homedir() },
        { name: 'Linux (WSL)', path: ROOT },
      ]
      if (linuxPath === '/') result.parent = ROOT
    }
    return result
  }
  cancel() {
    this.generation++
    for (const lease of this.git.journal.leases?.values() || [])
      if (lease.owner === this) lease.interrupted = true
    for (const pending of this.clients.values())
      void pending.then((client) => !client.closed && client.request('cancel')).catch(() => {})
  }
  async shutdown() {
    this.closing = true
    this.probeController.abort()
    this.cancel()
    const owned = new Set([...this.connected.values(), ...this.startingClients])
    // A pending filesystem/probe read must not hold application exit. Any
    // late startup observes `closing` before it can launch another worker.
    for (const pending of this.clients.values())
      void pending.then((client) => client.close()).catch(() => {})
    await Promise.allSettled([...owned].map((client) => client.close()))
    this.clients.clear()
    this.connected.clear()
  }
}
module.exports = { WslManager, WslClient, decode }
