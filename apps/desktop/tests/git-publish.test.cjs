const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-publish-')),
    repo = path.join(root, 'local'),
    bare = path.join(root, 'remote.git'),
    git = new GitService()
  await fs.mkdir(repo)
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'main'])
  for (const [k, v] of [
    ['user.name', 'Publish test'],
    ['user.email', 'publish@test.local'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', k, v])
  const write = (file, text) => fs.writeFile(path.join(repo, file), text),
    commit = async (message) => {
      await git.git(repo, ['add', '.'])
      await git.git(repo, ['commit', '-m', message])
      return git.head(repo)
    }
  await write('base.txt', 'base\n')
  const base = await commit('base')
  await git.git(repo, ['init', '--bare', bare])
  await git.git(repo, ['remote', 'add', 'origin', bare])
  await git.git(repo, ['push', '-u', 'origin', 'main'])
  await git.git(repo, ['switch', '-c', 'feature/topic'])
  await write('feature.txt', 'work\n')
  const tip = await commit('feature')
  await git.git(repo, ['switch', 'main'])
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
    sourceRef: 'refs/heads/feature/topic',
    sourceOid: tip,
  })
  const plan = async (publish) =>
    git.syncPlan(repo, 'push', { ...(await context()), ...(publish ? { publish } : {}) })
  const execute = async (plan) => git.action(repo, { action: 'push', planId: plan.id })
  return { root, repo, bare, git, write, commit, base, tip, plan, execute }
}
test('push accepts a single URL alias but rejects a rewrite chain before inspecting another repository', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['config', `url.${f.bare}.insteadOf`, 'publish-alias:'])
  await f.git.git(f.repo, ['config', 'remote.origin.url', 'publish-alias:'])
  assert.equal((await f.plan()).remoteCheck.state, 'absent')
  const other = path.join(f.root, 'other.git')
  await f.git.git(f.repo, ['init', '--bare', other])
  await f.git.git(f.repo, ['config', `url.${other}.insteadOf`, f.bare])
  let contactedOther = false
  const run = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args[0] === 'ls-remote') contactedOther = true
    return run(repo, args, options)
  }
  await assert.rejects(f.plan(), /多级重写/)
  assert.equal(contactedOther, false)
  for (const remote of [f.bare, other])
    assert.equal(
      (
        await run(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/topic'])
      ).trim(),
      '',
    )
})

test('first push defaults to same named origin branch and links it only after publication', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  assert.deepEqual(p.publish, { remote: 'origin', branch: 'feature/topic', remotes: ['origin'] })
  assert.equal(p.destinationRef, 'refs/heads/feature/topic')
  assert.equal(
    (
      await f.git.git(f.repo, ['config', '--get', 'branch.feature/topic.remote'], {
        allowedCodes: [0, 1],
      })
    ).trim(),
    '',
  )
  const result = await f.execute(p)
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.head, f.base)
  assert.equal(
    result.snapshot.branches.find((b) => b.name === 'feature/topic').upstream,
    'origin/feature/topic',
  )
  assert.equal((await f.git.git(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), f.tip)
  assert.equal((await f.plan()).publish, undefined)
})
test('explicit remote and destination publish only selected committed content and retain dirty worktree', async (t) => {
  const f = await fixture(t),
    second = path.join(f.root, 'second.git')
  await f.git.git(f.repo, ['init', '--bare', second])
  await f.git.git(f.repo, ['remote', 'add', 'backup', second])
  await f.write('draft.txt', 'must stay local\n')
  const p = await f.plan({ remote: 'backup', branch: 'review/topic' })
  const result = await f.execute(p)
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(
    result.snapshot.branches.find((b) => b.name === 'feature/topic').upstream,
    'backup/review/topic',
  )
  assert.equal((await f.git.git(second, ['rev-parse', 'refs/heads/review/topic'])).trim(), f.tip)
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'must stay local\n')
  assert.equal(
    (await f.git.git(second, ['ls-tree', '--name-only', f.tip])).includes('draft.txt'),
    false,
  )
})
for (const changed of ['source', 'config'])
  test(`stale ${changed} rejects publication before network write`, async (t) => {
    const f = await fixture(t),
      p = await f.plan()
    if (changed === 'source')
      await f.git.git(f.repo, ['update-ref', 'refs/heads/feature/topic', f.base])
    else await f.git.git(f.repo, ['config', 'remote.pushDefault', 'origin'])
    const result = await f.execute(p)
    assert.equal(result.outcome, 'failed')
    assert.equal(
      (
        await f.git.git(f.bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/topic'])
      ).trim(),
      '',
    )
    assert.equal(
      (
        await f.git.git(f.repo, ['config', '--get', 'branch.feature/topic.remote'], {
          allowedCodes: [0, 1],
        })
      ).trim(),
      '',
    )
  })
test('first push rejects divergent existing destination without force or associating branch', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['switch', '-c', 'other'])
  await f.write('other.txt', 'other\n')
  const other = await f.commit('other')
  await f.git.git(f.repo, ['push', 'origin', `${other}:refs/heads/feature/topic`])
  await f.git.git(f.repo, ['switch', 'main'])
  const result = await f.execute(await f.plan())
  assert.equal(result.outcome, 'failed')
  assert.equal(result.syncProblem, 'push-rejected')
  assert.equal((await f.git.git(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), other)
  assert.equal(
    (
      await f.git.git(f.repo, ['config', '--get', 'branch.feature/topic.remote'], {
        allowedCodes: [0, 1],
      })
    ).trim(),
    '',
  )
})
test('post-push association failure reports partial and preserves the published remote commit', async (t) => {
  const f = await fixture(t),
    p = await f.plan(),
    native = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args.some((a) => a.startsWith('--set-upstream-to=')))
      throw new Error('simulated config lock')
    return native(repo, args, options)
  }
  const result = await f.execute(p)
  assert.equal(result.outcome, 'partial')
  assert.match(result.warning, /提交已推送.*关联未完成/)
  assert.equal((await native(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), f.tip)
})
test('invalid target, unknown remote and unsafe remote options fail during planning', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.plan({ remote: 'origin', branch: 'bad..branch' }))
  await assert.rejects(f.plan({ remote: 'unknown', branch: 'topic' }))
  await f.git.git(f.repo, ['config', 'remote.origin.mirror', 'true'])
  await assert.rejects(f.plan(), /镜像/)
})

test('an already up-to-date remote branch can be associated on first push', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['push', 'origin', `${f.tip}:refs/heads/feature/topic`])
  await f.git.git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/feature/topic'])
  const result = await f.execute(await f.plan())
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(
    result.snapshot.branches.find((b) => b.name === 'feature/topic').upstream,
    'origin/feature/topic',
  )
})

test('explicit first-push target remains the next push target despite a global push default', async (t) => {
  const f = await fixture(t)
  const backup = path.join(f.root, 'backup.git')
  await f.git.git(f.repo, ['init', '--bare', backup])
  await f.git.git(f.repo, ['remote', 'add', 'backup', backup])
  await f.git.git(f.repo, ['config', 'remote.pushDefault', 'origin'])
  const result = await f.execute(await f.plan({ remote: 'backup', branch: 'review/topic' }))
  assert.equal(result.outcome, 'succeeded', result.error)
  const next = await f.plan()
  assert.equal(next.remotes[0].name, 'backup')
  assert.equal(next.destinationRef, 'refs/heads/review/topic')
})

test('remote inspection distinguishes absent, existing, divergence and unreachable targets', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.plan()).remoteCheck.state, 'absent')
  await f.git.git(f.repo, ['push', 'origin', `${f.base}:refs/heads/feature/topic`])
  const forward = await f.plan()
  assert.equal(forward.remoteCheck.state, 'forward')
  assert.equal(forward.remoteCheck.ahead, 1)
  await f.write('other.txt', 'remote-side\n')
  const other = await f.commit('remote-side')
  await f.git.git(f.repo, ['push', 'origin', `${other}:refs/heads/feature/topic`])
  const diverged = await f.plan()
  assert.equal(diverged.remoteCheck.state, 'diverged')
  assert.equal((await f.execute(diverged)).outcome, 'failed')
  assert.equal((await f.git.git(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), other)
  await f.git.git(f.repo, [
    'remote',
    'set-url',
    '--push',
    'origin',
    path.join(f.root, 'missing.git'),
  ])
  assert.equal((await f.plan()).remoteCheck.state, 'error')
})

test('confirmed creation refuses a branch created concurrently even when fast-forwardable', async (t) => {
  const f = await fixture(t),
    plan = await f.plan()
  await f.git.git(f.repo, ['push', 'origin', `${f.base}:refs/heads/feature/topic`])
  assert.equal((await f.execute(plan)).outcome, 'failed')
  assert.equal((await f.git.git(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), f.base)
})

test('confirmed update refuses concurrent deletion and marks a deleted tracked target explicitly', async (t) => {
  const f = await fixture(t)
  await f.execute(await f.plan())
  const plan = await f.plan()
  assert.equal(plan.remoteCheck.state, 'current')
  await f.git.git(f.bare, ['update-ref', '-d', 'refs/heads/feature/topic'])
  assert.equal((await f.execute(plan)).outcome, 'failed')
  const deleted = await f.plan()
  assert.equal(deleted.remoteCheck.state, 'deleted')
  assert.equal((await f.execute(deleted)).outcome, 'succeeded')
})

test('inspection uses the push URL and leaves FETCH_HEAD and remote tracking refs untouched', async (t) => {
  const f = await fixture(t),
    other = path.join(f.root, 'push.git')
  await f.git.git(f.repo, ['init', '--bare', other])
  await f.git.git(f.repo, ['remote', 'set-url', '--push', 'origin', other])
  await f.git.git(f.repo, ['push', other, `${f.base}:refs/heads/feature/topic`])
  await fs.writeFile(path.join(f.repo, '.git', 'FETCH_HEAD'), 'sentinel\n')
  const before = await f.git.git(f.repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes',
  ])
  const plan = await f.plan()
  assert.equal(plan.remoteCheck.state, 'forward')
  assert.equal(plan.remoteCheck.oid, f.base)
  assert.equal(await fs.readFile(path.join(f.repo, '.git', 'FETCH_HEAD'), 'utf8'), 'sentinel\n')
  assert.equal(
    await f.git.git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']),
    before,
  )
})

test('a confirmed fast-forward cannot overwrite a concurrent remote update', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['push', 'origin', `${f.base}:refs/heads/feature/topic`])
  const plan = await f.plan()
  assert.equal(plan.remoteCheck.state, 'forward')
  await f.write('concurrent.txt', 'remote contribution\n')
  const concurrent = await f.commit('concurrent remote update')
  await f.git.git(f.repo, ['push', 'origin', `${concurrent}:refs/heads/feature/topic`])
  assert.equal((await f.execute(plan)).outcome, 'failed')
  assert.equal(
    (await f.git.git(f.bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(),
    concurrent,
  )
})

test('a new triangular push target is creation, not deletion of the existing upstream', async (t) => {
  const f = await fixture(t)
  await f.execute(await f.plan())
  const backup = path.join(f.root, 'backup.git')
  await f.git.git(f.repo, ['init', '--bare', backup])
  await f.git.git(f.repo, ['remote', 'add', 'backup', backup])
  await f.git.git(f.repo, ['config', 'branch.feature/topic.pushRemote', 'backup'])
  const plan = await f.plan()
  assert.equal(plan.remoteCheck.state, 'absent')
  assert.equal(plan.publish, undefined)
  assert.equal((await f.execute(plan)).outcome, 'succeeded')
  assert.equal(
    (await f.git.git(f.repo, ['config', '--get', 'branch.feature/topic.remote'])).trim(),
    'origin',
  )
})

test('same-name tag cannot turn an existing upstream into a different first-push target', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['tag', 'main'])
  const plan = await f.git.syncPlan(f.repo, 'push', {
    expectedHead: f.base,
    expectedBranch: 'main',
  })
  assert.equal(plan.branch, 'main')
  assert.equal(plan.sourceRef, 'refs/heads/main')
  assert.equal(plan.destinationRef, 'refs/heads/main')
  assert.equal(plan.publish, undefined)
  const result = await f.execute(plan)
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.deepEqual(
    (
      await f.git.git(f.repo, [
        '--git-dir=' + f.bare,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ])
    )
      .trim()
      .split('\n'),
    ['refs/heads/main'],
  )
})

test('same-name tag on an unpublished branch preserves exact first-push target', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['switch', 'feature/topic'])
  await f.git.git(f.repo, ['tag', 'feature/topic'])
  const plan = await f.git.syncPlan(f.repo, 'push', {
    expectedHead: f.tip,
    expectedBranch: 'feature/topic',
  })
  assert.equal(plan.sourceRef, 'refs/heads/feature/topic')
  assert.equal(plan.destinationRef, 'refs/heads/feature/topic')
  const result = await f.execute(plan)
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(
    (
      await f.git.git(f.repo, ['--git-dir=' + f.bare, 'rev-parse', 'refs/heads/feature/topic'])
    ).trim(),
    f.tip,
  )
})
