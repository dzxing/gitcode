const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-checkout-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Checkout Test'],
    ['user.email', 'checkout@test.local'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', key, value])
  const write = (name, text) => fs.writeFile(path.join(repo, name), text)
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  await write('shared.txt', 'base\n')
  await write('.gitignore', '*.ignored\n')
  const base = await commit('base')
  await git.git(repo, ['switch', '-c', 'topic'])
  await write('shared.txt', 'topic\n')
  const target = await commit('topic')
  await git.git(repo, ['switch', 'main'])
  const action = async (action, extra = {}) =>
    git.action(repo, {
      action,
      expectedHead: await git.head(repo),
      expectedBranch: await git.currentBranch(repo),
      ...extra,
    })
  const block = async () => {
    const result = await action('checkout', { name: 'topic', expectedOid: target })
    assert.equal(result.outcome, 'failed', result.error)
    assert.ok(result.checkoutProtection)
    return result.checkoutProtection
  }
  return { repo, git, write, commit, base, target, action, block }
}

async function remoteFixture(t, name = 'topic', oid) {
  const f = await fixture(t)
  await f.git.git(f.repo, ['config', 'remote.origin.url', '.'])
  await f.git.git(f.repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  const ref = `refs/remotes/origin/${name}`
  await f.git.git(f.repo, ['update-ref', ref, oid || f.target])
  const remote = () => f.action('checkout-remote', { fullRef: ref, expectedOid: oid || f.target })
  return { ...f, ref, remote }
}
test('remote checkout creates a local tracking branch and restores local changes', async (t) => {
  const f = await remoteFixture(t, 'fresh')
  await f.write('new.txt', 'draft\n')
  const result = await f.remote()
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.branch, 'fresh')
  assert.equal(result.snapshot.head, f.target)
  assert.equal(result.snapshot.branches.find((b) => b.name === 'fresh').upstream, 'origin/fresh')
  assert.equal(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8'), 'draft\n')
  assert.equal(result.snapshot.stashes.length, 0)
})
test('remote checkout reuses a same-tip branch and fast-forwards only its own tracked branch', async (t) => {
  const f = await remoteFixture(t)
  assert.equal((await f.remote()).snapshot.branch, 'topic')
  await f.git.git(f.repo, ['switch', 'main'])
  await f.git.git(f.repo, ['update-ref', 'refs/heads/topic', f.base, f.target])
  await f.git.git(f.repo, ['branch', '--set-upstream-to=origin/topic', 'topic'])
  await f.write('new.txt', 'draft\n')
  const result = await f.remote()
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.branch, 'topic')
  assert.equal(result.snapshot.head, f.target)
  assert.equal(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8'), 'draft\n')
})
for (const choice of ['create', 'reset'])
  test(`different local history requires an explicit ${choice} choice before remote checkout`, async (t) => {
    const f = await remoteFixture(t)
    await f.git.git(f.repo, ['update-ref', f.ref, f.base, f.target])
    const result = await f.action('checkout-remote', { fullRef: f.ref, expectedOid: f.base })
    assert.equal(result.outcome, 'failed')
    const p = result.remoteCheckoutProtection
    assert.ok(p)
    assert.equal((await f.git.git(f.repo, ['rev-parse', 'refs/heads/topic'])).trim(), f.target)
    assert.equal(result.snapshot.branch, 'main')
    const applied = await f.action('checkout-remote-confirm', {
      planId: p.id,
      choice,
      ...(choice === 'create' ? { name: 'topic-copy' } : {}),
    })
    assert.equal(applied.outcome, 'succeeded', JSON.stringify(applied))
    assert.equal(applied.snapshot.branch, choice === 'create' ? 'topic-copy' : 'topic')
    assert.equal(applied.snapshot.head, f.base)
    assert.equal(
      (await f.git.git(f.repo, ['rev-parse', 'refs/heads/topic'])).trim(),
      choice === 'create' ? f.target : f.base,
    )
    if (choice === 'reset')
      assert.match(
        await f.git.git(f.repo, ['reflog', 'show', '--format=%H', 'topic']),
        new RegExp(f.target),
      )
  })
test('remote checkout confirmation rejects changed content and changed remote refs before stashing', async (t) => {
  const f = await remoteFixture(t)
  await f.git.git(f.repo, ['update-ref', f.ref, f.base, f.target])
  const plan = await f.action('checkout-remote', { fullRef: f.ref, expectedOid: f.base })
  await f.write('new.txt', 'draft\n')
  let result = await f.action('checkout-remote-confirm', {
    planId: plan.remoteCheckoutProtection.id,
    choice: 'reset',
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /文件.*变化/)
  assert.equal(result.snapshot.stashes.length, 0)
  await fs.rm(path.join(f.repo, 'new.txt'))
  await f.git.git(f.repo, ['update-ref', f.ref, f.target, f.base])
  result = await f.action('checkout-remote-confirm', {
    planId: plan.remoteCheckoutProtection.id,
    choice: 'reset',
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /引用.*变化|分支.*变化/)
  assert.equal(result.snapshot.branch, 'main')
})
for (const operation of ['create-branch', 'track-branch'])
  test(`${operation} preserves ignored files when switching to the new branch`, async (t) => {
    const f = await fixture(t)
    await f.git.git(f.repo, ['switch', 'topic'])
    await f.write('private.ignored', 'tracked target\n')
    await f.git.git(f.repo, ['add', '-f', 'private.ignored'])
    const target = await f.commit('target includes ignored path')
    await f.git.git(f.repo, ['switch', 'main'])
    await f.write('private.ignored', 'local data to preserve\n')
    await f.git.git(f.repo, ['config', 'remote.origin.url', '.'])
    await f.git.git(f.repo, [
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ])
    await f.git.git(f.repo, ['update-ref', 'refs/remotes/origin/topic', target])
    const result = await f.action(operation, {
      name: 'new-topic',
      switchAfter: true,
      startOid: target,
      fullRef: 'refs/remotes/origin/topic',
      expectedOid: target,
    })
    assert.equal(result.outcome, 'partial', JSON.stringify(result))
    assert.equal(result.snapshot.branch, 'main')
    assert.equal(
      await fs.readFile(path.join(f.repo, 'private.ignored'), 'utf8'),
      'local data to preserve\n',
    )
    assert.equal((await f.git.git(f.repo, ['rev-parse', 'refs/heads/new-topic'])).trim(), target)
  })
test('safe checkout carries unrelated edits without creating a stash', async (t) => {
  const f = await fixture(t)
  await f.write('new.txt', 'draft\n')
  const result = await f.action('checkout', { name: 'topic', expectedOid: f.target })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.branch, 'topic')
  assert.equal(result.snapshot.stashes.length, 0)
  assert.equal(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8'), 'draft\n')
})
test('protected checkout preserves files/index; stash-and-switch retains staged, working and untracked versions without applying', async (t) => {
  const f = await fixture(t)
  await f.write('shared.txt', 'staged\n')
  await f.git.git(f.repo, ['add', 'shared.txt'])
  await f.write('shared.txt', 'working\n')
  await f.write('新 文件.txt', 'new\n')
  const index = await f.git.indexFingerprint(f.repo),
    plan = await f.block()
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  assert.equal(await f.git.currentBranch(f.repo), 'main')
  assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'working\n')
  const result = await f.action('stash-checkout', { planId: plan.id })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.branch, 'topic')
  assert.equal(result.snapshot.stashes.length, 1)
  assert.equal(result.snapshot.staged.length + result.snapshot.unstaged.length, 0)
  assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'topic\n')
  const details = await f.git.stash.read(f.repo, result.snapshot.stashes[0].oid, 'shared.txt')
  assert.match(details.diff.diff, /\+working/)
  assert.match(details.indexDiff.diff, /\+staged/)
  assert.ok(details.files.some((file) => file.path === '新 文件.txt'))
  assert.equal((await f.action('stash-checkout', { planId: plan.id })).outcome, 'failed')
  assert.equal((await f.git.stash.list(f.repo)).entries.length, 1)
})
for (const change of ['file', 'target', 'index'])
  test(`changes to ${change} invalidate checkout confirmation before stash`, async (t) => {
    const f = await fixture(t)
    await f.write('shared.txt', 'draft\n')
    const plan = await f.block()
    if (change === 'file') await f.write('shared.txt', 'new draft\n')
    if (change === 'target') await f.git.git(f.repo, ['update-ref', 'refs/heads/topic', f.base])
    if (change === 'index') await f.git.git(f.repo, ['add', 'shared.txt'])
    const result = await f.action('stash-checkout', { planId: plan.id })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.snapshot.branch, 'main')
    assert.equal(result.snapshot.stashes.length, 0)
    assert.equal(
      await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'),
      change === 'file' ? 'new draft\n' : 'draft\n',
    )
  })
test('switch failure after stash preserves backup and reports a partial result without restoring', async (t) => {
  const f = await fixture(t)
  await f.write('shared.txt', 'draft\n')
  const plan = await f.block(),
    original = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args.includes('switch') && args.at(-1) === 'topic')
      throw new Error('simulated checkout failure')
    return original(repo, args, options)
  }
  const result = await f.action('stash-checkout', { planId: plan.id })
  assert.equal(result.outcome, 'partial')
  assert.match(result.warning, /贮藏已创建并保留/)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.stashes.length, 1)
  assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'base\n')
})
test('ignored file collision is blocked without overwriting or offering a stash that excludes it', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['switch', 'topic'])
  await f.write('local.ignored', 'tracked target\n')
  await f.git.git(f.repo, ['add', '-f', 'local.ignored'])
  await f.git.git(f.repo, ['commit', '-m', 'ignored target'])
  const target = await f.git.head(f.repo)
  await f.git.git(f.repo, ['switch', 'main'])
  await f.write('local.ignored', 'precious ignored local\n')
  const result = await f.action('checkout', { name: 'topic', expectedOid: target })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.checkoutProtection, undefined)
  assert.equal(
    await fs.readFile(path.join(f.repo, 'local.ignored'), 'utf8'),
    'precious ignored local\n',
  )
  assert.equal(result.snapshot.branch, 'main')
})
for (const choice of ['ours', 'theirs', 'manual'])
  test(`restore conflict ${choice} resolves without a merge commit and retains stash after reopen`, async (t) => {
    const f = await fixture(t)
    await f.write('shared.txt', 'draft\n')
    const plan = await f.block(),
      switched = await f.action('stash-checkout', { planId: plan.id }),
      entry = switched.snapshot.stashes[0]
    const result = await f.action('stash-pop', {
      stashRef: entry.ref,
      stashOid: entry.oid,
      stashSignature: switched.snapshot.stashSignature,
      restoreIndex: false,
    })
    assert.equal(result.outcome, 'partial')
    assert.equal(result.snapshot.merge.active, false)
    assert.equal(result.snapshot.merge.files.length, 1)
    assert.equal(result.snapshot.stashes.length, 1)
    const reopened = new GitService()
    try {
      const read = await reopened.merge.read(f.repo, 'shared.txt')
      assert.equal(read.file.ours.text, 'topic\n')
      assert.equal(read.file.theirs.text, 'draft\n')
      const saved = await reopened.action(f.repo, {
        action: 'merge-resolve',
        expectedHead: f.target,
        expectedBranch: 'topic',
        mergeSignature: read.state.signature,
        file: 'shared.txt',
        token: read.file.token,
        choice,
        content: 'combined\n',
      })
      assert.equal(saved.outcome, 'succeeded', saved.error)
      assert.equal(saved.snapshot.merge, null)
      assert.equal(saved.snapshot.head, f.target)
      assert.equal(saved.snapshot.stashes.length, 1)
      assert.equal(
        await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'),
        choice === 'ours' ? 'topic\n' : choice === 'theirs' ? 'draft\n' : 'combined\n',
      )
      assert.equal(
        (
          await f.action('merge-finish', {
            mergeSignature: read.state.signature,
            message: 'invalid merge',
          })
        ).outcome,
        'failed',
      )
    } finally {
      await reopened.shutdown()
    }
  })
