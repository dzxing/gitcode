'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-read-cache-'))
  const repo = path.join(root, '仓库 with spaces')
  await fs.mkdir(repo)
  const setup = new GitService(),
    git = new GitService({
      enforceRepositoryTrust: true,
      dataDirectory: path.join(root, 'profile'),
    })
  t.after(async () => {
    await git.shutdown()
    await setup.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const cmd = (...args) => setup.git(repo, args)
  await cmd('init', '-b', 'main')
  for (const [key, value] of Object.entries({
    'user.name': 'Read QA',
    'user.email': 'read@example.test',
    'commit.gpgsign': 'false',
    'core.autocrlf': 'false',
    'core.hooksPath': '.no-hooks',
  }))
    await cmd('config', key, value)
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(repo, 'README.md'), String(i) + '\n')
    await cmd('add', '.')
    await cmd('commit', '-m', 'commit ' + i)
  }
  const approve = async (p = repo) => {
    const info = await git.trust.inspect(p)
    await git.trust.approve(p, info.token)
  }
  return { root, repo, setup, git, cmd, approve }
}
test('trusted repository location reuse still rejects external included-config changes', async (t) => {
  const f = await fixture(t),
    include = path.join(f.root, 'included.conf')
  await fs.writeFile(include, '[core]\n  editor = harmless\n')
  await f.cmd('config', 'include.path', include)
  await f.approve()
  await f.git.repository(f.repo)
  const original = f.git.git.bind(f.git),
    commands = []
  f.git.git = async (...args) => {
    commands.push(args[1])
    return original(...args)
  }
  assert.equal(await f.git.repository(f.repo), await fs.realpath(f.repo))
  assert.equal(commands.filter((args) => args[0] === 'rev-parse').length, 0)
  assert.ok(commands.some((args) => args[0] === 'config'))
  await fs.writeFile(include, '[core]\n  editor = changed\n')
  await assert.rejects(f.git.repository(f.repo), /配置已变化/)
})
test('unchanged history is reused while branch labels, staged files and new commits stay fresh', async (t) => {
  const f = await fixture(t)
  await f.approve()
  const first = await f.git.snapshot(f.repo),
    original = f.git.git.bind(f.git)
  let logs = 0
  f.git.git = async (...args) => {
    if (args[1][0] === 'log') logs++
    return original(...args)
  }
  await f.cmd('branch', 'feature/another')
  first.commits[0].parents[0] = 'caller-mutated-history'
  const second = await f.git.snapshot(f.repo)
  assert.equal(logs, 0)
  assert.notEqual(second.commits[0].parents[0], 'caller-mutated-history')
  assert.equal(second.history.signature, first.history.signature)
  assert.ok(second.commits[0].refs.includes('feature/another'))
  await fs.writeFile(path.join(f.repo, 'README.md'), 'changed\n')
  const result = await f.git.action(f.repo, {
    action: 'stage',
    paths: ['README.md'],
    expectedHead: first.head,
    expectedBranch: 'main',
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.ok(result.snapshot.staged.some((file) => file.path === 'README.md'))
  assert.equal(logs, 0)
  await f.cmd('commit', '-m', 'external commit')
  const moved = await f.git.snapshot(f.repo)
  assert.equal(moved.total, 4)
  assert.notEqual(moved.head, first.head)
  assert.notEqual(moved.history.signature, first.history.signature)
  assert.ok(logs > 0)
})
test('replacement refs and shallow metadata invalidate cached pages and old paging tokens', async (t) => {
  const f = await fixture(t)
  await f.approve()
  const original = await f.git.snapshot(f.repo)
  await f.cmd('replace', '--graft', 'HEAD')
  const replaced = await f.git.snapshot(f.repo)
  assert.equal(replaced.total, 1)
  assert.notEqual(replaced.history.signature, original.history.signature)
  assert.ok(replaced.branches.every((branch) => !branch.fullRef.startsWith('refs/replace/')))
  await assert.rejects(
    f.git.history.read(f.repo, { token: original.history.token, offset: 0 }),
    /历史结构已变化/,
  )
  await f.cmd('replace', '-d', 'HEAD')
  assert.equal((await f.git.snapshot(f.repo)).total, 3)
  const locations = await f.git.gitPaths(f.repo, ['shallow', 'info/grafts'])
  await fs.writeFile(locations.get('shallow'), original.head + '\n')
  const shallow = await f.git.snapshot(f.repo)
  assert.equal(shallow.total, 1)
  await assert.rejects(
    f.git.history.read(f.repo, { token: original.history.token, offset: 0 }),
    /历史结构已变化/,
  )
  await fs.unlink(locations.get('shallow'))
  assert.equal((await f.git.snapshot(f.repo)).total, 3)
  await fs.writeFile(locations.get('info/grafts'), '# changed graph metadata\n')
  const graft = await f.git.snapshot(f.repo)
  assert.notEqual(graft.history.signature, original.history.signature)
})
test('batched metadata paths retain linked-worktree isolation and common config semantics', async (t) => {
  const f = await fixture(t),
    linked = path.join(f.root, 'linked')
  await f.cmd('worktree', 'add', '-b', 'qa/linked', linked)
  await f.approve()
  await f.approve(linked)
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'config', 'index']
  const main = await f.git.gitPaths(f.repo, names),
    other = await f.git.gitPaths(linked, names)
  assert.equal(await fs.realpath(main.get('config')), await fs.realpath(other.get('config')))
  assert.notEqual(main.get('index'), other.get('index'))
  assert.notEqual(main.get('MERGE_HEAD'), other.get('MERGE_HEAD'))
  await fs.writeFile(main.get('MERGE_HEAD'), (await f.setup.head(f.repo)) + '\n')
  await assert.rejects(f.git.noInProgress(f.repo), /未完成/)
  await f.git.noInProgress(linked)
  await fs.writeFile(other.get('CHERRY_PICK_HEAD'), (await f.setup.head(linked)) + '\n')
  await assert.rejects(f.git.noInProgress(linked), /未完成/)
  await fs.unlink(main.get('MERGE_HEAD'))
  await fs.unlink(other.get('CHERRY_PICK_HEAD'))
  const snapshot = await f.git.snapshot(linked)
  assert.equal(snapshot.branch, 'qa/linked')
  assert.equal(snapshot.merge, null)
})
test('GitFlow syntax reuse does not retain stale missing-branch or invalid-rule state', async (t) => {
  const f = await fixture(t)
  await f.approve()
  const first = await f.git.snapshot(f.repo)
  assert.ok(first.gitflow.missing.includes('develop'))
  await f.cmd('branch', 'develop')
  assert.deepEqual((await f.git.snapshot(f.repo)).gitflow.missing, [])
  await f.cmd('config', 'gitflow.prefix.feature', 'invalid prefix/')
  const invalid = await f.git.snapshot(f.repo)
  assert.ok(invalid.gitflow.error)
  await f.cmd('config', '--unset', 'gitflow.prefix.feature')
  assert.equal((await f.git.snapshot(f.repo)).gitflow.error, '')
})

test('opt-in index actions return fresh worktree data without claiming a full snapshot', async (t) => {
  const f = await fixture(t)
  await f.approve()
  const before = await f.git.snapshot(f.repo)
  await fs.writeFile(path.join(f.repo, 'README.md'), 'draft\n')
  const staged = await f.git.action(f.repo, {
    action: 'stage',
    paths: ['README.md'],
    expectedHead: before.head,
    expectedBranch: 'main',
    refresh: 'worktree',
  })
  assert.equal(staged.outcome, 'succeeded', staged.error)
  assert.equal(staged.snapshot, null)
  assert.equal(staged.worktree.head, before.head)
  assert.ok(staged.worktree.staged.some((file) => file.path === 'README.md'))
  const unstaged = await f.git.action(f.repo, {
    action: 'unstage',
    paths: ['README.md'],
    expectedHead: before.head,
    expectedBranch: 'main',
    refresh: 'worktree',
  })
  assert.equal(unstaged.outcome, 'succeeded', unstaged.error)
  assert.equal(unstaged.snapshot, null)
  assert.ok(unstaged.worktree.unstaged.some((file) => file.path === 'README.md'))
  const rejected = await f.git.action(f.repo, {
    action: 'stage',
    paths: ['missing'],
    expectedHead: before.head,
    expectedBranch: 'main',
    refresh: 'worktree',
  })
  assert.equal(rejected.outcome, 'failed')
  assert.ok(rejected.snapshot)
  assert.equal(rejected.worktree, undefined)
})
test('concurrent HEAD change forces a full refresh instead of an obsolete worktree patch', async (t) => {
  const f = await fixture(t)
  await f.approve()
  const before = await f.git.snapshot(f.repo)
  await fs.writeFile(path.join(f.repo, 'README.md'), 'changed externally\n')
  const original = f.git.performAction.bind(f.git)
  f.git.performAction = async (...args) => {
    const result = await original(...args)
    await f.cmd('commit', '-m', 'external commit')
    return result
  }
  const result = await f.git.action(f.repo, {
    action: 'stage',
    paths: ['README.md'],
    expectedHead: before.head,
    expectedBranch: 'main',
    refresh: 'worktree',
  })
  assert.equal(result.worktree, undefined)
  assert.ok(result.snapshot)
  assert.notEqual(result.snapshot.head, before.head)
})
test('foreground work preempts only a marked background snapshot and defers its stale result', async (t) => {
  const f = await fixture(t)
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  f.git.repository = async () => f.repo
  f.git.snapshot = async (_repo, signal) => {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  }
  const read = f.git.repositoryWatch.read(f.repo, null)
  await ready
  const foreground = f.git.job(async (signal) => {
    assert.equal(signal.aborted, false)
    return 'foreground done'
  })
  assert.deepEqual(await read, { snapshot: null, deferred: 'busy' })
  assert.equal(await foreground, 'foreground done')
})
test('batched HEAD context keeps unborn, detached and invalid symbolic HEAD distinctions', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.setup.headContext(f.repo), {
    head: await f.setup.head(f.repo),
    branch: 'main',
  })
  await f.cmd('switch', '--detach')
  assert.equal((await f.setup.headContext(f.repo)).branch, '')
  await f.cmd('symbolic-ref', 'HEAD', 'refs/tags/not-a-branch')
  await assert.rejects(
    f.setup.headContext(f.repo),
    /有效的本地分支|HEAD|ambiguous|unknown revision/,
  )
  await f.cmd('symbolic-ref', 'HEAD', 'refs/heads/unborn')
  assert.deepEqual(await f.setup.headContext(f.repo), { head: '', branch: 'unborn' })
})

test('a preempted read cannot publish a value even if its final filesystem work ignores abort', async (t) => {
  const f = await fixture(t)
  let release, started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const finish = new Promise((resolve) => {
    release = resolve
  })
  const read = f.git.job(
    async () => {
      started()
      await finish
      return { stale: true }
    },
    { background: true, preemptible: true },
  )
  await ready
  const foreground = f.git.job(async () => 'fresh foreground')
  release()
  await assert.rejects(read, (error) => error.code === 'READ_PREEMPTED')
  assert.equal(await foreground, 'fresh foreground')
})
