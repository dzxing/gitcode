const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
const { classify } = require('../electron/gitflow.cjs')
const rules = {
  production: 'main',
  develop: 'develop',
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  versionTag: '',
}

async function setup(t, commit = true) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-flow-中文 ')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Flow Test'],
    ['user.email', 'flow@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', key, value])
  if (commit) {
    await fs.writeFile(path.join(repo, 'one.txt'), 'base\n')
    await git.git(repo, ['add', '--all'])
    await git.git(repo, ['commit', '-m', 'initial'])
  }
  const request = async (extra) => {
    const snapshot = await git.snapshot(repo)
    return {
      expectedHead: snapshot.head,
      expectedBranch: snapshot.branch,
      signature: snapshot.gitflow.signature,
      ...extra,
    }
  }
  const action = async (extra) => git.action(repo, await request(extra))
  const plan = async (config = rules, sources = { develop: 'refs/heads/main' }) =>
    git.flow.plan(repo, await request({ config, sources }))
  const initialize = async () => action({ action: 'gitflow-init', planId: (await plan()).id })
  const start = async (type = 'feature', name = 'login', switchAfter = true) =>
    action({
      action: 'gitflow-start',
      type,
      name,
      switchAfter,
      sourceOid: (
        await git.git(repo, ['rev-parse', type === 'hotfix' ? 'main' : 'develop'])
      ).trim(),
    })
  return { repo, git, request, action, plan, initialize, start }
}

test('GitFlow start retains the created branch without overwriting an ignored local file', async (t) => {
  const f = await setup(t)
  await f.initialize()
  await fs.writeFile(path.join(f.repo, '.gitignore'), 'private.txt\n')
  await f.git.git(f.repo, ['add', '.gitignore'])
  await f.git.git(f.repo, ['commit', '-m', 'ignore local data'])
  await f.git.git(f.repo, ['switch', 'develop'])
  await fs.writeFile(path.join(f.repo, 'private.txt'), 'tracked target\n')
  await f.git.git(f.repo, ['add', 'private.txt'])
  await f.git.git(f.repo, ['commit', '-m', 'target tracks path'])
  const target = await f.git.head(f.repo)
  await f.git.git(f.repo, ['switch', 'main'])
  await fs.writeFile(path.join(f.repo, 'private.txt'), 'local data to preserve\n')
  const result = await f.start()
  assert.equal(result.outcome, 'partial', JSON.stringify(result))
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(
    await fs.readFile(path.join(f.repo, 'private.txt'), 'utf8'),
    'local data to preserve\n',
  )
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'refs/heads/feature/login'])).trim(), target)
})

test('GitFlow save writes conventional repository keys, keeps unrelated config and does not create branches', async (t) => {
  const { repo, git, action } = await setup(t)
  await git.git(repo, ['config', 'remote.origin.url', 'https://example.com/repo'])
  const before = await git.head(repo)
  const result = await action({ action: 'gitflow-save', config: rules })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.snapshot.gitflow.ready, false)
  assert.deepEqual(result.snapshot.gitflow.missing, ['develop'])
  assert.equal((await git.git(repo, ['config', '--get', 'gitflow.branch.master'])).trim(), 'main')
  assert.equal(await git.git(repo, ['config', '--get', 'gitflow.prefix.versiontag']), '\n')
  assert.equal(
    (await git.git(repo, ['config', '--get', 'remote.origin.url'])).trim(),
    'https://example.com/repo',
  )
  assert.equal(await git.head(repo), before)
})

test('GitFlow initialization previews exact missing refs and preserves existing main and current checkout', async (t) => {
  const { git, repo, plan, action } = await setup(t)
  const preview = await plan()
  assert.deepEqual(preview.retained, ['main'])
  assert.deepEqual(
    preview.creates.map((x) => [x.name, x.sourceRef]),
    [['develop', 'refs/heads/main']],
  )
  const result = await action({ action: 'gitflow-init', planId: preview.id })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.gitflow.ready, true)
  assert.equal((await git.git(repo, ['rev-parse', 'develop'])).trim(), await git.head(repo))
  assert.equal((await action({ action: 'gitflow-init', planId: preview.id })).outcome, 'failed')
})

test('GitFlow init requires explicit existing source and refuses empty repository', async (t) => {
  const { plan } = await setup(t)
  await assert.rejects(plan(rules, {}), /明确选择/)
  const empty = await setup(t, false)
  await assert.rejects(empty.plan(), /首次提交/)
})

test('GitFlow preview rejects stale source OID without creating another missing branch', async (t) => {
  const { repo, git, request, plan } = await setup(t)
  const preview = await plan(
    { ...rules, production: 'production' },
    { production: 'refs/heads/main', develop: 'refs/heads/main' },
  )
  await git.git(repo, ['commit', '--allow-empty', '-m', 'advance'])
  // Even a forged fresh renderer context cannot change the frozen plan context.
  const result = await git.action(
    repo,
    await request({ action: 'gitflow-init', planId: preview.id }),
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(
    result.snapshot.branches.some((b) => b.name === 'production'),
    false,
  )
  assert.equal(
    result.snapshot.branches.some((b) => b.name === 'develop'),
    false,
  )
})

test('GitFlow transaction refuses branch created after preview and keeps both refs and config untouched', async (t) => {
  const { repo, git, plan, action } = await setup(t)
  const preview = await plan(
    { ...rules, production: 'production' },
    { production: 'refs/heads/main', develop: 'refs/heads/main' },
  )
  await git.git(repo, ['branch', 'develop'])
  const beforeConfig = await fs.readFile(path.join(repo, '.git/config'), 'utf8')
  const result = await action({ action: 'gitflow-init', planId: preview.id })
  assert.notEqual(result.outcome, 'succeeded')
  assert.equal(
    result.snapshot.branches.some((b) => b.name === 'production'),
    false,
  )
  assert.equal(await fs.readFile(path.join(repo, '.git/config'), 'utf8'), beforeConfig)
})

test('GitFlow save refuses changed config and preserves another process config lock', async (t) => {
  const { repo, git, request } = await setup(t)
  const old = await request({ action: 'gitflow-save', config: rules })
  await git.git(repo, ['config', 'user.name', 'changed externally'])
  assert.match((await git.action(repo, old)).error, /配置已变化/)
  const lock = path.join(repo, '.git/config.lock')
  await fs.writeFile(lock, 'other process')
  assert.match(
    (await git.action(repo, await request({ action: 'gitflow-save', config: rules }))).error,
    /其他 Git 操作/,
  )
  assert.equal(await fs.readFile(lock, 'utf8'), 'other process')
})

test('GitFlow rejects prefix overlap, base collisions and revision shorthand', async (t) => {
  const { action, git, repo } = await setup(t)
  for (const config of [
    { ...rules, hotfix: 'feature/hotfix/' },
    { ...rules, develop: 'main' },
    { ...rules, feature: 'main/' },
    { ...rules, production: '@{-1}' },
  ]) {
    assert.equal((await action({ action: 'gitflow-save', config })).outcome, 'failed')
  }
  assert.equal(
    await git.git(repo, ['config', '--get-regexp', '^gitflow\\.'], { allowedCodes: [0, 1] }),
    '',
  )
})

test('GitFlow Start freezes configured bases, creates local only, and supports optional switch', async (t) => {
  const { git, repo, initialize, start } = await setup(t)
  await initialize()
  await git.git(repo, ['switch', 'develop'])
  await git.git(repo, ['commit', '--allow-empty', '-m', 'develop advance'])
  const mainOid = (await git.git(repo, ['rev-parse', 'main'])).trim()
  const developOid = await git.head(repo)
  assert.notEqual(mainOid, developOid)
  const feature = await start('feature', '功能/login', true)
  assert.equal(feature.outcome, 'succeeded')
  assert.equal(feature.snapshot.branch, 'feature/功能/login')
  assert.equal(feature.snapshot.head, developOid)
  assert.equal(feature.snapshot.branches.find((b) => b.current).upstream, '')
  const release = await start('release', '1.0', false)
  assert.equal(release.outcome, 'succeeded')
  assert.equal(release.snapshot.branch, 'feature/功能/login')
  const hotfix = await start('hotfix', '1.0.1', true)
  assert.equal(hotfix.snapshot.head, mainOid)
  assert.match(hotfix.output, /尚未推送/)
})

test('GitFlow Start restores local work and rejects stale source, duplicates and unfinished merges', async (t) => {
  const { git, repo, initialize, start, request } = await setup(t)
  await initialize()
  const source = (await git.git(repo, ['rev-parse', 'develop'])).trim()
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'keep')
  const protectedStart = await start('feature', 'protected')
  assert.equal(protectedStart.outcome, 'succeeded', JSON.stringify(protectedStart))
  assert.equal(await fs.readFile(path.join(repo, 'dirty.txt'), 'utf8'), 'keep')
  assert.equal(protectedStart.snapshot.stashes.length, 0)
  await fs.rm(path.join(repo, 'dirty.txt'))
  await git.git(repo, ['switch', 'develop'])
  await git.git(repo, ['commit', '--allow-empty', '-m', 'advance'])
  assert.match(
    (
      await git.action(
        repo,
        await request({
          action: 'gitflow-start',
          type: 'feature',
          name: 'stale',
          switchAfter: false,
          sourceOid: source,
        }),
      )
    ).error,
    /目标分支已变化/,
  )
  assert.equal((await start()).outcome, 'succeeded')
  assert.equal((await start()).outcome, 'failed')
  await fs.writeFile(path.join(repo, '.git/MERGE_HEAD'), source + '\n')
  assert.match((await start('feature', 'blocked')).error, /未完成/)
})

test('GitFlow Start reports created branch when a post-checkout hook fails', async (t) => {
  const { git, repo, initialize, start } = await setup(t)
  await initialize()
  const hooks = path.join(repo, '.git/custom-hooks')
  await fs.mkdir(hooks)
  await fs.writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await git.git(repo, ['config', 'core.hooksPath', hooks])
  const result = await start()
  assert.equal(result.outcome, 'partial')
  assert.equal(
    result.snapshot.branches.some((b) => b.name === 'feature/login'),
    true,
  )
  assert.match(result.warning, /已创建/)
})

test('GitFlow preserves unrelated include config and blocks managed external rules', async (t) => {
  const { git, repo, action } = await setup(t)
  const included = path.join(repo, '.git/extra.config')
  await fs.writeFile(included, '[user]\n\tname = included-user\n')
  await git.git(repo, ['config', 'include.path', included])
  assert.equal((await action({ action: 'gitflow-save', config: rules })).outcome, 'succeeded')
  assert.equal((await git.git(repo, ['config', '--get', 'user.name'])).trim(), 'included-user')
  await fs.appendFile(included, '[gitflow "prefix"]\n\tfeature = other/\n')
  const result = await action({ action: 'gitflow-save', config: rules })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /include/)
})

test('GitFlow categorization does not infer lifecycle or include unrelated prefixes', () => {
  assert.equal(classify(rules, 'main'), 'production')
  assert.equal(classify(rules, 'feature/old-already-merged'), 'feature')
  assert.equal(classify(rules, 'feature/'), null)
  assert.equal(classify(rules, 'feature-other'), null)
  assert.equal(classify(rules, 'origin/feature/test'), null)
})

test('GitFlow creation cancellation after ref creation reports uncertain partial success', async (t) => {
  const { git, initialize, start } = await setup(t)
  await initialize()
  const original = git.git.bind(git)
  git.git = async (repo, args, options) => {
    const result = await original(repo, args, options)
    if (args[0] === 'branch' && args.includes('feature/cancelled')) {
      git.git = original
      throw new Error('Git 操作已取消。取消不等于回滚。')
    }
    return result
  }
  const result = await start('feature', 'cancelled', false)
  assert.equal(result.outcome, 'partial')
  assert.equal(
    result.snapshot.branches.some((b) => b.name === 'feature/cancelled'),
    true,
  )
  assert.match(result.warning, /已检测到分支/)
})

test('GitFlow reports unfinished operation even with a clean index and worktree', async (t) => {
  const { repo, git, initialize } = await setup(t)
  await initialize()
  await fs.writeFile(path.join(repo, '.git/MERGE_HEAD'), (await git.head(repo)) + '\n')
  const snapshot = await git.snapshot(repo)
  assert.deepEqual(snapshot.staged, [])
  assert.deepEqual(snapshot.unstaged, [])
  assert.equal(snapshot.gitflow.ready, true)
  assert.match(snapshot.gitflow.operationError, /未完成/)
})

test('GitFlow canonicalizes worktreeConfig boolean aliases before allowing writes', async (t) => {
  const { repo, git, action, initialize, start } = await setup(t)
  await initialize()
  await git.git(repo, ['config', 'extensions.worktreeConfig', 'yes'])
  const snapshot = await git.snapshot(repo)
  assert.match(snapshot.gitflow.writeError, /worktree/)
  const saved = await action({ action: 'gitflow-save', config: { ...rules, versionTag: 'v' } })
  assert.equal(saved.outcome, 'failed')
  assert.match(saved.error, /worktree/)
  assert.equal((await start('feature', 'read-only-rules', false)).outcome, 'succeeded')
})

test('GitFlow accepts worktree scalar overrides but rejects duplicate values in that scope', async (t) => {
  const { repo, git, action, initialize, start } = await setup(t)
  await initialize()
  await git.git(repo, ['config', 'extensions.worktreeConfig', 'true'])
  await git.git(repo, ['branch', 'integration'])
  await git.git(repo, ['config', '--worktree', 'gitflow.branch.develop', 'integration'])
  let snapshot = await git.snapshot(repo)
  assert.equal(snapshot.gitflow.config.develop, 'integration')
  assert.equal(snapshot.gitflow.ready, true, snapshot.gitflow.error)
  assert.equal(snapshot.gitflow.error, '')
  assert.match(snapshot.gitflow.writeError, /worktree/)
  assert.equal((await start('feature', 'worktree-override', false)).outcome, 'succeeded')
  const saved = await action({
    action: 'gitflow-save',
    config: { ...rules, develop: 'integration' },
  })
  assert.equal(saved.outcome, 'failed')
  assert.match(saved.error, /worktree/)
  await git.git(repo, ['config', '--worktree', '--add', 'gitflow.branch.develop', 'develop'])
  snapshot = await git.snapshot(repo)
  assert.equal(snapshot.gitflow.ready, false)
  assert.match(snapshot.gitflow.error, /重复/)
})

test('GitFlow init does not offer a plan for conflicting branch namespaces', async (t) => {
  const { repo, git, plan } = await setup(t)
  await git.git(repo, ['branch', 'develop/old'])
  await assert.rejects(plan(), /目录冲突/)
  assert.equal((await git.snapshot(repo)).gitflow.configured, false)
})

test('GitFlow failed save preserves a foreign nested config lock byte for byte', async (t) => {
  const { repo, action } = await setup(t)
  const nested = path.join(repo, '.git/config.lock.lock')
  const foreign = Buffer.from('foreign-lock-owner\n中文\0')
  await fs.writeFile(nested, foreign)
  const result = await action({ action: 'gitflow-save', config: rules })
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(await fs.readFile(nested), foreign)
  await assert.rejects(fs.stat(path.join(repo, '.git/config.lock')), { code: 'ENOENT' })
  await fs.rm(nested)
  assert.equal((await action({ action: 'gitflow-save', config: rules })).outcome, 'succeeded')
})

test('GitFlow preserves case-sensitive subsections while accepting section and variable case', async (t) => {
  const { repo, git, action } = await setup(t)
  await git.git(repo, ['branch', 'develop'])
  await git.git(repo, ['config', 'GitFlow.branch.Master', 'main'])
  await git.git(repo, ['config', 'GitFlow.branch.Develop', 'develop'])
  for (const [key, value] of [
    ['Feature', 'other/'],
    ['Release', 'Release/'],
    ['Hotfix', 'Hotfix/'],
    ['VersionTag', 'V'],
  ])
    await git.git(repo, ['config', `GitFlow.PREFIX.${key}`, value])
  let snapshot = await git.snapshot(repo)
  assert.equal(snapshot.gitflow.configured, false)
  assert.equal(snapshot.gitflow.ready, false)
  assert.equal(
    await git.git(repo, ['config', '--get', 'gitflow.prefix.feature'], { allowedCodes: [0, 1] }),
    '',
  )
  assert.equal((await action({ action: 'gitflow-save', config: rules })).outcome, 'succeeded')
  snapshot = await git.snapshot(repo)
  assert.equal(snapshot.gitflow.ready, true)
  assert.equal(
    (await git.git(repo, ['config', '--get', 'gitflow.PREFIX.feature'])).trim(),
    'other/',
  )
  assert.equal(
    (await git.git(repo, ['config', '--get', 'gitflow.prefix.feature'])).trim(),
    'feature/',
  )
})

test('GitFlow rechecks checkout context and refs after creation without reverting external changes', async (t) => {
  for (const changed of ['head', 'source', 'created']) {
    const { repo, git, initialize, start } = await setup(t)
    await initialize()
    const first = await git.head(repo)
    await git.git(repo, ['commit', '--allow-empty', '-m', 'main ahead'])
    const ahead = await git.head(repo),
      original = git.git.bind(git)
    const branch = `feature/${changed}`
    git.git = async (root, args, options) => {
      const out = await original(root, args, options)
      if (args[0] === 'branch' && args.includes(branch)) {
        git.git = original
        if (changed === 'head') await original(repo, ['switch', 'develop'])
        else
          await original(repo, [
            'update-ref',
            changed === 'source' ? 'refs/heads/develop' : `refs/heads/${branch}`,
            ahead,
            first,
          ])
      }
      return out
    }
    const result = await start('feature', changed, true)
    assert.equal(result.outcome, 'partial', changed)
    assert.match(result.warning, /已创建/)
    assert.equal(result.snapshot.branch, changed === 'head' ? 'develop' : 'main')
    assert.equal(
      result.snapshot.branches.find((b) => b.name === branch).hash,
      changed === 'created' ? ahead : first,
    )
    if (changed === 'source')
      assert.equal(result.snapshot.branches.find((b) => b.name === 'develop').hash, ahead)
  }
})

test('GitFlow enforces the declared whitespace policy and leaves valid Unicode branches available', async (t) => {
  const { git, repo, initialize, start, action } = await setup(t)
  await initialize()
  for (const name of ['a b', 'a\u00a0b', 'a\u2003b']) {
    assert.equal((await start('feature', name, false)).outcome, 'failed')
    assert.equal(
      (
        await git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/feature/${name}`], {
          allowedCodes: [0, 1],
        })
      ).trim(),
      '',
    )
  }
  assert.equal(
    (await action({ action: 'gitflow-save', config: { ...rules, production: 'HEAD' } })).outcome,
    'failed',
  )
  assert.equal((await start('feature', '中文/HEAD', false)).outcome, 'succeeded')
})
