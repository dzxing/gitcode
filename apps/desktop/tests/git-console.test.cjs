const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')
const { GitConsole } = require('../electron/git-console.cjs')
const { GitService } = require('../electron/git.cjs')
const { dispatch } = require('../electron/local-core.cjs')

const read = (log, repo = '/one', extra = {}) => log.read(repo, { action: 'read', ...extra })
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await delay(30)
  }
  throw Error('Timed out waiting for real Git output')
}
test('console separates repository, operation, command, epoch and cursor without duplicate replay', () => {
  const log = new GitConsole()
  const first = log.start('/one', 'op1', '/usr/bin/git', ['fetch', 'origin'])
  const second = log.start('/two', 'op2', 'git', ['push'])
  first.write('stderr', Buffer.from('Receiving 10%\rReceiving 20%\r'))
  second.write('stdout', Buffer.from('second only\n'))
  const snapshot = read(log)
  assert.ok(snapshot.entries.every((e) => e.repo === '/one' && e.operationId === 'op1'))
  assert.equal(new Set(snapshot.entries.map((e) => e.commandId)).size, 1)
  assert.equal(snapshot.running.length, 1)
  assert.equal(snapshot.entries.length, 3)
  first.finish({ code: 0 })
  const next = read(log, '/one', snapshot)
  assert.equal(next.entries.length, 1)
  assert.equal(next.entries[0].kind, 'finish')
  assert.equal(next.running.length, 0)
  assert.equal(read(log, '/one', next).entries.length, 0)
  const restarted = read(new GitConsole(), '/one', next)
  assert.equal(restarted.reset, true)
  assert.equal(restarted.cursor, 0)
  second.finish({ code: 1 })
})
test('console redacts split credentials, protects commit messages and keeps UTF-8 intact', () => {
  const log = new GitConsole()
  const command = log.start('/one', 'op', 'git', [
    'commit',
    '-m',
    'private message',
    'https://user:pass@host/repo?token=value',
  ])
  const output = Buffer.from(
    '中文输出\nAuthorization: Bearer a-very-secret\npassword=private-password\n',
  )
  for (const byte of output) command.write('stdout', Buffer.from([byte]))
  command.finish({ code: 0 })
  const data = JSON.stringify(read(log))
  for (const secret of [
    'private message',
    'user:pass',
    'token=value',
    'a-very-secret',
    'private-password',
  ])
    assert.ok(!data.includes(secret), secret)
  assert.match(data, /中文输出/)
  assert.match(data, /已隐藏/)
})
test('console bounds memory, paginates, signals dropped output and tail does not stop a command', () => {
  const log = new GitConsole({ bytes: 100000, limit: 800 })
  const command = log.start('/one', 'op', 'git', ['fetch'])
  const initial = read(log)
  for (let i = 0; i < 1000; i++) command.write('stdout', Buffer.from(`${i} ${'a'.repeat(100)}\n`))
  assert.ok(log.bytes <= 100000)
  const reply = read(log, '/one', initial)
  assert.equal(reply.dropped, true)
  assert.equal(reply.more, true)
  assert.equal(reply.entries.length, 256)
  const tail = log.read('/one', { action: 'tail' })
  assert.equal(tail.entries.length, 0)
  assert.equal(tail.running.length, 1)
  command.write('stdout', Buffer.from('after clear\n'))
  command.finish({ code: 0 })
  assert.deepEqual(
    read(log, '/one', { ...tail, action: 'read' }).entries.map((e) => e.kind),
    ['stdout', 'finish'],
  )
  assert.throws(() => log.read('/one', { action: 'read', cursor: -1 }))
  assert.throws(() => log.read('/one', { action: 'read', cursor: log.sequence + 1 }))
  assert.throws(() => log.read('relative', { action: 'read' }))
})
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-console-'))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  await git.git(root, ['init', '-b', 'qa/base'])
  await git.git(root, ['config', 'user.name', 'Console QA'])
  await git.git(root, ['config', 'user.email', 'console@example.test'])
  await git.git(root, ['config', 'commit.gpgsign', 'false'])
  const hooks = path.join(root, '.git', 'qa-hooks')
  await fs.mkdir(hooks)
  return { root, git, hooks }
}
test(
  'real Git streams before completion; queued mutations wait and hidden recording resumes by cursor',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, git, hooks } = await fixture(t)
    await fs.writeFile(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf "real stdout\\n"\nprintf "real stderr\\n" >&2\nwhile test ! -e .git/release; do sleep 0.05; done\n',
      { mode: 0o755 },
    )
    const job = git.job((signal) =>
      git.recordOperation('commit', root, () =>
        git.git(root, ['commit', '--allow-empty', '-m', 'private'], { signal, hooksPath: hooks }),
      ),
    )
    await until(() => git.console.entries.some(({ entry }) => entry.text === 'real stderr'))
    const before = await dispatch(git, 'git-console', [root, { action: 'read' }])
    assert.equal(before.running.length, 1)
    assert.ok(before.entries.some((e) => e.kind === 'start' && e.text.includes('commit')))
    assert.ok(!before.entries.some((e) => e.kind === 'finish'))
    let secondStarted = false
    const second = git.job(() => {
      secondStarted = true
    })
    await delay(100)
    assert.equal(secondStarted, false)
    const cleared = await dispatch(git, 'git-console', [root, { action: 'tail' }])
    assert.equal(cleared.running.length, 1)
    await fs.writeFile(path.join(root, '.git', 'release'), 'go')
    await job
    await second
    const after = read(git.console, root, before)
    assert.equal(after.running.length, 0)
    assert.ok(after.entries.some((e) => e.kind === 'finish' && e.state === 'succeeded'))
    assert.equal(read(git.console, '/unrelated').entries.length, 0)
    const journal = git.journal.read({ scope: 'repository', repo: root })
    assert.equal(journal.records.length, 1)
  },
)
test(
  'cancellation finishes only after process termination and releases the existing queue',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, git, hooks } = await fixture(t)
    await fs.writeFile(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf "waiting for cancellation\\n" >&2\nsleep 30\n',
      { mode: 0o755 },
    )
    const job = git.job((signal) =>
      git.recordOperation('commit', root, () =>
        git.git(root, ['commit', '--allow-empty', '-m', 'cancel'], { signal, hooksPath: hooks }),
      ),
    )
    const rejected = assert.rejects(job, /取消/)
    await until(() =>
      git.console.entries.some(({ entry }) => entry.text === 'waiting for cancellation'),
    )
    assert.equal(read(git.console, root).running.length, 1)
    git.cancel()
    await rejected
    const result = read(git.console, root)
    assert.equal(result.running.length, 0)
    assert.equal(result.entries.at(-1).state, 'cancelled')
    await git.job(() =>
      git.recordOperation('branch', root, () =>
        git.git(root, ['commit', '--allow-empty', '-m', 'after cancellation'], {
          hooksPath: '.no-hooks',
        }),
      ),
    )
    assert.equal(read(git.console, root).entries.at(-1).state, 'succeeded')
  },
)
test('background snapshot and commands outside user operations do not flood the console; errors settle once', async (t) => {
  const { root, git } = await fixture(t)
  await git.job((signal) => git.git(root, ['status', '--porcelain'], { signal }), {
    background: true,
  })
  assert.equal(read(git.console, root).entries.length, 0)
  await assert.rejects(
    git.job(() => git.recordOperation('qa', root, () => git.git(root, ['not-a-git-command']))),
  )
  const events = read(git.console, root).entries
  assert.equal(events.filter((e) => e.kind === 'start').length, 1)
  assert.equal(events.filter((e) => e.kind === 'finish').length, 1)
  assert.equal(events.at(-1).state, 'failed')
})
