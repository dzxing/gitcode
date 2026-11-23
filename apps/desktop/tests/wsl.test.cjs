const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { ROOT, parseWslPath, toUnc, mapResult } = require('../electron/wsl-path.cjs')
const { WslManager, WslClient, decode } = require('../electron/wsl.cjs')
const { GitService } = require('../electron/git.cjs')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

test('shutdown does not wait for a stalled WSL discovery or start a late worker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-wsl-shutdown-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let release,
    spawned = false
  const probe = new Promise((resolve) => {
    release = resolve
  })
  const manager = new WslManager(
    { journal: {} },
    {
      dataDirectory: root,
      wslProbe: () => probe,
      wslSpawn: () => {
        spawned = true
        throw Error('late spawn')
      },
    },
  )
  const starting = manager.client('Ubuntu')
  void starting.catch(() => {})
  await manager.shutdown()
  assert.equal(manager.probeController.signal.aborted, true)
  release({ stdout: Buffer.from('Ubuntu\n') })
  await assert.rejects(starting, /正在退出/)
  assert.equal(spawned, false)
})

test('cancelling during WSL Git re-detection prevents the following mutation', async () => {
  const manager = new WslManager({ journal: {} })
  let release,
    writes = 0
  const detecting = new Promise((resolve) => {
    release = resolve
  })
  manager.client = async () => ({
    distribution: 'Ubuntu',
    runtime: { gitAvailable: false },
    request: async (method) => {
      if (method === 'runtime-refresh') return detecting
      if (method === 'action') writes++
      return {}
    },
  })
  const action = manager.invoke('Ubuntu', 'action', ['/repo', { action: 'commit' }])
  await new Promise((resolve) => setImmediate(resolve))
  manager.cancel()
  release({ gitAvailable: true })
  await assert.rejects(action, /已取消/)
  assert.equal(writes, 0)
})

test('unresponsive WSL shutdown is bounded independently of a long Git operation', async (t) => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  })
  child.kill = () => {
    child.emit('close', null, 'SIGTERM')
    return true
  }
  const client = new WslClient(child)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finished = false
  const closing = client.close().then(
    () => {
      finished = true
    },
    () => {
      finished = true
    },
  )
  try {
    t.mock.timers.tick(11000)
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(3100)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(finished, true)
  } finally {
    child.emit('close', 0)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    await closing
  }
})

test('WSL UNC aliases and extended paths preserve Linux case and cannot escape a distribution', () => {
  for (const value of [
    '\\\\wsl.localhost\\Ubuntu-26.04\\home\\Test Repo',
    '//wsl$/Ubuntu-26.04/home/Test Repo',
    '\\\\?\\UNC\\WSL.LOCALHOST\\Ubuntu-26.04\\home\\Test Repo',
  ])
    assert.deepEqual(parseWslPath(value), {
      distribution: 'Ubuntu-26.04',
      linuxPath: '/home/Test Repo',
    })
  for (const value of ['C:\\work\\repo', '\\\\server\\share\\repo', '/home/repo'])
    assert.equal(parseWslPath(value), null)
  for (const value of ['\\\\wsl$\\Ubuntu\\..\\other', '\\\\wsl$\\..\\home', '\\\\wsl$\\-d\\home'])
    assert.throws(() => parseWslPath(value))
  assert.equal(toUnc('Ubuntu', '/home/Repo'), '\\\\wsl.localhost\\Ubuntu\\home\\Repo')
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\开发 Ubuntu\\home\\Repo'), {
    distribution: '开发 Ubuntu',
    linuxPath: '/home/Repo',
  })
})
test('WSL transport changes path fields only, preserving patches, messages and branch names', () => {
  const result = mapResult(
    {
      path: '/home/Repo',
      snapshot: { path: '/home/Repo', unstaged: [{ path: '文件.txt' }] },
      output: '/home/Repo',
      message: '/home/Repo',
      diff: '+/home/Repo',
      config: { feature: '/feature/' },
    },
    'Ubuntu',
  )
  assert.equal(result.path, toUnc('Ubuntu', '/home/Repo'))
  assert.equal(result.snapshot.unstaged[0].path, '文件.txt')
  assert.equal(result.output, '/home/Repo')
  assert.equal(result.diff, '+/home/Repo')
  assert.equal(result.config.feature, '/feature/')
})
test('WSL distribution discovery decodes Windows UTF-16 without starting a default distribution', async () => {
  const calls = []
  const manager = new WslManager(
    { journal: {} },
    {
      wslProbe: async (args) => {
        calls.push(args)
        return { stdout: Buffer.from('\uFEFFUbuntu-26.04\r\ndocker-desktop\r\n', 'utf16le') }
      },
    },
  )
  const result = await manager.route('directory', [ROOT], () =>
    assert.fail('native filesystem must not enumerate WSL namespaces'),
  )
  assert.deepEqual(calls, [['--list', '--quiet']])
  assert.deepEqual(
    result.folders.map((folder) => folder.name),
    ['Ubuntu-26.04', 'docker-desktop'],
  )
  assert.equal(decode(Buffer.from('Ubuntu\n')), 'Ubuntu\n')
})
test('routing isolates distributions, translates clone destinations, and never sends Windows repositories to WSL', async () => {
  const calls = [],
    git = { journal: { preferences: () => ({ autoFetchInterval: 0, extended: false }) } }
  const manager = new WslManager(git)
  manager.invoke = async (...args) => {
    calls.push(args)
    return {}
  }
  const unc = toUnc('Ubuntu', '/home/Repo')
  await manager.route('action', [unc, { action: 'commit', message: '/home/Repo' }], () =>
    assert.fail(),
  )
  await manager.route(
    'create',
    [{ kind: 'clone', path: unc, url: toUnc('Ubuntu', '/tmp/source') }],
    () => assert.fail(),
  )
  await manager.route('snapshot', [toUnc('Debian', '/repo')], () => assert.fail())
  assert.equal(
    await manager.route(
      'operation-log',
      [{ scope: 'repository', repo: unc }],
      () => 'supervisor-log',
    ),
    'supervisor-log',
  )
  assert.deepEqual(calls[0], [
    'Ubuntu',
    'action',
    ['/home/Repo', { action: 'commit', message: '/home/Repo' }],
  ])
  assert.deepEqual(calls[1], ['Ubuntu', 'create', ['clone', '/home/Repo', '/tmp/source']])
  assert.equal(calls[2][0], 'Debian')
  assert.equal(await manager.route('snapshot', ['C:\\repo'], () => 'native'), 'native')
  await assert.rejects(
    manager.route(
      'create',
      [{ kind: 'clone', path: unc, url: toUnc('Debian', '/source') }],
      () => {},
    ),
    /不能跨/,
  )
})
test('cancellation during WSL startup prevents a queued mutation from being replayed', async () => {
  const manager = new WslManager({ journal: {} })
  let ready,
    executed = 0
  manager.start = () =>
    new Promise((resolve) => {
      ready = resolve
    })
  const work = manager.invoke('Ubuntu', 'action', ['/repo', { action: 'commit' }])
  manager.cancel()
  ready({
    closed: false,
    request: async (method) => {
      if (method === 'action') executed++
    },
  })
  await assert.rejects(work, /已取消/)
  assert.equal(executed, 0)
})

test('WSL sessions share auto-fetch leases and foreground work cancels only that background fetch', async () => {
  const git = new GitService()
  const manager = new WslManager(git),
    second = new WslManager(git)
  const repo = toUnc('Ubuntu', '/repo')
  const cancellations = []
  manager.client = async () => ({
    request: async (...args) => {
      cancellations.push(args)
    },
  })
  let finish
  manager.invoke = async (_distribution, method) =>
    method === 'auto-fetch'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : {}
  try {
    const fetching = manager.route('auto-fetch', [repo], () => assert.fail())
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(await second.route('auto-fetch', [repo], () => assert.fail()), {
      skipped: true,
    })
    await manager.route('action', [repo, { action: 'commit' }], () => assert.fail())
    assert.deepEqual(cancellations, [['cancel-auto-fetch', ['/repo']]])
    finish({ skipped: true })
    await fetching
    assert.equal(git.journal.leases.size, 0)
  } finally {
    await git.shutdown()
  }
})

test(
  'Linux worker runs the existing trusted core through stdio, including stash, watches and persisted trust',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-wsl-中文 '))
    const repo = path.join(root, 'repo'),
      data = path.join(root, 'state')
    await fs.mkdir(repo)
    const fixture = new GitService()
    t.after(async () => {
      await fixture.shutdown()
      await fs.rm(root, { recursive: true, force: true })
    })
    await fixture.git(repo, ['init', '-b', 'test/base'])
    for (const [key, value] of [
      ['user.name', 'WSL Test'],
      ['user.email', 'wsl@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await fixture.git(repo, ['config', key, value])
    await fs.writeFile(path.join(repo, '文件.txt'), 'base\n')
    await fixture.git(repo, ['add', '.'])
    await fixture.git(repo, ['commit', '-m', '/home/message-must-not-change'])
    const connect = () =>
      new WslClient(
        spawn(process.execPath, [path.join(__dirname, '../electron/wsl-worker.cjs'), data], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )
    let client = connect()
    t.after(() => client.close())
    await assert.rejects(client.request('snapshot', [repo]), /信任/)
    const challenge = await client.request('repository-trust', [repo])
    assert.equal(challenge.trusted, false)
    await client.request('repository-trust-approve', [repo, challenge.token])
    const initial = await client.request('snapshot', [repo])
    assert.equal(initial.branch, 'test/base')
    assert.equal(initial.commits[0].subject, '/home/message-must-not-change')
    await fs.writeFile(path.join(repo, '文件.txt'), 'working\n')
    let snapshot = await client.request('snapshot', [repo])
    assert.equal(snapshot.unstaged.length, 1)
    const context = () => ({
      expectedHead: snapshot.head,
      expectedBranch: snapshot.branch,
      stashSignature: snapshot.stashSignature,
    })
    const stash = await client.request('action', [
      repo,
      { action: 'stash-create', ...context(), message: '', includeUntracked: true },
    ])
    assert.equal(stash.outcome, 'succeeded', JSON.stringify(stash))
    snapshot = stash.snapshot
    assert.equal(snapshot.stashes.length, 1)
    const console = await client.request('git-console', [repo, { action: 'read' }])
    assert.ok(
      console.entries.some((entry) => entry.kind === 'start' && entry.text.includes('stash')),
    )
    assert.ok(
      console.entries.some((entry) => entry.kind === 'finish' && entry.state === 'succeeded'),
    )
    assert.ok(
      console.entries.every((entry) => entry.repo === repo && entry.operationId && entry.commandId),
    )
    assert.equal(console.running.length, 0)
    const entry = snapshot.stashes[0]
    const restored = await client.request('action', [
      repo,
      {
        action: 'stash-pop',
        ...context(),
        stashOid: entry.oid,
        stashRef: entry.ref,
        restoreIndex: true,
      },
    ])
    assert.equal(restored.outcome, 'succeeded', JSON.stringify(restored))
    assert.equal(await fs.readFile(path.join(repo, '文件.txt'), 'utf8'), 'working\n')
    const watch = await client.request('repository-changes', [repo])
    assert.ok(watch.revision)
    const diff = await client.request('diff', [repo, '文件.txt', false, null])
    assert.match(diff.diff, /working/)
    const logs = await client.request('operation-log', [{ scope: 'repository', repo }])
    assert.ok(logs.records.length >= 2)
    await assert.rejects(client.request('shell.execute', ['rm -rf /']), /不支持/)
    await client.close()
    client = connect()
    const persisted = await client.request('repository-trust', [repo])
    assert.equal(persisted.trusted, true)
    assert.equal((await client.request('snapshot', [repo])).head, initial.head)
  },
)
