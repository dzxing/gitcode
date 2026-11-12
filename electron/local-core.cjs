'use strict'

const { randomBytes } = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { OperationLog } = require('./operation-log.cjs')
const { GitService } = require('./git.cjs')

const PREFIX = '/__gitcode/'
const CLIENT = 'gitcode-browser-v1'
const LIMIT = 1024 * 1024
const IDLE = 30 * 60 * 1000
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const hosts = new Set(['localhost', '127.0.0.1', '[::1]'])

function failure(status, message) {
  return Object.assign(new Error(message), { status })
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw failure(415, '请求必须使用 JSON。')
  if (Number(req.headers['content-length']) > LIMIT) throw failure(413, '请求内容过大。')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.from(chunk)
    size += data.length
    if (size > LIMIT) throw failure(413, '请求内容过大。')
    chunks.push(data)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw failure(400, '请求 JSON 无效。')
  }
}

// Same business operations as Electron IPC, with no arbitrary shell or filesystem API.
function dispatch(git, method, args) {
  const jobs = new Map([
    [
      'history-metadata',
      [
        2,
        ([repo, sha]) =>
          git.job(
            async (signal) => git.history.metadata(await git.repository(repo, signal), sha, signal),
            { background: true },
          ),
      ],
    ],
    [
      'history-read',
      [
        2,
        ([repo, request]) =>
          git.job(
            async (signal) => git.history.read(await git.repository(repo, signal), request, signal),
            { background: true },
          ),
      ],
    ],
    ['repository-trust', [1, ([repo]) => git.job((signal) => git.trust.inspect(repo, signal))]],
    [
      'repository-trust-approve',
      [2, ([repo, token]) => git.job((signal) => git.trust.approve(repo, token, signal))],
    ],
    [
      'partial-stage-read',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.partialStage.read(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'recovery-read',
      [
        1,
        ([repo]) =>
          git.job(async (signal) => git.recovery.read(await git.repository(repo, signal), signal)),
      ],
    ],
    [
      'fetch-settings-read',
      [
        1,
        ([repo]) =>
          git.job(async (signal) =>
            git.fetchSettings.read(await git.repository(repo, signal), signal),
          ),
      ],
    ],
    ['repository-changes', [1, ([repo]) => git.repositoryWatch.status(repo)]],
    ['background-snapshot', [2, ([repo, request]) => git.repositoryWatch.read(repo, request)]],
    ['activity', [0, () => git.activity]],
    ['operation-log', [1, ([request]) => git.journal.read(request)]],
    ['operation-log-clear', [1, ([request]) => git.journal.clear(request)]],
    [
      'activity-settings',
      [1, ([value]) => git.journal.preferences(value === null ? undefined : value)],
    ],
    ['auto-fetch', [1, ([repo]) => git.automaticFetch(repo)]],
    [
      'commit-operation-read',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.commitOperations.read(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'fetch-status',
      [
        1,
        ([repo]) => {
          if (typeof repo !== 'string' || repo.length > 32768) throw Error('无效的仓库路径。')
          return git.journal.status(repo)
        },
      ],
    ],
    [
      'rebase-menu-read',
      [
        2,
        ([repo, request]) =>
          git.job(
            async (signal) => git.rebase.menu(await git.repository(repo, signal), request, signal),
            { background: true },
          ),
      ],
    ],
    [
      'navigation-read',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.navigation.read(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'runtime',
      [
        0,
        () =>
          git.runtime().then((value) => ({
            ...value,
            transport: 'local',
            environment:
              /microsoft/i.test(os.release()) || process.env.WSL_INTEROP ? 'wsl' : 'native',
          })),
      ],
    ],
    [
      'merge-read',
      [
        2,
        ([repo, file]) =>
          git.job(async (signal) =>
            git.merge.read(await git.repository(repo, signal), file, signal),
          ),
      ],
    ],
    [
      'stash-read',
      [
        3,
        ([repo, oid, file]) =>
          git.job(async (signal) =>
            git.stash.read(await git.repository(repo, signal), oid, file, signal),
          ),
      ],
    ],
    [
      'snapshot',
      [
        1,
        ([repo]) =>
          git.job(async (signal) => git.snapshot(await git.repository(repo, signal), signal)),
      ],
    ],
    [
      'selected-commit-plan',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.selectedCommitPlan(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'commit',
      [
        2,
        ([repo, oid]) =>
          git.job(async (signal) =>
            git.commitDetails(await git.repository(repo, signal), oid, signal),
          ),
      ],
    ],
    [
      'diff',
      [
        4,
        ([repo, file, staged, oid]) =>
          git.job(async (signal) =>
            git.diff(await git.repository(repo, signal), file, staged, oid, signal),
          ),
      ],
    ],
    [
      'action',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.action(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'sync-plan',
      [
        3,
        ([repo, kind, expected]) =>
          git.job(async (signal) =>
            git.syncPlan(await git.repository(repo, signal), kind, expected, signal),
          ),
      ],
    ],
    [
      'gitflow-plan',
      [
        2,
        ([repo, request]) =>
          git.job(async (signal) =>
            git.flow.plan(await git.repository(repo, signal), request, signal),
          ),
      ],
    ],
    [
      'create',
      [3, ([kind, path, url]) => git.job((signal) => git.create({ kind, path, url }, signal))],
    ],
    ['directory', [1, ([path]) => git.listDirectory(path)]],
    ['cancel', [0, () => git.cancel()]],
  ])
  const command = jobs.get(method)
  if (!command || !Array.isArray(args) || args.length !== command[0])
    throw failure(400, '不支持的本机操作或参数。')
  return command[1](args)
}

function createLocalCore({
  port = 43187,
  serviceFactory,
  dataDirectory = process.env.GITCODE_DATA_DIR ||
    path.join(os.homedir(), '.local', 'state', 'gitcode'),
  now = Date.now,
} = {}) {
  const journal = new OperationLog({ directory: dataDirectory })
  serviceFactory ||= () => new GitService({ journal, dataDirectory, enforceRepositoryTrust: true })
  const sessions = new Map()
  const activeRequests = new Set()
  let closing = false
  let draining = false
  async function dispose(token) {
    const session = sessions.get(token)
    if (!session) return
    sessions.delete(token)
    await session.git.shutdown()
  }
  async function sweep() {
    await Promise.all(
      [...sessions]
        .filter(([, value]) => !value.busy && now() - value.used > IDLE)
        .map(([token]) => dispose(token)),
    )
  }
  const timer = setInterval(() => {
    void sweep().catch(() => {})
  }, 60000)
  timer.unref()
  function authorized(req) {
    if (!loopback.has(req.socket?.remoteAddress))
      throw failure(403, '本地 Git 服务仅接受本机连接。')
    let url
    try {
      url = new URL(`http://${req.headers.host}`)
    } catch {
      throw failure(403, '无效的本机地址。')
    }
    if (!hosts.has(url.hostname) || url.port !== String(port) || req.headers.host !== url.host)
      throw failure(403, '无效的本机地址。')
    if (
      req.headers.origin !== url.origin ||
      req.headers['x-gitcode-client'] !== CLIENT ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    )
      throw failure(403, '此页面无权连接本地 Git 服务。')
    if (req.method !== 'POST') throw failure(405, '仅支持 POST 请求。')
  }
  async function handle(req, res, next) {
    if (!req.url?.startsWith(PREFIX)) return next()
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return
      res.statusCode = status
      res.end(JSON.stringify(value))
    }
    try {
      authorized(req)
      if (closing) throw failure(503, '本地 Git 服务正在关闭。')
      if (![`${PREFIX}session`, `${PREFIX}rpc`, `${PREFIX}close`].includes(req.url))
        throw failure(404, '未知的本机接口。')
      if (req.url === `${PREFIX}session`) {
        if (draining) throw failure(503, '本地 Git 服务正在重新加载。')
        const value = await body(req)
        if (!value || Array.isArray(value) || Object.keys(value).length)
          throw failure(400, '无效的会话请求。')
        await sweep()
        if (closing || draining) throw failure(503, '本地 Git 服务正在重新加载。')
        if (sessions.size >= 32)
          throw failure(429, '本机连接数量已满，请关闭不再使用的 GitCode 页面后重试。')
        const token = randomBytes(32).toString('hex')
        sessions.set(token, {
          git: serviceFactory(),
          busy: 0,
          used: now(),
          origin: req.headers.origin,
        })
        return send(200, { token, protocol: 1 })
      }
      const token = req.headers['x-gitcode-token']
      const session = typeof token === 'string' && sessions.get(token)
      if (session && session.origin !== req.headers.origin)
        throw failure(401, '本机连接来源不匹配。')
      if (!session || (!session.busy && now() - session.used > IDLE)) {
        if (session) await dispose(token)
        throw failure(401, '本机连接已失效，请重新连接并核对仓库状态。')
      }
      session.used = now()
      if (req.url === `${PREFIX}close`) {
        await body(req)
        await dispose(token)
        return send(200, { result: null })
      }
      const value = await body(req)
      if (!value || typeof value.method !== 'string') throw failure(400, '缺少本机操作。')
      if (closing || sessions.get(token) !== session)
        throw failure(401, '本机连接已关闭，请重新连接。')
      if (draining && value.method !== 'cancel') throw failure(503, '本地 Git 服务正在重新加载。')
      session.busy++
      try {
        return send(200, {
          result: (await dispatch(session.git, value.method, value.args)) ?? null,
        })
      } finally {
        session.busy--
        session.used = now()
      }
    } catch (error) {
      send(error.status || 400, {
        error: String(error.message || error)
          .replace(/(https?:\/\/)[^\s/@]+@/g, '$1…@')
          .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1'),
      })
    }
  }
  return {
    middleware: (req, res, next) => {
      const request = handle(req, res, next)
      activeRequests.add(request)
      void request.then(
        () => activeRequests.delete(request),
        () => activeRequests.delete(request),
      )
    },
    drain: async () => {
      draining = true
      while (activeRequests.size) await Promise.allSettled([...activeRequests])
    },
    close: async () => {
      closing = true
      clearInterval(timer)
      await Promise.all([...sessions.keys()].map((token) => dispose(token)))
    },
  }
}

module.exports = { createLocalCore }
