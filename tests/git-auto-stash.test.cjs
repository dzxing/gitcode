const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { GitService } = require('../electron/git.cjs')

async function fixture(t, conflict = false) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-auto-stash-'))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true })
  })
  await git.git(repo, ['init', '-b', 'main'])
  for (const [k, v] of [
    ['user.name', 'Auto test'],
    ['user.email', 'auto@test.local'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', k, v])
  const write = (name, value) => fs.writeFile(path.join(repo, name), value)
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  await write('shared.txt', 'base\n')
  await write('draft.txt', 'original\n')
  const base = await commit('base')
  await git.git(repo, ['switch', '-c', 'topic'])
  await write(conflict ? 'shared.txt' : 'incoming.txt', 'incoming\n')
  const incoming = await commit('incoming')
  await git.git(repo, ['switch', 'main'])
  const action = async (action, extra = {}) =>
    git.action(repo, {
      action,
      expectedHead: await git.head(repo),
      expectedBranch: await git.currentBranch(repo),
      ...extra,
    })
  const merge = () =>
    action('merge-branch', { fullRef: 'refs/heads/topic', expectedOid: incoming, confirm: true })
  return { repo, git, write, commit, base, incoming, action, merge }
}
test('automatic merge protection restores partial staging, untracked files and keeps unrelated stashes', async (t) => {
  const f = await fixture(t)
  await f.write('draft.txt', 'older saved\n')
  await f.git.git(f.repo, ['stash', 'push', '-m', 'existing record'])
  const older = (await f.git.stash.list(f.repo)).entries[0].oid
  await f.write('draft.txt', 'staged\n')
  await f.git.git(f.repo, ['add', 'draft.txt'])
  await f.write('draft.txt', 'working\n')
  await f.write('new 文件.txt', 'untracked\n')
  const result = await f.merge()
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.head, f.incoming)
  assert.equal(await f.git.git(f.repo, ['show', ':draft.txt']), 'staged\n')
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'working\n')
  assert.equal(await fs.readFile(path.join(f.repo, 'new 文件.txt'), 'utf8'), 'untracked\n')
  assert.deepEqual(
    result.snapshot.stashes.map((e) => e.oid),
    [older],
  )
})
test('clean diverged merge commits both parents before restoring local edits', async (t) => {
  const f = await fixture(t)
  await f.write('local.txt', 'local\n')
  const local = await f.commit('parallel')
  await f.write('draft.txt', 'working\n')
  const result = await f.merge()
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.merge, null)
  assert.deepEqual(
    (await f.git.git(f.repo, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '),
    [local, f.incoming],
  )
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'working\n')
})
test('merge conflict retains automatic stash across restart; abort then manual restoration recovers local edits', async (t) => {
  const f = await fixture(t, true)
  await f.write('shared.txt', 'local conflict\n')
  const local = await f.commit('parallel')
  await f.write('draft.txt', 'working\n')
  const result = await f.merge()
  assert.equal(result.outcome, 'partial')
  assert.ok(result.snapshot.merge.active)
  assert.equal(result.snapshot.stashes.length, 1)
  assert.match(result.warning, /自动贮藏.*保留/)
  const restarted = new GitService()
  t.after(() => restarted.shutdown())
  const state = await restarted.merge.state(f.repo)
  const aborted = await restarted.action(f.repo, {
    action: 'merge-abort',
    expectedHead: state.head,
    expectedBranch: state.branch,
    mergeSignature: state.signature,
  })
  assert.equal(aborted.outcome, 'succeeded')
  assert.equal(aborted.snapshot.head, local)
  const entry = aborted.snapshot.stashes[0]
  const restored = await restarted.action(f.repo, {
    action: 'stash-pop',
    expectedHead: local,
    expectedBranch: 'main',
    stashSignature: aborted.snapshot.stashSignature,
    stashRef: entry.ref,
    stashOid: entry.oid,
    restoreIndex: true,
  })
  assert.equal(restored.outcome, 'succeeded', JSON.stringify(restored))
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'working\n')
})
test('stash restoration failure is distinct from completed merge and retains the saved version', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['switch', 'topic'])
  await f.write('draft.txt', 'incoming draft\n')
  const incoming = await f.commit('incoming draft')
  await f.git.git(f.repo, ['switch', 'main'])
  await f.write('draft.txt', 'local draft\n')
  const result = await f.action('merge-branch', {
    fullRef: 'refs/heads/topic',
    expectedOid: incoming,
    confirm: true,
  })
  assert.equal(result.outcome, 'partial', JSON.stringify(result))
  assert.equal(result.snapshot.head, incoming)
  assert.match(result.warning, /主要操作已完成.*恢复未完整/)
  assert.equal(result.snapshot.stashes.length, 1)
  assert.match(
    await f.git.git(f.repo, ['show', `${result.snapshot.stashes[0].oid}:draft.txt`]),
    /local draft/,
  )
})
test('cancellation after saving retains the exact stash without starting restoration', async (t) => {
  const f = await fixture(t)
  await f.write('draft.txt', 'working\n')
  const controller = new AbortController()
  const result = await f.git.autoStash.run(f.repo, 'test cancel', controller.signal, async () => {
    controller.abort()
    return { outcome: 'succeeded', output: '' }
  })
  assert.equal(result.outcome, 'cancelled')
  assert.equal((await f.git.stash.list(f.repo)).entries.length, 1)
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'original\n')
})
test('invalid fast forward is rejected before auto-stashing any local changes', async (t) => {
  const f = await fixture(t)
  await f.write('local.txt', 'local\n')
  await f.commit('parallel')
  await f.write('draft.txt', 'working\n')
  const result = await f.action('fast-forward', {
    fullRef: 'refs/heads/topic',
    expectedOid: f.incoming,
    confirm: true,
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.snapshot.stashes.length, 0)
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'working\n')
})
