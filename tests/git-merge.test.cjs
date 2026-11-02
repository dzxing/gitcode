const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, { conflict = true, deletion = false, binary = false } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-merge-test-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'test/local'])
  for (const [k, v] of [
    ['user.name', 'Merge Test'],
    ['user.email', 'merge@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', k, v])
  const write = (file, value) => fs.writeFile(path.join(repo, file), value),
    commit = async (message) => {
      await git.git(repo, ['add', '.'])
      await git.git(repo, ['commit', '-m', message])
      return git.head(repo)
    }
  await write('文件 with space.txt', binary ? Buffer.from([0, 1, 2]) : 'base\n')
  const base = await commit('base')
  await git.git(repo, ['switch', '-c', 'test/incoming'])
  if (deletion) await fs.unlink(path.join(repo, '文件 with space.txt'))
  else
    await write(
      conflict ? '文件 with space.txt' : 'incoming.txt',
      binary ? Buffer.from([0, 3, 4]) : 'incoming\n',
    )
  const incoming = await commit('incoming')
  await git.git(repo, ['switch', 'test/local'])
  await write('文件 with space.txt', binary ? Buffer.from([0, 5, 6]) : 'local\n')
  const local = await commit('local')
  const context = () => ({ expectedHead: local, expectedBranch: 'test/local' }),
    act = async (action, extra = {}) =>
      git.action(repo, {
        action,
        ...context(),
        mergeSignature: (await git.merge.state(repo))?.signature,
        ...extra,
      })
  return {
    repo,
    git,
    base,
    incoming,
    local,
    write,
    act,
    context,
    start: () => git.merge.start(repo, incoming),
  }
}
test('conflicted merge exposes real three-way versions; manual resolve stages only that path and finish preserves both parents', async (t) => {
  const f = await fixture(t),
    started = await f.start()
  assert.equal(started.outcome, 'partial')
  let state = await f.git.merge.state(f.repo)
  assert.equal(state.files.length, 1)
  assert.equal(state.incoming, f.incoming)
  let done = await f.act('merge-finish', { message: 'Too early' })
  assert.equal(done.outcome, 'failed')
  assert.match(done.error, /未解决/)
  const read = await f.git.merge.read(f.repo, '文件 with space.txt')
  assert.equal(read.file.base.text, 'base\n')
  assert.equal(read.file.ours.text, 'local\n')
  assert.equal(read.file.theirs.text, 'incoming\n')
  assert.equal(read.file.editable, true)
  const saved = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: 'combined\n',
  })
  assert.equal(saved.outcome, 'succeeded', saved.error)
  assert.equal(saved.snapshot.merge.files.length, 0)
  assert.equal(saved.snapshot.head, f.local)
  assert.equal(await fs.readFile(path.join(f.repo, read.file.path), 'utf8'), 'combined\n')
  done = await f.act('merge-finish', { message: 'Merge incoming updates' })
  assert.equal(done.outcome, 'succeeded', done.error)
  assert.equal(done.snapshot.merge, null)
  assert.deepEqual(
    (await f.git.git(f.repo, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '),
    [f.local, f.incoming],
  )
})
test('non-overlapping merge waits for explicit completion; abort restores pre-merge content and refs', async (t) => {
  const f = await fixture(t, { conflict: false })
  assert.equal((await f.start()).outcome, 'succeeded')
  assert.equal((await f.git.merge.state(f.repo)).files.length, 0)
  assert.equal(await f.git.head(f.repo), f.local)
  const result = await f.act('merge-abort')
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.merge, null)
  assert.equal(await f.git.head(f.repo), f.local)
  await assert.rejects(fs.stat(path.join(f.repo, 'incoming.txt')), /ENOENT/)
})
for (const choice of ['ours', 'theirs'])
  test(`whole-file ${choice} selects the actual indexed version`, async (t) => {
    const f = await fixture(t)
    await f.start()
    const read = await f.git.merge.read(f.repo, '文件 with space.txt')
    const result = await f.act('merge-resolve', {
      token: read.file.token,
      file: read.file.path,
      choice,
    })
    assert.equal(result.outcome, 'succeeded', result.error)
    assert.equal(
      await fs.readFile(path.join(f.repo, read.file.path), 'utf8'),
      choice === 'ours' ? 'local\n' : 'incoming\n',
    )
  })
test('external file edits invalidate resolve tokens without overwriting content', async (t) => {
  const f = await fixture(t)
  await f.start()
  const read = await f.git.merge.read(f.repo, '文件 with space.txt')
  await f.write(read.file.path, 'external editor\n')
  const result = await f.act('merge-resolve', {
    mergeSignature: read.state.signature,
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: 'overwrite\n',
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /状态已变化/)
  assert.equal(await fs.readFile(path.join(f.repo, read.file.path), 'utf8'), 'external editor\n')
})
test('external edits invalidate frozen abort confirmation', async (t) => {
  const f = await fixture(t)
  await f.start()
  const state = await f.git.merge.state(f.repo)
  await f.write('文件 with space.txt', 'keep edit\n')
  const result = await f.act('merge-abort', { mergeSignature: state.signature })
  assert.equal(result.outcome, 'failed')
  assert.equal(await fs.readFile(path.join(f.repo, '文件 with space.txt'), 'utf8'), 'keep edit\n')
  assert.ok(result.snapshot.merge.active)
})
test('conflict markers are rejected and ordinary commit/staging cannot bypass the merge workflow', async (t) => {
  const f = await fixture(t)
  await f.start()
  const read = await f.git.merge.read(f.repo, '文件 with space.txt')
  const result = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: read.file.working,
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /冲突标记/)
  for (const action of ['stage', 'commit']) {
    const result = await f.act(action, { paths: [read.file.path], message: 'bypass' })
    assert.equal(result.outcome, 'failed')
    assert.match(result.error, /未完成|冲突处理/)
  }
  const corrected = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: 'corrected\n',
  })
  assert.equal(corrected.outcome, 'succeeded', corrected.error)
})
test('delete/modify conflicts explicitly accept deletion', async (t) => {
  const f = await fixture(t, { deletion: true })
  await f.start()
  const read = await f.git.merge.read(f.repo, '文件 with space.txt')
  assert.equal(read.file.theirs.exists, false)
  const result = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'theirs',
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  await assert.rejects(fs.stat(path.join(f.repo, read.file.path)), /ENOENT/)
  assert.equal(result.snapshot.merge.files.length, 0)
})
test('binary conflicts cannot be text edited but whole versions can be chosen', async (t) => {
  const f = await fixture(t, { binary: true })
  await f.start()
  let read = await f.git.merge.read(f.repo, '文件 with space.txt')
  assert.equal(read.file.editable, false)
  let result = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: 'bad',
  })
  assert.equal(result.outcome, 'failed')
  read = await f.git.merge.read(f.repo, read.file.path)
  result = await f.act('merge-resolve', {
    token: read.file.token,
    file: read.file.path,
    choice: 'theirs',
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.deepEqual(await fs.readFile(path.join(f.repo, read.file.path)), Buffer.from([0, 3, 4]))
})
test('commit hook failure leaves the resolved merge available to retry', async (t) => {
  const f = await fixture(t, { conflict: false })
  await f.start()
  await fs.writeFile(
    path.join(f.repo, '.git/hooks/pre-commit'),
    '#!/bin/sh\necho hook-refused >&2\nexit 1\n',
    { mode: 0o755 },
  )
  await f.git.git(f.repo, ['config', 'core.hooksPath', '.git/hooks'])
  const result = await f.act('merge-finish', { message: 'Merge' })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.snapshot.head, f.local)
  assert.match(result.error, /hook-refused/)
  assert.ok(result.snapshot.merge.active)
})
test('unreadable conflict content leaves a visible read-only state and blocks writes', async (t) => {
  const f = await fixture(t)
  await f.start()
  f.git.selectedCommit.fingerprint = async () => {
    throw new Error('Content cannot be verified')
  }
  const snapshot = await f.git.snapshot(f.repo)
  assert.equal(snapshot.merge.unsupported, true)
  assert.match(snapshot.merge.unsupportedReason, /cannot be verified/)
  const result = await f.act('merge-abort')
  assert.equal(result.outcome, 'failed')
  assert.ok(result.snapshot.merge.active)
})
test('merge never overwrites an ignored local file introduced by the incoming branch', async (t) => {
  const f = await fixture(t, { conflict: false })
  await fs.appendFile(path.join(f.repo, '.git/info/exclude'), '\nincoming.txt\n')
  await f.write('incoming.txt', 'precious ignored local content\n')
  assert.equal(await f.git.git(f.repo, ['status', '--porcelain=v1']), '')
  await assert.rejects(f.start(), /被忽略的文件冲突/)
  assert.equal(
    await fs.readFile(path.join(f.repo, 'incoming.txt'), 'utf8'),
    'precious ignored local content\n',
  )
  assert.equal(await f.git.head(f.repo), f.local)
})
