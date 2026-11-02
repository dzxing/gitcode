const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createLocalCore } = require('../electron/local-core.cjs')
const { GitService } = require('../electron/git.cjs')

// Exercise the real HTTP middleware without binding a socket in the sandbox.
function request(core, route, value = {}, options = {}) {
  const text = options.raw ?? JSON.stringify(value)
  const req = Readable.from([Buffer.from(text)])
  req.method = options.method || 'POST'
  req.url = `/__gitcode/${route}`
  req.socket = { remoteAddress: options.address || '127.0.0.1' }
  req.headers = {
    host: 'localhost:43187',
    origin: 'http://localhost:43187',
    'sec-fetch-site': 'same-origin',
    'x-gitcode-client': 'gitcode-browser-v1',
    'content-type': 'application/json',
    ...options.headers,
  }
  if (options.token) req.headers['x-gitcode-token'] = options.token
  return new Promise((resolve) => {
    const headers = {}
    const res = {
      statusCode: 200,
      setHeader: (key, value) => {
        headers[key.toLowerCase()] = value
      },
      end: (body) => {
        resolve({ status: res.statusCode, headers, body: JSON.parse(body) })
      },
    }
    core.middleware(req, res, () => resolve({ status: 404, body: { error: 'next middleware' } }))
  })
}
async function connect(core) {
  const result = await request(core, 'session')
  assert.equal(result.status, 200)
  assert.match(result.body.token, /^[a-f0-9]{64}$/)
  return result.body.token
}
const rpc = (core, token, method, args = []) => request(core, 'rpc', { method, args }, { token })

test('local core denies foreign origins, DNS-rebinding hosts, remote clients and unauthenticated RPC', async (t) => {
  let services = 0
  const core = createLocalCore({
    serviceFactory: () => {
      services++
      return { shutdown: async () => {} }
    },
  })
  t.after(() => core.close())
  for (const options of [
    { headers: { origin: 'https://evil.example' } },
    { headers: { origin: 'null' } },
    { headers: { host: 'evil.example:43187', origin: 'http://evil.example:43187' } },
    { headers: { origin: 'http://localhost:43188' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { 'x-gitcode-client': undefined } },
    { address: '192.168.1.20' },
  ])
    assert.equal((await request(core, 'session', {}, options)).status, 403)
  assert.equal(services, 0)
  assert.equal((await request(core, 'session', {}, { method: 'GET' })).status, 405)
  assert.equal((await rpc(core, undefined, 'runtime')).status, 401)
  const token = await connect(core)
  const rejected = await request(
    core,
    'rpc',
    { method: 'runtime', args: [] },
    { token, headers: { host: '127.0.0.1:43187', origin: 'http://127.0.0.1:43187' } },
  )
  assert.equal(rejected.status, 401)
  assert.equal(rejected.headers['access-control-allow-origin'], undefined)
  assert.equal(rejected.headers['cache-control'], 'no-store')
})

test('local core enforces payload limits and named operations rather than arbitrary commands', async (t) => {
  let called = 0
  const core = createLocalCore({
    serviceFactory: () => ({
      runtime: async () => {
        called++
        return { platform: 'test' }
      },
      shutdown: async () => {},
    }),
  })
  t.after(() => core.close())
  assert.equal(
    (await request(core, 'session', {}, { headers: { 'content-type': 'text/plain' } })).status,
    415,
  )
  assert.equal((await request(core, 'session', {}, { raw: '{' })).status, 400)
  assert.equal((await request(core, 'session', [], {})).status, 400)
  assert.equal(
    (await request(core, 'session', {}, { raw: 'x'.repeat(1024 * 1024 + 1) })).status,
    413,
  )
  const token = await connect(core)
  for (const method of ['exec', 'git', 'readFile', '__proto__', 'constructor'])
    assert.equal((await rpc(core, token, method, ['secret'])).status, 400)
  assert.equal((await rpc(core, token, 'runtime', ['unexpected'])).status, 400)
  const runtime = await rpc(core, token, 'runtime')
  assert.equal(runtime.status, 200)
  assert.equal(runtime.body.result.transport, 'local')
  assert.equal(called, 1)
  assert.equal((await request(core, 'missing', {}, { token })).status, 404)
})

test('browser sessions isolate cancellation and close, and expire only when idle', async (t) => {
  let now = 0
  const services = []
  const core = createLocalCore({
    now: () => now,
    serviceFactory: () => {
      const service = {
        cancelled: 0,
        closed: 0,
        runtime: async () => ({}),
        cancel() {
          this.cancelled++
        },
        async shutdown() {
          this.closed++
        },
      }
      services.push(service)
      return service
    },
  })
  t.after(() => core.close())
  const a = await connect(core),
    b = await connect(core)
  await rpc(core, a, 'cancel')
  assert.equal(services[0].cancelled, 1)
  assert.equal(services[1].cancelled, 0)
  await request(core, 'close', {}, { token: a })
  assert.equal(services[0].closed, 1)
  assert.equal(services[1].closed, 0)
  assert.equal((await rpc(core, a, 'runtime')).status, 401)
  assert.equal((await rpc(core, b, 'runtime')).status, 200)
  now += 31 * 60000
  assert.equal((await rpc(core, b, 'runtime')).status, 401)
  assert.equal(services[1].closed, 1)
  const c = await connect(core)
  assert.equal((await rpc(core, c, 'runtime')).status, 200)
})

test('browser session cap releases closed sessions and shutdown rejects new work', async (t) => {
  const core = createLocalCore({ serviceFactory: () => ({ shutdown: async () => {} }) })
  t.after(() => core.close())
  const tokens = []
  for (let i = 0; i < 32; i++) tokens.push(await connect(core))
  assert.equal((await request(core, 'session')).status, 429)
  await request(core, 'close', {}, { token: tokens[0] })
  await connect(core)
  await core.close()
  assert.equal((await request(core, 'session')).status, 503)
})

test('browser HTTP transport performs directory, Git, GitFlow and sync operations on a real temporary repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-browser-中文 '))
  const services = []
  const core = createLocalCore({
    serviceFactory: () => {
      const git = new GitService()
      services.push(git)
      return git
    },
  })
  t.after(async () => {
    await core.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const token = await connect(core)
  const call = async (method, args) => {
    const response = await rpc(core, token, method, args)
    assert.equal(response.status, 200, response.body.error)
    return response.body.result
  }
  const runtime = await call('runtime', [])
  assert.equal(runtime.gitAvailable, true)
  const repo = path.join(root, 'project')
  const created = await call('create', ['init', repo, ''])
  assert.equal(created.snapshot.branch, 'main')
  for (const [key, value] of [
    ['user.name', 'Browser test'],
    ['user.email', 'browser@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await services[0].git(repo, ['config', key, value])
  const directories = await call('directory', [root])
  assert.ok(directories.folders.some((folder) => folder.path === repo && folder.isGit))
  await fs.writeFile(path.join(repo, 'hello.txt'), 'hello browser\n')
  const expected = { expectedHead: '', expectedBranch: 'main' }
  const staged = await call('action', [
    repo,
    { action: 'stage', paths: ['hello.txt'], ...expected },
  ])
  assert.equal(staged.outcome, 'succeeded')
  assert.equal(staged.snapshot.staged.length, 1)
  const committed = await call('action', [
    repo,
    { action: 'commit', message: 'Browser commit', ...expected },
  ])
  assert.equal(committed.outcome, 'succeeded', committed.error)
  const head = committed.snapshot.head
  assert.match(head, /^[a-f0-9]{40,64}$/)
  const details = await call('commit', [repo, head])
  assert.ok(details.files.some((file) => file.path === 'hello.txt'))
  assert.match((await call('diff', [repo, 'hello.txt', false, head])).diff, /hello browser/)
  const snapshot = await call('snapshot', [repo])
  const saved = await call('action', [
    repo,
    {
      action: 'gitflow-save',
      expectedHead: head,
      expectedBranch: 'main',
      signature: snapshot.gitflow.signature,
      config: snapshot.gitflow.config,
    },
  ])
  assert.equal(saved.outcome, 'succeeded', saved.error)
  assert.equal(saved.snapshot.gitflow.ready, false)
  const repair = await call('gitflow-plan', [
    repo,
    {
      expectedHead: head,
      expectedBranch: 'main',
      signature: saved.snapshot.gitflow.signature,
      config: saved.snapshot.gitflow.config,
      sources: { develop: 'refs/heads/main' },
    },
  ])
  assert.deepEqual(
    repair.creates.map((item) => item.name),
    ['develop'],
  )
  const repaired = await call('action', [
    repo,
    { action: 'gitflow-init', planId: repair.id, expectedHead: head, expectedBranch: 'main' },
  ])
  assert.equal(repaired.outcome, 'succeeded', repaired.error)
  assert.equal(repaired.snapshot.gitflow.ready, true)
  assert.equal(repaired.snapshot.branch, 'main')
  const started = await call('action', [
    repo,
    {
      action: 'gitflow-start',
      expectedHead: head,
      expectedBranch: 'main',
      signature: repaired.snapshot.gitflow.signature,
      type: 'feature',
      name: 'browser',
      sourceOid: head,
      switchAfter: false,
    },
  ])
  assert.equal(started.outcome, 'succeeded', started.error)
  assert.ok(started.snapshot.branches.some((branch) => branch.name === 'feature/browser'))
  assert.equal(started.snapshot.branch, 'main')
  const bare = path.join(root, 'remote.git')
  await services[0].git(repo, ['init', '--bare', bare])
  await services[0].git(repo, ['remote', 'add', 'origin', bare])
  await services[0].git(repo, ['push', '-u', 'origin', 'main'])
  const plan = await call('sync-plan', [
    repo,
    'push',
    { expectedHead: head, expectedBranch: 'main', sourceRef: 'refs/heads/main', sourceOid: head },
  ])
  assert.equal(plan.sourceRef, 'refs/heads/main')
  const pushed = await call('action', [repo, { action: 'push', planId: plan.id }])
  assert.equal(pushed.outcome, 'succeeded', pushed.error)
  await fs.writeFile(path.join(repo, 'hello.txt'), 'stash over HTTP\n')
  const stashState = await call('snapshot', [repo])
  const stashed = await call('action', [
    repo,
    {
      action: 'stash-create',
      expectedHead: head,
      expectedBranch: 'main',
      stashSignature: stashState.stashSignature,
      message: 'HTTP stash',
      includeUntracked: true,
    },
  ])
  assert.equal(stashed.outcome, 'succeeded', stashed.error)
  const stashEntry = stashed.snapshot.stashes[0]
  const stashPreview = await call('stash-read', [repo, stashEntry.oid, 'hello.txt'])
  assert.match(stashPreview.diff.diff, /stash over HTTP/)
  const restored = await call('action', [
    repo,
    {
      action: 'stash-pop',
      expectedHead: head,
      expectedBranch: 'main',
      stashSignature: stashed.snapshot.stashSignature,
      stashOid: stashEntry.oid,
      stashRef: stashEntry.ref,
      restoreIndex: false,
    },
  ])
  assert.equal(restored.outcome, 'succeeded', restored.error)
  assert.equal(restored.snapshot.stashes.length, 0)
  const other = await connect(core)
  const isolated = await rpc(core, other, 'action', [repo, { action: 'push', planId: plan.id }])
  assert.equal(isolated.body.result.outcome, 'failed')
  assert.match(isolated.body.result.error, /同步目标已失效/)
})
