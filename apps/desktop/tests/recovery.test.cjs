const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function setup(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-recovery-中文-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'qa/first'])
  for (const [key, value] of [
    ['user.name', 'Recovery QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', key, value])
  async function commit(text, message) {
    await fs.writeFile(path.join(repo, 'file.txt'), text)
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  const base = await commit('base\n', 'base'),
    head = await commit('second\n', 'second')
  const read = () => git.recovery.read(repo)
  const act = async (request) =>
    git.action(repo, {
      expectedHead: await git.head(repo),
      expectedBranch: await git.currentBranch(repo),
      ...request,
    })
  return { repo, git, base, head, commit, read, act }
}
test('undo preserves byte-identical index and all working files and protects the original commit across restart', async (t) => {
  const f = await setup(t)
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'third\n')
  await f.git.git(f.repo, ['add', 'file.txt'])
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'fourth\n')
  await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'keep me\n')
  const index = await f.git.indexFingerprint(f.repo),
    plan = await f.read()
  assert.equal(plan.blocked, '')
  const result = await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(await f.git.head(f.repo), f.base)
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'fourth\n')
  assert.equal(await fs.readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep me\n')
  const other = new GitService()
  try {
    const restored = await other.recovery.read(f.repo)
    assert.equal(restored.entries[0].oid, f.head)
    assert.ok(!(await other.snapshot(f.repo)).commits.some((c) => c.hash === f.head))
    const result = await other.action(f.repo, {
      action: 'recovery-restore',
      expectedHead: f.base,
      expectedBranch: 'qa/first',
      planId: restored.id,
      entryId: restored.entries[0].id,
      name: 'qa/recovered',
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    assert.equal((await other.git(f.repo, ['rev-parse', 'refs/heads/qa/recovered'])).trim(), f.head)
    assert.equal(await other.currentBranch(f.repo), 'qa/first')
  } finally {
    await other.shutdown()
  }
})
test('deleted branches remain recoverable and restore never overwrites an existing branch', async (t) => {
  const f = await setup(t)
  await f.git.git(f.repo, ['branch', 'feature/中文', f.head])
  const result = await f.act({
    action: 'delete-branch',
    name: 'feature/中文',
    expectedOid: f.head,
    force: true,
  })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  let plan = await f.read()
  const entry = plan.entries.find((e) => e.branch === 'feature/中文')
  assert.ok(entry)
  const blocked = await f.act({
    action: 'recovery-restore',
    planId: plan.id,
    entryId: entry.id,
    name: 'qa/first',
  })
  assert.equal(blocked.outcome, 'failed')
  assert.equal(await f.git.head(f.repo), f.head)
  plan = await f.read()
  assert.equal(
    (
      await f.act({
        action: 'recovery-restore',
        planId: plan.id,
        entryId: entry.id,
        name: 'feature/中文',
      })
    ).outcome,
    'succeeded',
  )
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'refs/heads/feature/中文'])).trim(), f.head)
  assert.equal((await f.read()).entries.length, 0)
})
test('external commits, branch checkout and shared history invalidate undo without changing the index', async (t) => {
  const f = await setup(t)
  let plan = await f.read()
  await f.commit('third\n', 'external')
  const index = await f.git.indexFingerprint(f.repo)
  assert.equal(
    (await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })).outcome,
    'failed',
  )
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  plan = await f.read()
  await f.git.git(f.repo, ['switch', '-c', 'qa/other'])
  assert.equal(
    (await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })).outcome,
    'failed',
  )
  plan = await f.read()
  await f.git.git(f.repo, ['update-ref', 'refs/remotes/origin/shared', await f.git.head(f.repo)])
  assert.equal(
    (await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })).outcome,
    'failed',
  )
  assert.match((await f.read()).blocked, /远程引用/)
})
test('root, detached HEAD, merge in progress and missing confirmation are blocked', async (t) => {
  const f = await setup(t)
  let plan = await f.read()
  assert.equal(
    (await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: false })).outcome,
    'failed',
  )
  await f.git.git(f.repo, ['switch', '--detach', f.base])
  assert.match((await f.read()).blocked, /游离/)
  await f.git.git(f.repo, ['switch', '-c', 'qa/root'])
  assert.match((await f.read()).blocked, /首次/)
  await f.git.git(f.repo, ['switch', 'qa/first'])
  await fs.writeFile(path.join(f.repo, '.git', 'MERGE_HEAD'), f.base + '\n')
  assert.match((await f.read()).blocked, /未完成/)
})
test('stale recovery points and target name collisions preserve the backup atomically', async (t) => {
  const f = await setup(t)
  const ref = await f.git.recovery.checkpoint(f.repo, 'qa/first', f.head)
  let plan = await f.read()
  const entry = plan.entries[0]
  await f.git.git(f.repo, ['update-ref', ref, f.base, f.head])
  const result = await f.act({
    action: 'recovery-restore',
    planId: plan.id,
    entryId: entry.id,
    name: 'qa/new',
  })
  assert.equal(result.outcome, 'failed')
  assert.equal((await f.git.git(f.repo, ['rev-parse', ref])).trim(), f.base)
  assert.equal(
    (
      await f.git.git(f.repo, ['show-ref', '--verify', '--quiet', 'refs/heads/qa/new'], {
        allowedCodes: [0, 1],
      })
    ).trim(),
    '',
  )
  plan = await f.read()
  assert.equal(
    (
      await f.act({
        action: 'recovery-restore',
        planId: plan.id,
        entryId: entry.id,
        name: 'qa/first',
      })
    ).outcome,
    'failed',
  )
  assert.equal((await f.git.git(f.repo, ['rev-parse', ref])).trim(), f.base)
})

test('checkout to another branch at the same commit before transaction prepare aborts without changing either branch', async (t) => {
  const f = await setup(t)
  await f.git.git(f.repo, ['branch', 'qa/other'])
  const plan = await f.read(),
    original = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args[0] === 'update-ref' && options?.onPrepared) {
      await original(repo, ['switch', 'qa/other'])
      f.git.git = original
    }
    return original(repo, args, options)
  }
  const result = await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })
  assert.equal(result.outcome, 'partial')
  assert.equal(await f.git.head(f.repo), f.head)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'qa/first'])).trim(), f.head)
  assert.equal((await f.read()).entries.length, 0)
})
test('prepared undo holds the Git HEAD lock until validation and cancellation aborts both ref writes', async (t) => {
  const f = await setup(t)
  await f.git.git(f.repo, ['branch', 'qa/other'])
  let plan = await f.read()
  const original = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args[0] === 'update-ref' && options?.onPrepared) {
      const verify = options.onPrepared
      options = {
        ...options,
        onPrepared: async (signal) => {
          await assert.rejects(
            original(repo, ['switch', 'qa/other']),
            /HEAD.lock|another git process|File exists/i,
          )
          await verify(signal)
        },
      }
    }
    return original(repo, args, options)
  }
  assert.equal(
    (await f.act({ action: 'recovery-undo', planId: plan.id, confirmUnpublished: true })).outcome,
    'succeeded',
  )
  f.git.git = original
  assert.equal(await f.git.currentBranch(f.repo), 'qa/first')
  const entry = (await f.read()).entries[0]
  await f.git.git(f.repo, ['update-ref', 'refs/heads/qa/first', entry.oid])
  plan = await f.read()
  const controller = new AbortController()
  let cancelled = false
  f.git.git = async (repo, args, options) => {
    if (args[0] === 'update-ref' && options?.onPrepared)
      options = {
        ...options,
        onPrepared: async () => {
          cancelled = true
          controller.abort()
          throw Error('cancelled while prepared')
        },
      }
    return original(repo, args, options)
  }
  const rejected = await f.git.recovery
    .execute(
      f.repo,
      { action: 'recovery-undo', planId: plan.id, confirmUnpublished: true },
      controller.signal,
    )
    .then(
      () => false,
      () => true,
    )

  assert.equal(cancelled, true)
  assert.equal(rejected, true)
  f.git.git = original
  assert.equal(await f.git.head(f.repo), f.head)
  assert.equal((await f.read()).entries.length, 1)
  await assert.rejects(fs.stat(path.join(f.repo, '.git', 'HEAD.lock')), /ENOENT/)
})
