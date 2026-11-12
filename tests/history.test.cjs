'use strict'
const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-history-'))
  const g = new GitService({ dataDirectory: path.join(root, 'logs') })
  const repo = path.join(root, 'app')
  await fs.mkdir(repo)
  const git = (...args) => g.git(repo, args)
  await git('init', '-b', 'qa/base')
  for (const [k, v] of [
    ['user.name', 'History QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git('config', k, v)
  // One fast-import process creates deterministic, distinct commit dates.
  let data = ''
  for (let i = 1; i <= 620; i++)
    data += `commit refs/heads/qa/base\nmark :${i}\ncommitter QA <qa@example.test> ${1700000000 + i} +0000\ndata ${Buffer.byteLength('commit ' + i)}\ncommit ${i}\n${i > 1 ? 'from :' + (i - 1) + '\n' : ''}\n`
  await g.git(repo, ['fast-import', '--quiet'], { input: data })
  await git('reset', '--hard', 'qa/base')
  t.after(async () => {
    await g.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { repo, g, git }
}
test('fixed-tip pages concatenate exactly once in Git date order, even after refs advance', async (t) => {
  const f = await fixture(t),
    s = await f.g.snapshot(f.repo)
  assert.equal(s.commits.length, 250)
  assert.equal(s.total, 620)
  assert.equal(s.history.nextOffset, 250)
  const reference = (await f.git('log', '--date-order', '--format=%H', s.head, '--'))
    .trim()
    .split('\n')
  await f.git('commit', '--allow-empty', '-m', 'new tip')
  const second = await f.g.history.read(f.repo, { token: s.history.token, offset: 250 })
  const last = await f.g.history.read(f.repo, { token: s.history.token, offset: 500 })
  const hashes = [...s.commits, ...second.commits, ...last.commits].map((c) => c.hash)
  assert.deepEqual(hashes, reference)
  assert.equal(new Set(hashes).size, 620)
  assert.equal(last.history.nextOffset, null)
  assert.deepEqual(
    (await f.g.history.read(f.repo, { token: s.history.token, offset: 250 })).commits,
    second.commits,
  )
  const fresh = await f.g.snapshot(f.repo)
  assert.notEqual(fresh.history.signature, s.history.signature)
  assert.equal(fresh.total, 621)
})
test('SHA location finds older commits, continues ancestors and can locate another tip from focus', async (t) => {
  const f = await fixture(t),
    s = await f.g.snapshot(f.repo)
  const old = (await f.git('rev-parse', 'HEAD~400')).trim()
  const found = await f.g.history.read(f.repo, { token: s.history.token, sha: old.slice(0, 12) })
  assert.equal(found.commits[0].hash, old)
  assert.equal(found.history.focus, old)
  assert.equal(found.history.total, 220)
  assert.equal(found.history.basis, s.history.signature)
  const other = await f.g.history.read(f.repo, { token: found.history.token, sha: s.head })
  assert.equal(other.commits[0].hash, s.head)
  await assert.rejects(
    f.g.history.read(f.repo, { token: s.history.token, sha: 'HEAD~5' }),
    /十六进制/,
  )
})
test('tokens are repository-bound, offsets validated, and unreachable lookups do not replace history', async (t) => {
  const f = await fixture(t),
    s = await f.g.snapshot(f.repo)
  await assert.rejects(
    f.g.history.read(path.dirname(f.repo), { token: s.history.token, offset: 250 }),
    /过期/,
  )
  await assert.rejects(f.g.history.read(f.repo, { token: s.history.token, offset: -1 }), /分页/)
  await assert.rejects(f.g.history.read(f.repo, { token: s.history.token, offset: 621 }), /分页/)
  const tree = (await f.git('rev-parse', 'HEAD^{tree}')).trim()
  const unreachable = (
    await f.g.git(f.repo, ['commit-tree', tree], { input: 'unreachable\n' })
  ).trim()
  await assert.rejects(
    f.g.history.read(f.repo, { token: s.history.token, sha: unreachable }),
    /不在当前历史/,
  )
  f.g.history.frames.get(s.history.token).touched = 0
  await assert.rejects(f.g.history.read(f.repo, { token: s.history.token, offset: 250 }), /过期/)
})
test('only branch, remote, tag and detached HEAD commits count; blob tags do not break paging', async (t) => {
  const f = await fixture(t)
  const blob = (await f.g.git(f.repo, ['hash-object', '-w', '--stdin'], { input: 'blob\n' })).trim()
  await f.git('tag', 'blob-tag', blob)
  await f.git('tag', '-a', 'old-tag', 'HEAD~500', '-m', 'annotated')
  await f.git('notes', 'add', '-m', 'a note')
  const s = await f.g.snapshot(f.repo)
  assert.equal(s.total, 620)
  assert.ok(!s.commits.some((c) => c.hash === blob))
  await f.git('switch', '--detach', 'HEAD~3')
  const detached = await f.g.snapshot(f.repo)
  assert.equal(detached.total, s.total)
  assert.equal(detached.head, (await f.git('rev-parse', 'HEAD')).trim())
})

test('arrow tooltip metadata reads one immutable summary, caches it and never changes the history frame', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.g.snapshot(f.repo)
  const sha = (await f.git('rev-parse', 'HEAD~400')).trim()
  const frames = f.g.history.frames.size
  const before = JSON.stringify(snapshot.history)
  const original = f.g.git.bind(f.g)
  const calls = []
  f.g.git = (...args) => {
    calls.push(args[1])
    return original(...args)
  }
  const first = await f.g.history.metadata(f.repo, sha)
  first.subject = 'caller mutation'
  const second = await f.g.history.metadata(f.repo, sha)
  assert.equal(second.hash, sha)
  assert.equal(second.subject, 'commit 220')
  assert.equal(second.author, 'QA')
  assert.ok(!Number.isNaN(Date.parse(second.date)))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 3), ['show', '-s', '--no-show-signature'])
  assert.equal(f.g.history.frames.size, frames)
  assert.equal(JSON.stringify(snapshot.history), before)
  await assert.rejects(f.g.history.metadata(f.repo, '--all'), /对象 ID/)
  assert.equal(calls.length, 1)
})
