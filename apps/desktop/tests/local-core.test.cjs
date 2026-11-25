const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createLocalCore } = require('../electron/local-core.cjs')
const { GitService } = require('../electron/git.cjs')
const { readPreference } = require('../electron/git-runtime.cjs')

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

test(
  'concurrent browser Git settings saves do not share a temporary file',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-runtime-concurrent-'))
    const files = [path.join(root, 'git-a'), path.join(root, 'git-b')]
    for (const file of files)
      await fs.writeFile(file, '#!/bin/sh\nprintf "git version 2.54.0\\n"\n', { mode: 0o755 })
    const core = createLocalCore({
      dataDirectory: root,
      serviceFactory: () => new GitService({ dataDirectory: root, env: {} }),
    })
    t.after(async () => {
      await core.close()
      await fs.rm(root, { recursive: true, force: true })
    })
    const tokens = await Promise.all([connect(core), connect(core)])
    const write = fs.writeFile
    fs.writeFile = async (file, ...args) => {
      const result = await write(file, ...args)
      if (
        String(file).startsWith(path.join(root, 'git-runtime.json')) &&
        String(file).endsWith('.tmp')
      )
        await new Promise((resolve) => setTimeout(resolve, 100))
      return result
    }
    try {
      const results = await Promise.all(
        tokens.map((token, index) =>
          rpc(core, token, 'git-settings', [{ mode: 'custom', path: files[index] }]),
        ),
      )
      for (const result of results) assert.equal(result.status, 200, result.body.error)
      const saved = JSON.parse(await fs.readFile(path.join(root, 'git-runtime.json'), 'utf8'))
      assert.ok(files.includes(saved.path))
    } finally {
      fs.writeFile = write
    }
  },
)

test('browser Git settings validate, apply and persist without Electron, while failed selections preserve state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-browser-runtime-'))
  const settingsFile = path.join(root, 'git-runtime.json')
  const baseline = new GitService()
  const runtime = await baseline.runtime()
  assert.equal(runtime.gitAvailable, true, runtime.gitError)
  let executable = runtime.gitPath
  if (!path.isAbsolute(executable)) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(directory, executable)
      if (
        await fs.access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        executable = candidate
        break
      }
    }
  }
  assert.equal(path.isAbsolute(executable), true)
  const env = { ...process.env }
  delete env.GITCODE_GIT_PATH
  delete env.GITK_GIT_PATH
  const factory = () =>
    createLocalCore({
      dataDirectory: root,
      serviceFactory: () =>
        new GitService({ dataDirectory: root, env, selection: readPreference(settingsFile) }),
    })
  let core = factory()
  t.after(async () => {
    await core.close()
    await baseline.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const token = await connect(core)
  const original = await rpc(core, token, 'git-settings', [null])
  assert.equal(original.status, 200)
  const invalid = await rpc(core, token, 'git-settings', [
    { mode: 'custom', path: path.join(root, 'missing-git') },
  ])
  assert.equal(invalid.status, 400)
  assert.equal(
    await fs.access(settingsFile).then(
      () => true,
      () => false,
    ),
    false,
  )
  const applied = await rpc(core, token, 'git-settings', [{ mode: 'custom', path: executable }])
  assert.equal(applied.status, 200, applied.body.error)
  assert.equal(applied.body.result.runtime.gitAvailable, true)
  assert.equal(applied.body.result.runtime.transport, 'local')
  assert.equal(applied.body.result.runtime.gitPath, executable)
  assert.equal(applied.body.result.restartRequired, undefined)
  assert.equal((await rpc(core, token, 'git-runtime-refresh')).status, 200)
  assert.equal((await rpc(core, token, 'git-settings')).status, 400)
  await core.close()
  core = factory()
  const restored = await rpc(core, await connect(core), 'git-settings', [null])
  assert.equal(restored.body.result.selection.path, executable)
  assert.equal(restored.body.result.runtime.gitAvailable, true)
})

test('default browser core remembers repository trust after a new session and a full core restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-core-trust-'))
  const repo = path.join(root, 'repo'),
    dataDirectory = path.join(root, 'profile')
  await fs.mkdir(repo)
  const setup = new GitService()
  await setup.git(repo, ['init', '-b', 'qa/base'])
  let core = createLocalCore({ dataDirectory })
  t.after(async () => {
    await core.close()
    await setup.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const first = await connect(core)
  const challenge = await rpc(core, first, 'repository-trust', [repo])
  assert.equal(challenge.body.result.trusted, false)
  assert.notEqual((await rpc(core, first, 'fetch-settings-read', [repo])).status, 200)
  const approval = await rpc(core, first, 'repository-trust-approve', [
    repo,
    challenge.body.result.token,
  ])
  assert.equal(approval.status, 200)
  const second = await connect(core)
  assert.equal((await rpc(core, second, 'repository-trust', [repo])).body.result.trusted, true)
  await core.close()
  core = createLocalCore({ dataDirectory })
  const third = await connect(core)
  assert.equal((await rpc(core, third, 'repository-trust', [repo])).body.result.trusted, true)
  const fetchSettings = await rpc(core, third, 'fetch-settings-read', [repo])
  assert.equal(fetchSettings.status, 200)
  assert.equal(fetchSettings.body.result.shallow, false)
  assert.deepEqual(fetchSettings.body.result.remotes, [])
  const snapshot = await rpc(core, third, 'snapshot', [repo])
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.result.path, await fs.realpath(repo))
})

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

test('browser observation exposes only named revision and readonly snapshot requests', async (t) => {
  const calls = []
  const core = createLocalCore({
    serviceFactory: () => ({
      repositoryWatch: {
        status: async (repo) => {
          calls.push(['status', repo])
          return { revision: 'qa:1', fallback: false, watched: 2 }
        },
        read: async (repo, request) => {
          calls.push(['read', repo, request])
          return { snapshot: null, deferred: 'busy' }
        },
      },
      shutdown: async () => {},
    }),
  })
  t.after(() => core.close())
  const token = await connect(core)
  assert.equal((await rpc(core, token, 'repository-changes', ['/qa'])).body.result.revision, 'qa:1')
  assert.equal(
    (await rpc(core, token, 'background-snapshot', ['/qa', null])).body.result.deferred,
    'busy',
  )
  assert.deepEqual(calls, [
    ['status', '/qa'],
    ['read', '/qa', null],
  ])
  assert.equal((await rpc(core, token, 'background-snapshot', ['/qa'])).status, 400)
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-browser-中文 ')))
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
  const metadata = await call('history-metadata', [repo, head])
  assert.equal(metadata.hash, head)
  assert.equal(metadata.subject, 'Browser commit')
  assert.ok(!Number.isNaN(Date.parse(metadata.date)))
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

test('development restart drains an active operation and rejects new work without cancelling it', async (t) => {
  let finish, started
  const running = new Promise((resolve) => {
    started = resolve
  })
  const completed = new Promise((resolve) => {
    finish = resolve
  })
  let shutdowns = 0
  const core = createLocalCore({
    serviceFactory: () => ({
      runtime: async () => {
        started()
        await completed
        return { platform: 'test' }
      },
      cancel: async () => {
        finish()
      },
      shutdown: async () => {
        shutdowns++
      },
    }),
  })
  t.after(() => core.close())
  const token = await connect(core)
  const pending = rpc(core, token, 'runtime')
  await running
  let drained = false
  const draining = core.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  assert.equal(drained, false)
  assert.equal(shutdowns, 0)
  assert.equal((await rpc(core, token, 'runtime')).status, 503)
  assert.equal((await rpc(core, token, 'cancel')).status, 200)
  assert.equal((await pending).status, 200)
  await draining
  assert.equal(drained, true)
  assert.equal(shutdowns, 0)
  await core.close()
  assert.equal(shutdowns, 1)
})

test('activity RPC reads settings with JSON null, isolates logs, and clears only its scope', async (t) => {
  const { OperationLog } = require('../electron/operation-log.cjs')
  const journal = new OperationLog()
  const core = createLocalCore({ serviceFactory: () => new GitService({ journal }) })
  t.after(() => core.close())
  const token = await connect(core)
  const current = await rpc(core, token, 'activity-settings', [null])
  assert.equal(current.status, 200)
  assert.equal(current.body.result.autoFetchInterval, 1)
  await rpc(core, token, 'activity-settings', [{ autoFetchInterval: 0, extended: false }])
  const entry = journal.start('push', '/qa')
  journal.finish(entry, { outcome: 'failed', error: 'QA rejection' })
  const other = await rpc(core, token, 'operation-log', [{ scope: 'repository', repo: '/other' }])
  assert.equal(other.body.result.records.length, 0)
  const own = await rpc(core, token, 'operation-log', [
    { scope: 'repository', repo: '/qa', id: entry.id },
  ])
  assert.equal(own.body.result.records[0].message, 'QA rejection')
  await rpc(core, token, 'operation-log-clear', [{ scope: 'repository', repo: '/qa' }])
  assert.equal(journal.records.filter((r) => r.repo === '/qa').length, 0)
  assert.ok(journal.records.some((r) => r.operation === 'activity-settings'))
  assert.equal((await rpc(core, token, 'fetch-status', ['/qa'])).status, 200)
  assert.equal((await rpc(core, token, 'auto-fetch', ['/qa'])).body.result.skipped, true)
})

test('recovery is a named read endpoint with fixed arity and canonical repository validation', async (t) => {
  const calls = []
  const core = createLocalCore({
    serviceFactory: () => ({
      repository: async (repo) => {
        calls.push(['repository', repo])
        return '/canonical'
      },
      job: async (work) => work(),
      recovery: {
        read: async (repo) => {
          calls.push(['recovery', repo])
          return { id: 'plan', entries: [] }
        },
      },
      shutdown: async () => {},
    }),
  })
  t.after(() => core.close())
  const token = await connect(core)
  const response = await rpc(core, token, 'recovery-read', ['/repo'])
  assert.equal(response.status, 200)
  assert.equal(response.body.result.id, 'plan')
  assert.deepEqual(calls, [
    ['repository', '/repo'],
    ['recovery', '/canonical'],
  ])
  assert.equal((await rpc(core, token, 'recovery-read', [])).status, 400)
  assert.equal((await rpc(core, token, 'recovery-read', ['/repo', 'extra'])).status, 400)
})

test('partial staging read has fixed arity and receives canonical paths through the job queue', async (t) => {
  const calls = [],
    request = { file: 'file.txt', source: 'unstaged', expectedHead: '', expectedBranch: 'qa/test' }
  const core = createLocalCore({
    serviceFactory: () => ({
      repository: async (repo) => {
        calls.push(['repo', repo])
        return '/canonical'
      },
      job: async (work) => work(),
      partialStage: {
        read: async (repo, value) => {
          calls.push(['read', repo, value])
          return { id: 'plan', hunks: [] }
        },
      },
      shutdown: async () => {},
    }),
  })
  t.after(() => core.close())
  const token = await connect(core)
  assert.equal(
    (await rpc(core, token, 'partial-stage-read', ['/repo', request])).body.result.id,
    'plan',
  )
  assert.deepEqual(calls, [
    ['repo', '/repo'],
    ['read', '/canonical', request],
  ])
  assert.equal((await rpc(core, token, 'partial-stage-read', ['/repo'])).status, 400)
  assert.equal(
    (await rpc(core, token, 'partial-stage-read', ['/repo', request, 'extra'])).status,
    400,
  )
})

test('menu history reads preserve an automatic-fetch lease; full action preflight retains foreground cancellation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-menu-lease-'))
  const git = new GitService({ dataDirectory: directory })
  git.repository = async () => '/canonical'
  git.rebase.menu = async () => ({ canInteractive: true })
  git.navigation.read = async () => ({ fullRef: 'refs/heads/main' })
  const core = createLocalCore({ serviceFactory: () => git })
  t.after(async () => {
    await core.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const token = await connect(core),
    controller = new AbortController()
  git.journal.leases.set('fixture-fetch', { controller, interrupted: false })
  const menu = await rpc(core, token, 'rebase-menu-read', [
    '/repo',
    { head: 'a'.repeat(40), oid: 'b'.repeat(40) },
  ])
  assert.equal(menu.status, 200)
  assert.deepEqual(menu.body.result, { canInteractive: true })
  assert.equal((await rpc(core, token, 'rebase-menu-read', ['/repo'])).status, 400)
  assert.equal(controller.signal.aborted, false)
  const plan = await rpc(core, token, 'navigation-read', ['/repo', { kind: 'rebase' }])
  assert.equal(plan.status, 200)
  assert.equal(controller.signal.aborted, true)
})
