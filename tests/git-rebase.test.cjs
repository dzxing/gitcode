'use strict'
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, { conflict = false, dirty = false } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-rebase-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  const cmd = (...args) => git.git(repo, args),
    write = (file, text) => fs.writeFile(path.join(repo, file), text)
  const commit = async (message) => {
    await cmd('add', '.')
    await cmd('commit', '-m', message)
    return git.head(repo)
  }
  await cmd('init', '-b', 'main')
  for (const [k, v] of Object.entries({
    'user.name': 'Rebase Test',
    'user.email': 'rebase@test.invalid',
    'commit.gpgsign': 'false',
    'core.autocrlf': 'false',
    'core.hooksPath': '.no-hooks',
  }))
    await cmd('config', k, v)
  await write('shared.txt', 'base\n')
  await commit('initial')
  await write('base.txt', 'base\n')
  const base = await commit('common base')
  await cmd('switch', '-c', 'develop')
  await write('shared.txt', 'develop\n')
  const target = await commit('develop update')
  await cmd('switch', '-c', 'feature/test', base)
  await write(conflict ? 'shared.txt' : 'feature.txt', 'feature\n')
  const first = await commit('first feature')
  await write('second.txt', 'second\n')
  const original = await commit('second feature')
  if (dirty) await write('feature.txt', 'feature\nuncommitted\n')
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
  })
  const plan = async () =>
    git.navigation.read(repo, {
      kind: 'rebase',
      fullRef: 'refs/heads/develop',
      expectedOid: target,
      ...(await context()),
    })
  const start = async (steps) => {
    const p = await plan()
    return git.action(repo, {
      action: 'rebase-start',
      fullRef: p.fullRef,
      expectedOid: p.referenceOid,
      planSignature: p.rebase.signature,
      ...(await context()),
      ...(steps ? { steps } : {}),
    })
  }
  const action = async (action, extra = {}) =>
    git.action(repo, {
      action,
      mergeSignature: (await git.merge.state(repo))?.signature,
      ...(await context()),
      ...extra,
    })
  return {
    git,
    repo,
    cmd,
    write,
    commit,
    base,
    target,
    first,
    original,
    context,
    plan,
    start,
    action,
  }
}
test('ordinary rebase rewrites only the current branch, ignoring updateRefs config', async (t) => {
  const f = await fixture(t)
  await f.cmd('branch', 'other', f.original)
  await f.cmd('config', 'rebase.updateRefs', 'true')
  const result = await f.start()
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.merge, null)
  assert.equal((await f.cmd('rev-parse', 'HEAD~2')).trim(), f.target)
  assert.equal((await f.cmd('rev-parse', 'other')).trim(), f.original)
  assert.equal((await f.cmd('rev-parse', 'main')).trim(), f.base)
  assert.notEqual(await f.git.head(f.repo), f.original)
})
test('dirty tracked changes survive native autostash and untracked files remain', async (t) => {
  const f = await fixture(t, { dirty: true })
  await f.write('local draft.txt', 'draft\n')
  const result = await f.start()
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(
    await fs.readFile(path.join(f.repo, 'feature.txt'), 'utf8'),
    'feature\nuncommitted\n',
  )
  assert.equal(await fs.readFile(path.join(f.repo, 'local draft.txt'), 'utf8'), 'draft\n')
  assert.equal((await f.cmd('stash', 'list')).trim(), '')
})
test('interactive reword and squash actually change messages and commit count', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  assert.equal(p.rebase.canInteractive, true)
  const steps = p.rebase.steps.map((s) => ({ ...s }))
  steps[0].type = 'reword'
  steps[0].message = '重新整理的提交\n\nDescription'
  steps[1].type = 'squash'
  const result = await f.start(steps)
  assert.equal(result.outcome, 'succeeded', result.error || result.warning)
  assert.equal((await f.cmd('rev-parse', 'HEAD~1')).trim(), f.target)
  assert.match(await f.cmd('log', '-1', '--format=%B'), /重新整理的提交/)
  assert.match(await f.cmd('log', '-1', '--format=%B'), /second feature/)
})
test('interactive drop excludes a patch while allowing later independent commits', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  p.rebase.steps[0].type = 'drop'
  const result = await f.start(p.rebase.steps)
  assert.equal(result.outcome, 'succeeded', result.error)
  await assert.rejects(fs.stat(path.join(f.repo, 'feature.txt')))
  assert.equal((await f.cmd('rev-parse', 'HEAD~1')).trim(), f.target)
})
test('conflict state survives a new service and exposes base / replayed commit correctly; resolve and continue', async (t) => {
  const f = await fixture(t, { conflict: true }),
    result = await f.start()
  assert.equal(result.outcome, 'partial', result.error)
  const restarted = new GitService()
  t.after(() => restarted.shutdown())
  const state = await restarted.merge.state(f.repo)
  assert.equal(state.rebase.sourceBranch, 'feature/test')
  assert.equal(state.rebase.targetName, 'develop')
  assert.equal(state.rebase.step, 1)
  assert.equal(state.files.length, 1)
  assert.equal(state.unsupported, false)
  const read = await restarted.merge.read(f.repo, 'shared.txt')
  assert.equal(read.file.ours.text, 'develop\n')
  assert.equal(read.file.theirs.text, 'feature\n')
  const tooEarly = await f.action('rebase-continue')
  assert.equal(tooEarly.outcome, 'failed')
  assert.match(tooEarly.error, /冲突/)
  const wrongFinish = await f.action('merge-finish', { message: 'wrong' })
  assert.equal(wrongFinish.outcome, 'failed')
  assert.match(wrongFinish.error, /变基/)
  const resolved = await f.action('merge-resolve', {
    file: 'shared.txt',
    token: read.file.token,
    choice: 'theirs',
  })
  // Read tokens are deliberately scoped to the service that issued them.
  assert.equal(resolved.outcome, 'failed')
  const current = await f.git.merge.read(f.repo, 'shared.txt')
  assert.equal(
    (
      await f.action('merge-resolve', {
        file: 'shared.txt',
        token: current.file.token,
        choice: 'theirs',
      })
    ).outcome,
    'succeeded',
  )
  const done = await f.action('rebase-continue')
  assert.equal(done.outcome, 'succeeded', done.error || done.warning)
  assert.equal(done.snapshot.branch, 'feature/test')
  assert.equal(done.snapshot.merge, null)
  assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'feature\n')
})
test('abort returns exact original HEAD and working tree', async (t) => {
  const f = await fixture(t, { conflict: true })
  await f.start()
  const result = await f.action('rebase-abort')
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(await f.git.head(f.repo), f.original)
  assert.equal((await f.cmd('status', '--porcelain')).trim(), '')
  assert.equal(result.snapshot.merge, null)
})
test('skip requires confirmation, then drops current conflicting patch and continues', async (t) => {
  const f = await fixture(t, { conflict: true })
  await f.start()
  assert.equal((await f.action('rebase-skip')).outcome, 'failed')
  const result = await f.action('rebase-skip', { confirm: true })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await f.cmd('rev-parse', 'HEAD~1')).trim(), f.target)
  assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'develop\n')
  assert.equal(result.snapshot.merge, null)
})
test('stale workspace / target / conflict signatures reject mutation', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  await f.write('late.txt', 'late')
  const result = await f.git.action(f.repo, {
    action: 'rebase-start',
    ...(await f.context()),
    fullRef: p.fullRef,
    expectedOid: p.referenceOid,
    planSignature: p.rebase.signature,
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /变化/)
  assert.equal(await f.git.head(f.repo), f.original)
})
test('interactive merge range is hidden and malformed or leading squash steps are rejected', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  p.rebase.steps[0].type = 'squash'
  assert.equal((await f.start(p.rebase.steps)).outcome, 'failed')
  await f.cmd('switch', '-c', 'side', f.base)
  await f.write('side.txt', 'side')
  await f.commit('side')
  await f.cmd('switch', 'feature/test')
  await f.cmd('merge', '--no-ff', 'side', '-m', 'merge side')
  const merged = await f.plan()
  assert.equal(merged.rebase.canInteractive, false)
  assert.match(merged.rebase.reason, /合并提交/)
})

test('autostash restore conflict is distinct from a paused rebase and retains stash', async (t) => {
  const f = await fixture(t)
  await f.write('shared.txt', 'uncommitted local edit\n')
  const result = await f.start()
  assert.equal(result.outcome, 'partial', result.error)
  assert.match(result.warning, /自动贮藏恢复/)
  assert.equal(result.snapshot.merge.active, false)
  assert.equal(result.snapshot.merge.rebase, undefined)
  assert.ok((await f.cmd('stash', 'list')).trim())
  assert.equal((await f.cmd('rev-parse', 'HEAD~2')).trim(), f.target)
})
test('ignored files that the target would overwrite are protected before rebase', async (t) => {
  const f = await fixture(t)
  await f.cmd('switch', 'develop')
  await f.write('ignored.txt', 'target content\n')
  const target = await f.commit('add target path')
  await f.cmd('switch', 'feature/test')
  await f.write('.gitignore', 'ignored.txt\n')
  await f.commit('ignore local path')
  await f.write('ignored.txt', 'private local data\n')
  const p = await f.git.navigation.read(f.repo, {
    kind: 'rebase',
    fullRef: 'refs/heads/develop',
    expectedOid: target,
    ...(await f.context()),
  })
  const result = await f.git.action(f.repo, {
    action: 'rebase-start',
    fullRef: p.fullRef,
    expectedOid: p.referenceOid,
    planSignature: p.rebase.signature,
    ...(await f.context()),
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /忽略/)
  assert.equal(await fs.readFile(path.join(f.repo, 'ignored.txt'), 'utf8'), 'private local data\n')
})
test('stale pause signature is rejected, and stale completed metadata does not block the next rebase', async (t) => {
  const f = await fixture(t, { conflict: true })
  await f.start()
  const state = await f.git.merge.state(f.repo)
  await f.write('new-local.txt', 'draft')
  const rejected = await f.git.action(f.repo, {
    action: 'rebase-abort',
    mergeSignature: state.signature,
    ...(await f.context()),
  })
  assert.equal(rejected.outcome, 'failed')
  assert.match(rejected.error, /变化/)
  await fs.unlink(path.join(f.repo, 'new-local.txt'))
  assert.equal((await f.action('rebase-abort')).outcome, 'succeeded')
  await fs.writeFile(
    path.join(f.repo, '.git', 'gitcode-rebase.json'),
    JSON.stringify({ id: 'completed-operation' }),
  )
  assert.equal((await f.start()).outcome, 'partial')
  assert.equal((await f.action('rebase-abort')).outcome, 'succeeded')
})

test('interactive conflict continues with planned message after core restart', async (t) => {
  const f = await fixture(t, { conflict: true }),
    p = await f.plan()
  p.rebase.steps[0].type = 'reword'
  p.rebase.steps[0].message = '重启后仍保留的说明'
  const start = await f.start(p.rebase.steps)
  assert.equal(start.outcome, 'partial')
  const restarted = new GitService()
  t.after(() => restarted.shutdown())
  const read = await restarted.merge.read(f.repo, 'shared.txt')
  const context = async () => ({
    expectedHead: await restarted.head(f.repo),
    expectedBranch: (await restarted.currentBranch(f.repo)) || 'detached HEAD',
  })
  let result = await restarted.action(f.repo, {
    action: 'merge-resolve',
    ...(await context()),
    mergeSignature: read.state.signature,
    token: read.file.token,
    file: 'shared.txt',
    choice: 'theirs',
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  result = await restarted.action(f.repo, {
    action: 'rebase-continue',
    ...(await context()),
    mergeSignature: result.snapshot.merge.signature,
  })
  assert.equal(result.outcome, 'succeeded', result.error || result.warning)
  assert.match(await f.cmd('log', '-2', '--format=%B'), /重启后仍保留的说明/)
})
test('linked worktree uses its own operation state and supports abort', async (t) => {
  const f = await fixture(t, { conflict: true }),
    linked = path.join(f.repo, '..', path.basename(f.repo) + ' linked')
  t.after(() => fs.rm(linked, { recursive: true, force: true, maxRetries: 3 }))
  await f.cmd('worktree', 'add', '-b', 'feature/linked', linked, 'feature/test')
  const context = { expectedHead: f.original, expectedBranch: 'feature/linked' }
  const p = await f.git.navigation.read(linked, {
    kind: 'rebase',
    fullRef: 'refs/heads/develop',
    expectedOid: f.target,
    ...context,
  })
  let result = await f.git.action(linked, {
    action: 'rebase-start',
    fullRef: p.fullRef,
    expectedOid: p.referenceOid,
    planSignature: p.rebase.signature,
    ...context,
  })
  assert.equal(result.outcome, 'partial', result.error)
  assert.equal(result.snapshot.merge.rebase.sourceBranch, 'feature/linked')
  result = await f.git.action(linked, {
    action: 'rebase-abort',
    expectedHead: result.snapshot.head,
    expectedBranch: result.snapshot.branch,
    mergeSignature: result.snapshot.merge.signature,
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.head, f.original)
  assert.equal(await f.git.head(f.repo), f.original)
})
