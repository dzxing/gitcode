'use strict'
const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-history-tools-'))
  const g = new GitService({ dataDirectory: path.join(root, 'logs') })
  let repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  const git = (...args) => g.git(repo, args)
  await git('init', '-b', 'qa/base')
  repo = await g.repository(repo)
  for (const [k, v] of [
    ['user.name', 'History QA'],
    ['user.email', 'history@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git('config', k, v)
  await fs.writeFile(path.join(repo, 'old.txt'), 'first\nsecond\nthird\n')
  await git('add', '.')
  await git('commit', '-m', 'initial file')
  const first = (await git('rev-parse', 'HEAD')).trim()
  await git('mv', 'old.txt', 'new.txt')
  await git('commit', '-m', 'rename file')
  await fs.appendFile(path.join(repo, 'new.txt'), 'fourth\n')
  await git('add', '.')
  await git('commit', '-m', 'extend file')
  const head = (await git('rev-parse', 'HEAD')).trim()
  const read = (request) => g.historyTools.read(repo, request)
  t.after(async () => {
    await g.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { repo, g, git, read, head, first }
}
test('file history follows renames and comparisons use historical paths without writing', async (t) => {
  const f = await fixture(t)
  const result = await f.read({ kind: 'file', path: 'new.txt', revision: f.head })
  assert.deepEqual(
    result.commits.map((c) => c.subject),
    ['extend file', 'rename file', 'initial file'],
  )
  assert.equal(result.commits[1].oldPath, 'old.txt')
  assert.equal(result.commits[2].path, 'old.txt')
  assert.equal(result.nextOffset, null)
  const diff = await f.read({
    kind: 'diff',
    revision: f.head,
    base: f.first,
    path: 'new.txt',
    oldPath: 'old.txt',
  })
  assert.match(diff.diff, /\+fourth/)
  assert.equal((await f.git('status', '--porcelain')).trim(), '')
})
test('three versions distinguish HEAD, index, working file, missing versions and reject traversal', async (t) => {
  const f = await fixture(t),
    file = path.join(f.repo, 'new.txt')
  await fs.appendFile(file, 'staged\n')
  await f.git('add', 'new.txt')
  await fs.appendFile(file, 'unstaged\n')
  const result = await f.read({ kind: 'three', path: 'new.txt' })
  assert.doesNotMatch(result.versions[0].text, /staged/)
  assert.match(result.versions[1].text, /staged/)
  assert.doesNotMatch(result.versions[1].text, /unstaged/)
  assert.match(result.versions[2].text, /unstaged/)
  await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'local only')
  const added = await f.read({ kind: 'three', path: 'untracked.txt' })
  assert.deepEqual(
    added.versions.map((v) => v.exists),
    [false, false, true],
  )
  await assert.rejects(f.read({ kind: 'three', path: '../outside' }), /路径/)
  const expected = await f.git('status', '--porcelain')
  await f.read({ kind: 'three', path: 'new.txt' })
  assert.equal(await f.git('status', '--porcelain'), expected)
})
test('history query reads beyond first page and keeps actual parents under path filters', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 3; i++) await f.git('commit', '--allow-empty', '-m', `unrelated ${i}`)
  const snapshot = await f.g.snapshot(f.repo)
  const query = (request) => f.read({ kind: 'query', token: snapshot.history.token, ...request })
  const result = await query({ query: 'initial file' })
  assert.equal(result.commits[0].hash, f.first)
  const byPath = await query({ path: 'new.txt', author: 'History QA' })
  for (const commit of byPath.commits)
    assert.deepEqual(
      commit.parents,
      (await f.git('show', '-s', '--format=%P', commit.hash)).trim().split(' ').filter(Boolean),
    )
  assert.equal((await query({ query: 'not-present' })).commits.length, 0)
  await assert.rejects(query({ token: 'expired' }), /过期/)
  await assert.rejects(query({ path: '../outside' }), /路径/)
  await assert.rejects(query({ since: 'invalid' }), /日期/)
})

test('cancels only superseded queries, including queued reads, without cancelling foreground Git', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.g.snapshot(f.repo)
  let release
  const blocked = f.g.job(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  const request = {
    kind: 'query',
    scope: 'query-test',
    token: snapshot.history.token,
    query: 'initial',
  }
  const first = f.g.historyTools.request(f.repo, request)
  const cancelled = assert.rejects(first, /取消/)
  const second = f.g.historyTools.request(f.repo, { ...request, query: 'extend' })
  release()
  await blocked
  await cancelled
  assert.equal((await second).commits[0].subject, 'extend file')
  assert.equal((await f.git('rev-parse', 'HEAD')).trim(), f.head)
})
test('three-version read rejects concurrent file changes and handles binary/missing files', async (t) => {
  const f = await fixture(t)
  const original = f.g.merge.blob.bind(f.g.merge)
  let changed = false
  f.g.merge.blob = async (...args) => {
    const result = await original(...args)
    if (!changed) {
      changed = true
      await fs.appendFile(path.join(f.repo, 'new.txt'), 'concurrent\n')
    }
    return result
  }
  await assert.rejects(f.read({ kind: 'three', path: 'new.txt' }), /已变化/)
  f.g.merge.blob = original
  await fs.writeFile(path.join(f.repo, 'binary.bin'), Buffer.from([1, 0, 2]))
  assert.equal((await f.read({ kind: 'three', path: 'binary.bin' })).versions[2].binary, true)
  await fs.unlink(path.join(f.repo, 'new.txt'))
  assert.deepEqual(
    (await f.read({ kind: 'three', path: 'new.txt' })).versions.map((v) => v.exists),
    [true, true, false],
  )
})
test('file history pages continue across renames and global search escapes SHA focus', async (t) => {
  const f = await fixture(t)
  let input = ''
  for (let i = 1; i <= 110; i++) {
    const message = 'file version ' + i
    const contents = 'line ' + i + '\n'
    input += `commit refs/heads/qa/base\nmark :${i}\ncommitter QA <qa@example.test> ${1800000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i === 1 ? f.head : ':' + (i - 1)}\nM 100644 inline new.txt\ndata ${Buffer.byteLength(contents)}\n${contents}\n`
  }
  await f.g.git(f.repo, ['fast-import', '--quiet'], { input })
  await f.git('reset', '--hard', 'qa/base')
  const head = (await f.git('rev-parse', 'HEAD')).trim()
  const first = await f.read({ kind: 'file', path: 'new.txt', revision: head })
  assert.equal(first.commits.length, 100)
  const second = await f.read({
    kind: 'file',
    path: 'new.txt',
    revision: head,
    offset: first.nextOffset,
  })
  assert.equal(second.commits.at(-1).path, 'old.txt')
  assert.equal(new Set([...first.commits, ...second.commits].map((c) => c.hash)).size, 113)
  const snap = await f.g.snapshot(f.repo)
  const focused = await f.g.history.read(f.repo, { token: snap.history.token, sha: f.first })
  const result = await f.read({
    kind: 'query',
    token: focused.history.token,
    query: 'file version 110',
  })
  assert.equal(result.commits[0].hash, head)
})
test('compare local reads actual untracked file content, not its index deletion', async (t) => {
  const f = await fixture(t)
  await f.git('rm', '--cached', 'new.txt')
  await fs.appendFile(path.join(f.repo, 'new.txt'), 'untracked local\n')
  const result = await f.read({ kind: 'diff', path: 'new.txt', revision: f.head, local: true })
  assert.match(result.diff, /\+untracked local/)
  assert.doesNotMatch(result.diff, /gitcode-file-history-/)
})
