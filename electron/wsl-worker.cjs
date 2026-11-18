'use strict'
// Private stdio transport, launched by the Windows main process. This starts
// no server and exposes only the same named operations as the local core.
const readline = require('node:readline')
const { GitService } = require('./git.cjs')
const { dispatch } = require('./local-core.cjs')
const { OperationLog } = require('./operation-log.cjs')

async function serve({
  input = process.stdin,
  output = process.stdout,
  directory,
  parentStore = false,
} = {}) {
  if (process.platform !== 'linux') throw Error('WSL 核心必须在 Linux 环境运行。')
  // A Windows Git override must never select a Windows executable in WSL.
  delete process.env.GITCODE_GIT_PATH
  delete process.env.GITK_GIT_PATH
  const send = (value) => output.write(JSON.stringify(value) + '\n')
  const journal = parentStore ? new OperationLog() : undefined
  const git = new GitService({
    dataDirectory: parentStore ? undefined : directory,
    journal,
    enforceRepositoryTrust: true,
  })
  const storage = new Map()
  let nextStorage = 0
  if (parentStore) {
    const ask = (method, key, value) =>
      new Promise((resolve, reject) => {
        const id = ++nextStorage
        const timer = setTimeout(() => {
          storage.delete(id)
          reject(Error('无法访问 Windows 仓库信任记录，请重新打开仓库。'))
        }, 15000)
        storage.set(id, { resolve, reject, timer })
        send({ event: 'trust-store', id, method, key, value })
      })
    // Identity/config inspection stays in Linux; persistence uses the Windows
    // supervisor's shared queues, including concurrent browser sessions.
    git.trust.grant = (key) => ask('grant', key)
    git.trust.persist = (key, value) => ask('persist', key, value)
    const records = new Map(),
      fetches = new Map()
    journal.save = () => {
      journal.trim()
      const changed = journal.records.filter((record) => {
        if (!record.repo) return false
        const data = JSON.stringify(record)
        if (records.get(record.id) === data) return false
        records.set(record.id, data)
        return true
      })
      const statuses = Object.fromEntries(
        Object.entries(journal.fetches).filter(([key, value]) => {
          const data = JSON.stringify(value)
          if (fetches.get(key) === data) return false
          fetches.set(key, data)
          return true
        }),
      )
      const retained = new Set(journal.records.map((record) => record.id))
      const removed = [...records.keys()].filter((key) => !retained.has(key))
      for (const key of removed) records.delete(key)
      if (changed.length || removed.length || Object.keys(statuses).length)
        send({ event: 'journal', records: changed, fetches: statuses, removed })
      return Promise.resolve()
    }
  }
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  const pending = new Set()
  let closing = false
  const activity = setInterval(() => send({ event: 'activity', value: git.activity }), 200)
  activity.unref()
  lines.on('line', (line) => {
    let request
    try {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw Error('WSL 请求过大。')
      request = JSON.parse(line)
      if (request.storageReply) {
        const pending = storage.get(request.id)
        if (pending) {
          storage.delete(request.id)
          clearTimeout(pending.timer)
          if (request.error) pending.reject(Error(request.error))
          else pending.resolve(request.result)
        }
        return
      }
      if (!Number.isSafeInteger(request.id) || request.id < 1 || closing)
        throw Error('无效的 WSL 请求。')
    } catch (error) {
      send({ id: request?.id, error: error.message })
      return
    }
    const work = (async () => {
      try {
        let result
        if (request.method === 'shutdown') {
          closing = true
          git.cancel()
          await git.shutdown()
          result = null
        } else if (request.method === 'cancel-auto-fetch') {
          const lease = git.journal.leases.get(request.args[0])
          if (lease) {
            lease.interrupted = true
            lease.controller?.abort()
          }
          result = null
        } else if (request.method === 'journal-bootstrap' && parentStore) {
          const state = request.args[0]
          git.journal.preferences(state.settings)
          git.journal.fetches = state.fetches
          result = null
        } else if (request.method === 'runtime-refresh') {
          result = await git.retryRuntime()
        } else if (request.method === 'canonical-repository') {
          if (!Array.isArray(request.args) || request.args.length !== 1) throw Error('无效的参数。')
          result = await git.job((signal) => git.repository(request.args[0], signal))
        } else result = await dispatch(git, request.method, request.args)
        send({ id: request.id, result: result ?? null })
      } catch (error) {
        send({ id: request.id, error: git.safeError(error), code: error.code })
      }
    })()
    pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  await new Promise((resolve) => lines.once('close', resolve))
  clearInterval(activity)
  for (const pending of storage.values()) {
    clearTimeout(pending.timer)
    pending.reject(Error('WSL 核心连接已关闭。'))
  }
  storage.clear()
  git.cancel()
  await Promise.allSettled([...pending])
  await git.shutdown()
}
if (require.main === module)
  serve({ directory: process.argv[2], parentStore: process.argv[3] === '--parent-store' }).catch(
    (error) => {
      process.stderr.write(error.message + '\n')
      process.exitCode = 1
    },
  )
module.exports = { serve }
