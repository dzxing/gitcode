const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { OperationLog, redact } = require('../electron/operation-log.cjs')
const { GitService } = require('../electron/git.cjs')
const query = (repo, id) => ({ scope: 'repository', repo, ...(id ? { id } : {}) })

test('journal isolates repositories, redacts credentials, and includes diagnostics only on request', () => {
  const log = new OperationLog()
  const record = log.start('push', '/one', { target: 'feature/qa' })
  log.command(
    record,
    [
      '-c',
      'http.extraheader=Authorization: Bearer secret-header',
      'push',
      'https://name:secret@example.com/repo?token=secret-query',
    ],
    { code: 1, stderr: 'token=secret-value\npassword=other-secret' },
    31,
  )
  log.finish(record, {
    outcome: 'failed',
    error: 'https://name:secret@example.com/repo?auth=abc',
    output: 'glpat-verySecretToken',
  })
  assert.equal(log.read(query('/two')).records.length, 0)
  assert.equal(log.read(query('/one')).records[0].output, '')
  assert.equal(log.read(query('/one', record.id)).records[0].commands, '')
  log.preferences({ autoFetchInterval: 1, extended: true })
  const data = JSON.stringify(log.read(query('/one', record.id)))
  for (const secret of [
    'secret-header',
    'secret-query',
    'secret-value',
    'other-secret',
    'verySecretToken',
    'name:secret',
  ])
    assert.ok(!data.includes(secret), secret)
  assert.match(data, /退出码/)
  assert.match(redact('Authorization: Basic abc\npassword=xyz'), /已隐藏/)
})

test('journal persists, recovers interrupted operations, and separates application settings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-journal-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const log = new OperationLog({ directory: dir })
  log.start('push', '/one')
  log.preferences({ autoFetchInterval: 0, extended: true })
  await log.writes
  const restored = new OperationLog({ directory: dir })
  assert.equal(restored.settings.autoFetchInterval, 0)
  assert.equal(restored.read(query('/one')).records[0].state, 'unknown')
  assert.equal(restored.read({ scope: 'application' }).records[0].operation, 'activity-settings')
  assert.throws(() => restored.preferences({ autoFetchInterval: -1, extended: false }))
  assert.throws(() => restored.preferences({ autoFetchInterval: 1.5, extended: false }))
  assert.throws(() => restored.preferences({ autoFetchInterval: 61, extended: false }))
})

test('journal enforces count, age and byte limits; clear keeps live records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-log-limit-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let now = 1000000000
  const log = new OperationLog({ directory: dir, now: () => now, limit: 3, bytes: 6000 })
  for (let i = 0; i < 6; i++) {
    const r = log.start('stage', '/one')
    log.finish(r, { output: 'a'.repeat(3000) })
  }
  await log.writes
  assert.ok((await fs.stat(path.join(dir, 'activity.json'))).size <= 6000)
  assert.ok(log.records.length <= 3)
  now += 8 * 86400000
  assert.equal(log.read(query('/one')).records.length, 0)
  const live = log.start('pull', '/one')
  const done = log.start('fetch', '/one')
  log.finish(done)
  log.clear(query('/one'))
  assert.equal(log.records.length, 1)
  assert.equal(log.records[0].id, live.id)
  await log.writes
})

test('failed fetch preserves last successful timestamps and tracks authentication per remote', () => {
  let now = 100
  const log = new OperationLog({ now: () => now })
  log.updateFetch('/one', { outcome: 'succeeded', steps: [{ remote: 'origin', ok: true }] })
  now = 200
  log.updateFetch(
    '/one',
    {
      outcome: 'partial',
      error: 'backup failed',
      steps: [
        { remote: 'origin', ok: true },
        { remote: 'backup', ok: false, message: 'Authentication failed' },
      ],
    },
    { backup: 'config-hash' },
  )
  const status = log.status('/one')
  assert.equal(status.lastSuccess, 100)
  assert.equal(status.remotes.origin.lastSuccess, 200)
  assert.equal(status.remotes.backup.paused, true)
  now = 300
  log.updateFetch('/one', { outcome: 'succeeded', steps: [{ remote: 'backup', ok: true }] })
  assert.equal(log.status('/one').remotes.backup.paused, false)
  assert.equal(log.status('/one').error, '')
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-auto-fetch-'))
  const log = new OperationLog()
  const git = new GitService({ journal: log })
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const repo = path.join(root, 'local'),
    remote = path.join(root, 'remote.git')
  await fs.mkdir(repo)
  await git.git(repo, ['init', '-b', 'qa/auto'])
  await git.git(repo, ['config', 'user.name', 'GitCode QA'])
  await git.git(repo, ['config', 'user.email', 'qa@example.com'])
  await git.git(repo, ['config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(repo, 'qa.txt'), 'base\n')
  await git.git(repo, ['add', 'qa.txt'])
  await git.git(repo, ['commit', '-m', 'QA base'])
  await git.git(root, ['init', '--bare', remote])
  await git.git(repo, ['remote', 'add', 'origin', remote])
  await git.git(repo, ['push', '-u', 'origin', 'qa/auto'])
  return { root, repo: await git.repository(repo), remote, git, log }
}

test('real automatic Fetch updates remote refs but preserves HEAD, index, worktree and FETCH_HEAD', async (t) => {
  const { repo, remote, git, log } = await fixture(t)
  const head = await git.head(repo)
  await git.git(repo, ['update-ref', 'refs/remotes/origin/deleted-on-server', head])
  await fs.writeFile(path.join(repo, '.git', 'FETCH_HEAD'), 'sentinel\n')
  await fs.writeFile(path.join(repo, 'qa.txt'), 'uncommitted\n')
  const index = await git.indexFingerprint(repo)
  const tree = (await git.git(remote, ['rev-parse', `${head}^{tree}`])).trim()
  const incoming = (
    await git.git(remote, [
      '-c',
      'user.name=QA',
      '-c',
      'user.email=qa@example.com',
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'QA remote update',
    ])
  ).trim()
  await git.git(remote, ['update-ref', 'refs/heads/qa/auto', incoming, head])
  assert.equal((await git.git(repo, ['rev-parse', 'refs/remotes/origin/qa/auto'])).trim(), head)
  const result = await git.automaticFetch(repo)
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.ok(!result.snapshot.branches.some((branch) => branch.name === 'origin/deleted-on-server'))
  assert.equal(await git.head(repo), head)
  assert.equal((await git.git(repo, ['rev-parse', 'refs/remotes/origin/qa/auto'])).trim(), incoming)
  assert.equal(await git.indexFingerprint(repo), index)
  assert.equal(await fs.readFile(path.join(repo, 'qa.txt'), 'utf8'), 'uncommitted\n')
  assert.equal(await fs.readFile(path.join(repo, '.git', 'FETCH_HEAD'), 'utf8'), 'sentinel\n')
  assert.ok(result.status.remotes.origin.lastSuccess > 0)
  assert.equal(log.read(query(repo)).records.length, 0) // quiet success
  log.preferences({ autoFetchInterval: 1, extended: true })
  const records = log.read(query(repo)).records
  assert.equal(records.length, 1)
  assert.equal(records[0].background, true)
  assert.equal((await git.automaticFetch(repo)).skipped, true)
})

test('zero interval, foreground queue, and duplicate calls skip without extra fetches', async (t) => {
  const { git, repo, log } = await fixture(t)
  log.preferences({ autoFetchInterval: 0, extended: false })
  assert.equal((await git.automaticFetch(repo)).skipped, true)
  log.preferences({ autoFetchInterval: 1, extended: false })
  let release
  const pending = git.job(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  assert.equal((await git.automaticFetch(repo)).skipped, true)
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await pending
  const [a, b] = await Promise.all([git.automaticFetch(repo), git.automaticFetch(repo)])
  assert.equal([a, b].filter((r) => r.skipped === false).length, 1)
  assert.equal(log.records.filter((r) => r.background).length, 1)
})

test('foreground job interrupts only the automatic-fetch controller and still runs', async (t) => {
  const { git, repo, log } = await fixture(t)
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  git.sync.execute = async (_repo, _request, signal) => {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  }
  const background = git.automaticFetch(repo)
  await ready
  let foregroundAborted
  const foreground = git.job((signal) => {
    foregroundAborted = signal.aborted
    return 'foreground'
  })
  assert.equal((await background).outcome, 'cancelled')
  assert.equal(await foreground, 'foreground')
  assert.equal(foregroundAborted, false)
  assert.equal(log.records.find((r) => r.background).state, 'cancelled')
})

test('tracked mutation records partial refresh failure with one correlated ID', async (t) => {
  const { git, repo, log } = await fixture(t)
  const context = {
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
  }
  await fs.writeFile(path.join(repo, 'qa.txt'), 'modified before staging\n')
  const original = git.snapshot
  git.snapshot = async () => {
    throw Error('refresh unavailable')
  }
  const result = await git.job((signal) =>
    git.action(repo, { action: 'stage', paths: ['qa.txt'], ...context }, signal),
  )
  git.snapshot = original
  assert.ok(result.logId)
  const record = log.read(query(repo, result.logId)).records[0]
  assert.match(record.message, /刷新失败/)
  assert.equal(record.id, result.logId)
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(record.state, 'partial')
})

test('authentication failure pauses only that remote until config changes or a manual success', async (t) => {
  const { git, repo, remote, log } = await fixture(t)
  let time = Date.now()
  log.now = () => time
  const original = git.sync.execute.bind(git.sync)
  let attempts = 0
  git.sync.execute = async (_repo, request) => {
    attempts++
    git.sync.plans.delete(request.planId)
    return {
      outcome: 'failed',
      error: 'Authentication failed',
      steps: [{ remote: 'origin', ok: false, message: 'Authentication failed' }],
    }
  }
  assert.equal((await git.automaticFetch(repo)).outcome, 'failed')
  assert.equal(log.status(repo).remotes.origin.paused, true)
  time += 61000
  assert.equal((await git.automaticFetch(repo)).skipped, true)
  assert.equal(attempts, 1)
  await git.git(repo, [
    'remote',
    'set-url',
    'origin',
    require('node:url').pathToFileURL(remote).href,
  ])
  time += 61000
  await git.automaticFetch(repo)
  assert.equal(attempts, 2)
  git.sync.execute = original
  const plan = await git.sync.plan(repo, 'fetch', {
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
  })
  const manual = await git.job((signal) =>
    git.action(repo, { action: 'fetch', planId: plan.id }, signal),
  )
  assert.equal(manual.outcome, 'succeeded')
  assert.equal(log.status(repo).remotes.origin.paused, false)
})

test('real partial Fetch retains successful remote state and retries after network-style failure', async (t) => {
  const { git, repo, root, log } = await fixture(t)
  await git.git(repo, ['remote', 'add', 'backup', path.join(root, 'missing.git')])
  const first = await git.automaticFetch(repo)
  assert.equal(first.outcome, 'partial')
  assert.ok(first.status.remotes.origin.lastSuccess > 0)
  assert.equal(first.status.remotes.backup.lastSuccess, 0)
  assert.equal(first.status.remotes.backup.paused, false)
  assert.ok(first.status.error)
  let time = Date.now() + 61000
  log.now = () => time
  await git.git(repo, ['remote', 'remove', 'backup'])
  const retry = await git.automaticFetch(repo)
  assert.equal(retry.outcome, 'succeeded')
  assert.equal(retry.status.error, '')
})

test('log status supports unusual valid remote names without prototype mutation', () => {
  const log = new OperationLog()
  log.updateFetch('/one', { outcome: 'succeeded', steps: [{ remote: '__proto__', ok: true }] })
  assert.equal(Object.hasOwn(log.status('/one').remotes, '__proto__'), true)
  assert.ok(log.status('/one').remotes.__proto__.lastSuccess)
})

test('repeated background failures are grouped while changed failures remain separate', () => {
  const log = new OperationLog()
  for (let i = 0; i < 3; i++) {
    const entry = log.start('fetch', '/qa', { background: true })
    log.finish(entry, { outcome: 'failed', error: 'network unavailable' })
  }
  const records = log.read(query('/qa')).records
  assert.equal(records.length, 1)
  assert.equal(records[0].repeatCount, 3)
  const next = log.start('fetch', '/qa', { background: true })
  log.finish(next, { outcome: 'failed', error: 'authentication failed' })
  assert.equal(log.read(query('/qa')).records.length, 2)
})

test('storage failure does not turn a completed Git operation into a failed mutation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-log-storage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const blocked = path.join(root, 'file-not-directory')
  await fs.writeFile(blocked, 'QA')
  const log = new OperationLog({ directory: blocked })
  const git = new GitService({ journal: log })
  const result = await git.recordOperation('commit', '/qa', async () => ({
    outcome: 'succeeded',
    output: 'committed',
  }))
  await log.writes
  assert.equal(result.outcome, 'succeeded')
  assert.equal(log.read(query('/qa')).records[0].state, 'succeeded')
  assert.match(log.read(query('/qa')).storageError, /无法保存/)
  await git.shutdown()
})

test('shared browser sessions coalesce automatic fetching and a foreground job can interrupt it', async (t) => {
  const { git, repo, log } = await fixture(t)
  const second = new GitService({ journal: log })
  t.after(() => second.shutdown())
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  git.sync.execute = async (_repo, _request, signal) => {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  }
  const background = git.automaticFetch(repo)
  await ready
  assert.equal((await second.automaticFetch(repo)).skipped, true)
  assert.equal(await second.job(() => 'foreground'), 'foreground')
  assert.equal((await background).outcome, 'cancelled')
})

test('background SSH puts non-interactive options before user options and preserves the executable', () => {
  const { quietSsh } = require('../electron/auto-fetch.cjs')
  assert.equal(
    quietSsh('ssh -o BatchMode=no -F custom.conf'),
    'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o BatchMode=no -F custom.conf',
  )
  assert.equal(
    quietSsh('"C:\\Program Files\\OpenSSH\\ssh.exe" -T'),
    '"C:\\Program Files\\OpenSSH\\ssh.exe" -o BatchMode=yes -o StrictHostKeyChecking=yes -T',
  )
  assert.equal(quietSsh('plink.exe -batch'), null)
})

test('a foreground job arriving before the automatic job starts wins without starting a network fetch', async (t) => {
  const { git, repo, log } = await fixture(t)
  const other = new GitService({ journal: log })
  t.after(() => other.shutdown())
  for (const foregroundService of [git, other]) {
    const events = []
    git.sync.execute = async () => {
      events.push('background network fetch')
      return { outcome: 'succeeded', output: '', steps: [] }
    }
    const background = git.automaticFetch(repo)
    const foreground = foregroundService.job(() => {
      events.push('foreground')
      return 'done'
    })
    await Promise.all([background, foreground])
    assert.deepEqual(events, ['foreground'])
  }
})

test('a successful automatic Fetch followed by refresh failure exposes partial outcome and a status warning', async (t) => {
  const { git, repo, log } = await fixture(t)
  git.snapshot = async () => {
    throw new Error('QA snapshot refresh failed')
  }
  const result = await git.automaticFetch(repo)
  assert.equal(result.outcome, 'partial')
  assert.match(result.status.error, /刷新/)
  assert.ok(result.status.lastSuccess > 0, 'actual successful fetch time must remain available')
  const record = log.read(query(repo)).records[0]
  assert.equal(record.state, 'partial')
  assert.match(record.message, /QA snapshot refresh failed/)
})

test('foreground cancellation during automatic snapshot refresh does not surface a false refresh error', async (t) => {
  const { git, repo } = await fixture(t)
  let started
  const refreshing = new Promise((resolve) => {
    started = resolve
  })
  git.snapshot = async (_repo, signal) => {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  }
  const background = git.automaticFetch(repo)
  await refreshing
  await git.job(() => 'foreground completed')
  const result = await background
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.status.error, '')
  assert.ok(result.status.lastSuccess > 0)
})

test('fetch logs keep redacted per-remote detail once and do not merge different failures', () => {
  const log = new OperationLog()
  const raw =
    'fatal: https://user:password@example.test/repo?token=private does not appear to be a git repository'
  const record = log.start('fetch', '/qa', { background: true })
  log.finish(record, {
    outcome: 'partial',
    error: raw,
    steps: [
      { remote: 'origin', ok: true },
      { remote: 'backup', ok: false, message: raw },
    ],
  })
  const metadata = log.read(query('/qa')).records[0]
  assert.equal(metadata.steps, undefined)
  assert.equal(metadata.detailLoaded, false)
  const detail = log.read(query('/qa', record.id)).records[0]
  assert.equal(detail.message, '')
  assert.equal(detail.output, '')
  assert.equal(detail.steps.length, 2)
  assert.match(detail.steps[1].message, /已隐藏/)
  assert.ok(!JSON.stringify(detail).includes('token=private'))
  const changed = log.start('fetch', '/qa', { background: true })
  log.finish(changed, {
    outcome: 'partial',
    error: 'Connection refused',
    steps: [
      { remote: 'origin', ok: true },
      { remote: 'backup', ok: false, message: 'Connection refused' },
    ],
  })
  assert.equal(log.read(query('/qa')).records.length, 2)
})

test('a grouped fetch error remains recent after many normal operations and uses its last occurrence for retention', () => {
  let now = 1000000000
  const log = new OperationLog({ now: () => now })
  const failure = log.start('fetch', '/qa', { background: true })
  log.finish(failure, { outcome: 'failed', error: 'QA network error' })
  for (let i = 0; i < 510; i++) {
    now++
    const record = log.start('stage', '/qa')
    log.finish(record)
  }
  assert.equal(
    log.read(query('/qa')).records.some((record) => record.id === failure.id),
    false,
  )
  const focused = log.read({ ...query('/qa'), focus: 'fetch-failure' })
  assert.equal(focused.records.length, 500)
  assert.equal(focused.records.find((record) => record.id === failure.id).detailLoaded, true)
  assert.equal(
    log.read(query('/qa', failure.id)).records.find((record) => record.id === failure.id).message,
    'QA network error',
  )
  now += 6 * 86400000
  const repeat = log.start('fetch', '/qa', { background: true })
  log.finish(repeat, { outcome: 'failed', error: 'QA network error' })
  assert.equal(log.read(query('/qa')).records[0].id, failure.id)
  assert.equal(log.read(query('/qa')).records[0].repeatCount, 2)
  now += 2 * 86400000
  assert.equal(log.read(query('/qa')).records[0].id, failure.id)
})
