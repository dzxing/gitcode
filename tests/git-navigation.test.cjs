const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-navigation-')),
    repo = path.join(root, 'local'),
    remote = path.join(root, 'remote.git'),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await fs.mkdir(repo)
  await git.git(repo, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Navigation test'],
    ['user.email', 'navigation@test.local'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', key, value])
  const write = (file, value) => fs.writeFile(path.join(repo, file), value)
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  await write('base.txt', 'base\n')
  const base = await commit('base')
  const request = async (fullRef, extra = {}) => ({
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
    fullRef,
    expectedOid: (await git.git(repo, ['rev-parse', '--verify', fullRef])).trim(),
    ...extra,
  })
  const act = async (fullRef, extra) => git.action(repo, await request(fullRef, extra))
  const topic = async (file = 'topic.txt', value = 'topic\n') => {
    await git.git(repo, ['switch', '-c', 'topic'])
    await write(file, value)
    const oid = await commit('topic')
    await git.git(repo, ['switch', 'main'])
    return oid
  }
  const connect = async () => {
    await git.git(root, ['init', '--bare', remote])
    await git.git(repo, ['remote', 'add', 'origin', remote])
    await git.git(repo, ['push', 'origin', 'main:topic'])
    return 'refs/remotes/origin/topic'
  }
  return { root, repo, remote, git, write, commit, base, request, act, topic, connect }
}
test('reference info verifies raw ref, resolves annotated tags and rejects stale context', async (t) => {
  const { repo, git, topic, request, base } = await fixture(t),
    oid = await topic()
  const info = await git.navigation.read(repo, await request('refs/heads/topic', { kind: 'info' }))
  assert.equal(info.canFastForward, true)
  assert.equal(info.oid, oid)
  assert.equal(info.head, base)
  await git.git(repo, ['tag', '-a', 'v1', '-m', 'annotation', 'topic'])
  const tag = await git.navigation.read(repo, await request('refs/tags/v1', { kind: 'info' }))
  assert.equal(tag.oid, oid)
  assert.notEqual(tag.referenceOid, oid)
  await assert.rejects(
    git.navigation.read(
      repo,
      await request('refs/heads/topic', { kind: 'info', expectedOid: base }),
    ),
    /已变化/,
  )
  await assert.rejects(
    git.navigation.read(
      repo,
      await request('refs/heads/topic', { kind: 'info', expectedHead: oid }),
    ),
    /变化/,
  )
})
test('fast forward requires confirmation, auto-stashes local edits and keeps the current branch', async (t) => {
  const { repo, git, topic, act, write, base } = await fixture(t),
    oid = await topic()
  assert.equal((await act('refs/heads/topic', { action: 'fast-forward' })).outcome, 'failed')
  await write('draft.txt', 'draft\n')
  const dirty = await act('refs/heads/topic', { action: 'fast-forward', confirm: true })
  assert.equal(dirty.outcome, 'succeeded', dirty.error)
  assert.equal(await fs.readFile(repo + '/draft.txt', 'utf8'), 'draft\n')
  assert.equal(dirty.snapshot.stashes.length, 0)
  assert.equal(await git.head(repo), oid)
  assert.equal(await git.currentBranch(repo), 'main')
})
test('diverged history refuses fast forward and ordinary merge commits a clean result automatically', async (t) => {
  const { repo, git, topic, write, commit, act } = await fixture(t),
    incoming = await topic()
  await write('main.txt', 'main\n')
  const head = await commit('parallel')
  const refused = await act('refs/heads/topic', { action: 'fast-forward', confirm: true })
  assert.equal(refused.outcome, 'failed')
  assert.equal(await git.head(repo), head)
  const result = await act('refs/heads/topic', { action: 'merge-branch', confirm: true })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.merge, null)
  assert.equal(
    (await git.git(repo, ['show', '-s', '--format=%P', 'HEAD'])).trim(),
    `${head} ${incoming}`,
  )
})
test('conflicting merge uses the existing resolver and cancellation preserves original edits', async (t) => {
  const { repo, git, topic, write, commit, act } = await fixture(t)
  await topic('base.txt', 'topic\n')
  await write('base.txt', 'main\n')
  const head = await commit('parallel')
  const result = await act('refs/heads/topic', { action: 'merge-branch', confirm: true })
  assert.equal(result.outcome, 'partial')
  assert.ok(result.snapshot.merge.files.some((file) => file.path === 'base.txt'))
  assert.equal(await git.head(repo), head)
  const abort = await git.action(repo, {
    action: 'merge-abort',
    expectedHead: head,
    expectedBranch: 'main',
    mergeSignature: result.snapshot.merge.signature,
  })
  assert.equal(abort.outcome, 'succeeded')
  assert.equal(await fs.readFile(repo + '/base.txt', 'utf8'), 'main\n')
})
test('lightweight and annotated tags use the selected commit, never overwrite or unexpectedly sign', async (t) => {
  const { repo, git, topic, act, base } = await fixture(t),
    oid = await topic()
  await git.git(repo, ['config', 'tag.gpgsign', 'true'])
  const light = await act('refs/heads/topic', {
    action: 'create-tag',
    name: 'v1',
    annotated: false,
    message: '',
  })
  assert.equal(light.outcome, 'succeeded', light.error)
  assert.equal((await git.git(repo, ['cat-file', '-t', 'refs/tags/v1'])).trim(), 'commit')
  assert.equal((await git.git(repo, ['rev-parse', 'v1'])).trim(), oid)
  const annotated = await act('refs/heads/topic', {
    action: 'create-tag',
    name: 'v2',
    annotated: true,
    message: 'Release notes',
  })
  assert.equal(annotated.outcome, 'succeeded', annotated.error)
  assert.equal((await git.git(repo, ['cat-file', '-t', 'refs/tags/v2'])).trim(), 'tag')
  assert.equal(
    (
      await act('refs/heads/main', {
        action: 'create-tag',
        name: 'v1',
        annotated: false,
        message: '',
      })
    ).outcome,
    'failed',
  )
  assert.equal((await git.git(repo, ['rev-parse', 'v1'])).trim(), oid)
  assert.equal(
    (
      await act('refs/heads/topic', {
        action: 'create-tag',
        name: '-bad',
        annotated: false,
        message: '',
      })
    ).outcome,
    'failed',
  )
  const raw = await git.action(repo, {
    expectedHead: base,
    expectedBranch: 'main',
    fullRef: oid,
    expectedOid: oid,
    action: 'create-tag',
    name: 'raw-commit',
    annotated: false,
    message: '',
  })
  assert.equal(raw.outcome, 'succeeded', raw.error)
})
test('comparison is read-only, directional and includes staged, unstaged and untracked Unicode paths', async (t) => {
  const { repo, git, topic, write, request, base } = await fixture(t)
  await topic('base.txt', 'topic\n')
  await write('staged.txt', 'staged\n')
  await git.git(repo, ['add', 'staged.txt'])
  await write('新 文件.txt', 'new local\n')
  await write('base.txt', 'working\n')
  const before = await git.indexFingerprint(repo),
    status = await git.status(repo)
  const head = await git.navigation.read(
    repo,
    await request('refs/heads/topic', { kind: 'compare-head', file: 'base.txt' }),
  )
  assert.match(head.diff.diff, /\+base/)
  assert.match(head.diff.diff, /-topic/)
  const working = await git.navigation.read(
    repo,
    await request('refs/heads/topic', { kind: 'compare-working' }),
  )
  assert.deepEqual(
    working.files.map((file) => file.path).sort(),
    ['base.txt', 'staged.txt', '新 文件.txt'].sort(),
  )
  const untracked = await git.navigation.read(
    repo,
    await request('refs/heads/topic', { kind: 'compare-working', file: '新 文件.txt' }),
  )
  assert.match(untracked.diff.diff, /\+new local/)
  assert.equal(await git.head(repo), base)
  assert.equal(await git.indexFingerprint(repo), before)
  assert.deepEqual(await git.status(repo), status)
  await assert.rejects(
    git.navigation.read(
      repo,
      await request('refs/heads/topic', { kind: 'compare-working', file: '../outside' }),
    ),
    /无效|路径/,
  )
})
test('a file removed from index then recreated is compared against its real base contents', async (t) => {
  const { repo, git, write, request } = await fixture(t)
  await git.git(repo, ['rm', 'base.txt'])
  await write('base.txt', 'recreated\n')
  const result = await git.navigation.read(
    repo,
    await request('refs/heads/main', { kind: 'compare-working', file: 'base.txt' }),
  )
  assert.match(result.diff.diff, /-base/)
  assert.match(result.diff.diff, /\+recreated/)
  assert.equal(result.files.find((file) => file.path === 'base.txt').status, 'M')
})
test('remote deletion confirms server tip and preserves every local branch', async (t) => {
  const { repo, remote, git, connect, request, base } = await fixture(t),
    ref = await connect()
  await git.git(repo, ['branch', 'topic'])
  const plan = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  assert.equal(plan.remote.oid, base)
  assert.equal(plan.remote.url, undefined)
  const result = await git.action(
    repo,
    await request(ref, {
      action: 'delete-remote-branch',
      confirm: true,
      remoteSignature: plan.remote.signature,
    }),
  )
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(
    (await git.git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/topic'])).trim(),
    '',
  )
  assert.equal((await git.git(repo, ['rev-parse', 'refs/heads/topic'])).trim(), base)
  assert.equal(await git.currentBranch(repo), 'main')
  assert.ok(!result.snapshot.branches.some((branch) => branch.fullRef === ref))
})
test('changed remote tip or configuration blocks deletion before pushing', async (t) => {
  const { repo, remote, git, connect, request, write, commit } = await fixture(t),
    ref = await connect(),
    plan = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  await write('new.txt', 'new\n')
  const tip = await commit('new')
  await git.git(repo, ['push', 'origin', 'main:topic'])
  const stale = await git.action(repo, {
    expectedHead: await git.head(repo),
    expectedBranch: 'main',
    fullRef: ref,
    expectedOid: plan.referenceOid,
    action: 'delete-remote-branch',
    confirm: true,
    remoteSignature: plan.remote.signature,
  })
  assert.equal(stale.outcome, 'failed')
  assert.equal((await git.git(remote, ['rev-parse', 'refs/heads/topic'])).trim(), tip)
  const newer = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  await git.git(repo, ['config', 'navigation.changed', 'yes'])
  const changed = await git.action(
    repo,
    await request(ref, {
      action: 'delete-remote-branch',
      confirm: true,
      remoteSignature: newer.remote.signature,
    }),
  )
  assert.equal(changed.outcome, 'failed')
  assert.match(changed.error, /配置已变化/)
})
test('server updates racing after the final check are protected by the exact expected tip', async (t) => {
  const { repo, remote, git, connect, request, write, commit } = await fixture(t),
    ref = await connect(),
    plan = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  await write('new.txt', 'new\n')
  const tip = await commit('new')
  await git.git(repo, ['push', 'origin', `main:refs/heads/other`])
  const run = git.git.bind(git)
  let raced = false
  git.git = async (location, args, options) => {
    if (
      !raced &&
      args.includes('push') &&
      args.some((arg) => arg.startsWith('--force-with-lease='))
    ) {
      raced = true
      await run(remote, ['update-ref', 'refs/heads/topic', tip])
    }
    return run(location, args, options)
  }
  const result = await git.action(
    repo,
    await request(ref, {
      action: 'delete-remote-branch',
      confirm: true,
      remoteSignature: plan.remote.signature,
    }),
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(raced, true)
  assert.equal((await run(remote, ['rev-parse', 'refs/heads/topic'])).trim(), tip)
})
test('a lost deletion response reports an uncertain completed server state without retrying', async (t) => {
  const { repo, remote, git, connect, request } = await fixture(t),
    ref = await connect(),
    plan = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  const run = git.git.bind(git)
  let pushes = 0
  git.git = async (location, args, options) => {
    if (args.includes('push') && args.some((arg) => arg.startsWith('--force-with-lease='))) {
      pushes++
      await run(location, args, options)
      throw new Error('connection lost after server response')
    }
    return run(location, args, options)
  }
  const result = await git.action(
    repo,
    await request(ref, {
      action: 'delete-remote-branch',
      confirm: true,
      remoteSignature: plan.remote.signature,
    }),
  )
  assert.equal(result.outcome, 'partial')
  assert.match(result.warning, /已不存在|不要重复/)
  assert.equal(pushes, 1)
  assert.equal(
    (await run(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/topic'])).trim(),
    '',
  )
})
test('ordinary URL aliases are supported but rewrite chains cannot silently change deletion targets', async (t) => {
  const { repo, remote, git, connect, request } = await fixture(t),
    ref = await connect()
  await git.git(repo, ['config', `url.${remote}.insteadOf`, 'navigation-alias:'])
  await git.git(repo, ['config', 'remote.origin.url', 'navigation-alias:'])
  const plan = await git.navigation.read(repo, await request(ref, { kind: 'delete-remote' }))
  assert.ok(plan.remote.signature)
  await git.git(repo, ['config', `url.${remote}-other.insteadOf`, remote])
  await assert.rejects(
    git.navigation.read(repo, await request(ref, { kind: 'delete-remote' })),
    /多级重写/,
  )
  assert.ok((await git.git(remote, ['rev-parse', 'refs/heads/topic'])).trim())
})
test('empty untracked files remain visible in comparison and temporary paths are not exposed', async (t) => {
  const { repo, git, write, request } = await fixture(t)
  await write('empty.txt', '')
  const result = await git.navigation.read(
    repo,
    await request('refs/heads/main', { kind: 'compare-working', file: 'empty.txt' }),
  )
  assert.ok(result.files.some((file) => file.path === 'empty.txt'))
  assert.match(result.diff.diff, /new file mode/)
  assert.doesNotMatch(result.diff.diff, /gitcode-compare-|\/before|\/after/)
})
test('unrelated histories are not automatically merged and never change the worktree', async (t) => {
  const { repo, git, request, base } = await fixture(t)
  const tree = (await git.git(repo, ['rev-parse', 'HEAD^{tree}'])).trim()
  const root = (await git.git(repo, ['commit-tree', tree, '-m', 'other root'])).trim()
  await git.git(repo, ['update-ref', 'refs/heads/unrelated', root])
  const result = await git.action(
    repo,
    await request('refs/heads/unrelated', { action: 'merge-branch', confirm: true }),
  )
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /共同历史/)
  assert.equal(await git.head(repo), base)
  assert.equal(result.snapshot.merge, null)
  assert.equal(await fs.readFile(repo + '/base.txt', 'utf8'), 'base\n')
})
