const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const {
  GitService,
  execute,
  parseStatus,
  absolutePath,
  filePath,
  revision,
  validRemote,
  MAX_DIFF,
} = require('../electron/git.cjs')

async function act(git, repo, request) {
  const expected = {
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
  }
  if (['fetch', 'pull', 'push'].includes(request.action) && !request.planId)
    request = { ...request, planId: (await git.syncPlan(repo, request.action, expected)).id }
  const result = await git.action(repo, { ...expected, ...request })
  if (result.outcome === 'failed' || result.outcome === 'cancelled' || result.error)
    throw Object.assign(new Error(result.error || result.warning || 'Git failed'), { result })
  return result
}

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-electron-中文 '))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(root, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'GitCode Test'],
    ['user.email', 'gitcode@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.gitcode-no-hooks'],
  ])
    await git.git(root, ['config', key, value])
  return {
    root,
    git,
    write: (file, text = 'hello\n') => fs.writeFile(path.join(root, file), text),
    commit: async (message = 'initial') => {
      await git.git(root, ['add', '--all'])
      await git.git(root, ['commit', '-m', message])
      return (await git.git(root, ['rev-parse', 'HEAD'])).trim()
    },
  }
}

test('unborn repository, Unicode path and untracked status', async (t) => {
  const { root, git, write } = await repository(t)
  await write('新增 文件.txt')
  const state = await git.snapshot(root)
  assert.equal(state.branch, 'main')
  assert.equal(state.total, 0)
  assert.deepEqual(state.commits, [])
  assert.deepEqual(state.unstaged, [{ path: '新增 文件.txt', status: '?' }])
  assert.equal(await git.repository(root), await fs.realpath(root))
})

test('history interleaves branches by committer date with parents below children and ignores checkout order', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const base = await commit('base')
  const tree = (await git.git(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const makeCommit = async (parent, day, authorDay, subject) =>
    (
      await execute(git.gitPath, ['commit-tree', tree, '-p', parent, '-m', subject], {
        cwd: root,
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: `2026-01-${day}T12:00:00Z`,
          GIT_AUTHOR_DATE: `2026-02-${authorDay}T12:00:00Z`,
        },
      })
    ).stdout.trim()
  const a1 = await makeCommit(base, '01', '04', 'a1')
  const a2 = await makeCommit(a1, '04', '01', 'a2')
  const b1 = await makeCommit(base, '03', '05', 'b1')
  await git.git(root, ['branch', 'branch-a', a2])
  await git.git(root, ['branch', 'branch-b', b1])
  for (const branch of ['main', 'branch-a', 'branch-b']) {
    await git.git(root, ['checkout', branch])
    assert.deepEqual(
      (await git.snapshot(root)).commits.map((c) => c.hash),
      [a2, b1, a1, base],
    )
  }
  const sameTime = await makeCommit(base, '04', '06', 'same-time-tip')
  await git.git(root, ['branch', 'branch-c', sameTime])
  const tiedOrder = (await git.snapshot(root)).commits.map((c) => c.hash)
  for (const branch of ['main', 'branch-a', 'branch-b', 'branch-c']) {
    await git.git(root, ['checkout', branch])
    assert.deepEqual(
      (await git.snapshot(root)).commits.map((c) => c.hash),
      tiedOrder,
    )
  }
})

test('stage and unstage before first commit preserve working file', async (t) => {
  const { root, git, write } = await repository(t)
  await write('a.txt')
  const staged = await act(git, root, { action: 'stage', paths: ['a.txt'] })
  assert.equal(staged.snapshot.staged[0].status, 'A')
  const state = await act(git, root, { action: 'unstage', paths: ['a.txt'] })
  assert.equal(state.snapshot.staged.length, 0)
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'hello\n')
})

test('commit only staged files, Unicode message and root commit details', async (t) => {
  const { root, git, write } = await repository(t)
  await write('one.txt')
  await write('two.txt')
  await act(git, root, { action: 'stage', paths: ['one.txt'] })
  const { snapshot } = await act(git, root, {
    action: 'commit',
    message: 'feat: 中文提交\n\n详细说明',
  })
  assert.equal(snapshot.commits[0].subject, 'feat: 中文提交')
  assert.equal(snapshot.unstaged[0].path, 'two.txt')
  const detail = await git.commitDetails(root, snapshot.head)
  assert.deepEqual(detail.files, [{ path: 'one.txt', status: 'A' }])
  assert.ok(detail.body.includes('详细说明'))
})

test('working and staged differences remain independent', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt', 'base\n')
  await commit()
  await write('a.txt', 'staged\n')
  await act(git, root, { action: 'stage', paths: ['a.txt'] })
  await write('a.txt', 'working\n')
  assert.ok((await git.diff(root, 'a.txt', true)).diff.includes('+staged'))
  assert.ok((await git.diff(root, 'a.txt', false)).diff.includes('+working'))
  const state = await git.status(root)
  assert.equal(state.staged.length, 1)
  assert.equal(state.unstaged.length, 1)
})

test('untracked text and binary diff', async (t) => {
  const { root, git, write } = await repository(t)
  await write('new.txt', '你好\n')
  assert.ok((await git.diff(root, 'new.txt', false)).diff.includes('+你好'))
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 255]))
  assert.ok((await git.diff(root, 'binary.bin', false)).diff.includes('Binary files'))
})

test('log parsing preserves undecorated commits and ancestry', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt', 'one\n')
  const first = await commit('one')
  await write('a.txt', 'two\n')
  const second = await commit('two')
  await write('a.txt', 'three\n')
  const third = await commit('three')
  const state = await git.snapshot(root)
  assert.deepEqual(
    state.commits.map((c) => c.hash),
    [third, second, first],
  )
  assert.deepEqual(state.commits[1].refs, [])
  assert.deepEqual(state.commits[1].parents, [first])
})

test('branch creation, switching, merge topology and first-parent diff', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('base.txt')
  await commit()
  await act(git, root, { action: 'branch', name: 'feature/demo' })
  await write('feature.txt')
  const feature = await commit('feature')
  await act(git, root, { action: 'checkout', name: 'main' })
  await write('main.txt')
  const main = await commit('main update')
  await git.git(root, ['merge', '--no-ff', 'feature/demo', '-m', 'merge'])
  const state = await git.snapshot(root)
  assert.deepEqual(state.commits[0].parents, [main, feature])
  assert.equal(state.total, 4)
  assert.deepEqual((await git.commitDetails(root, state.head)).files, [
    { path: 'feature.txt', status: 'A' },
  ])
})

test('checkout refuses to overwrite uncommitted work', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt', 'base\n')
  await commit()
  await act(git, root, { action: 'branch', name: 'feature/demo' })
  await write('a.txt', 'feature\n')
  await commit('feature')
  await act(git, root, { action: 'checkout', name: 'main' })
  await write('a.txt', 'unsaved\n')
  await assert.rejects(act(git, root, { action: 'checkout', name: 'feature/demo' }))
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'unsaved\n')
})

test('detached commits remain visible', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const initial = await commit()
  await git.git(root, ['checkout', '--detach', initial])
  await write('a.txt', 'next\n')
  const detached = await commit('detached')
  const state = await git.snapshot(root)
  assert.equal(state.branch, 'detached HEAD')
  assert.equal(state.commits[0].hash, detached)
})

test('rename unstaging restores both index paths', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('before.txt')
  await commit()
  await git.git(root, ['mv', 'before.txt', 'after.txt'])
  assert.equal((await git.status(root)).staged[0].oldPath, 'before.txt')
  const result = await act(git, root, { action: 'unstage', paths: ['after.txt'] })
  assert.equal(result.snapshot.staged.length, 0)
  assert.equal(await fs.readFile(path.join(root, 'after.txt'), 'utf8'), 'hello\n')
})

test('literal pathspecs and stale paths', async (t) => {
  const { root, git, write } = await repository(t)
  await write('[abc].txt')
  await write('a.txt')
  const result = await act(git, root, { action: 'stage', paths: ['[abc].txt'] })
  assert.deepEqual(
    result.snapshot.staged.map((f) => f.path),
    ['[abc].txt'],
  )
  await assert.rejects(act(git, root, { action: 'stage', paths: ['no-change'] }))
  await assert.rejects(act(git, root, { action: 'stage', paths: ['../outside'] }))
  await assert.rejects(act(git, root, { action: 'branch', name: '--orphan' }))
  await assert.rejects(act(git, root, { action: 'reset' }))
})

test('worktree identity accepts another path to the same directory while protecting checked-out branches', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('base.txt')
  await commit()
  const alias = root + '-alias'
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => fs.rm(alias, { force: true, recursive: true }))
  await git.checkWorktree(alias, 'refs/heads/main', false)
  await assert.rejects(git.checkWorktree(alias, 'refs/heads/main', true), /工作区/)
})

test('large file selections stage and unstage within Windows command-line limits without changing files', async (t) => {
  const { root, git, write } = await repository(t)
  const files = Array.from(
    { length: 300 },
    (_, i) => `文件 ${String(i).padStart(3, '0')} ${'x'.repeat(120)}.txt`,
  )
  await Promise.all(files.map((file) => write(file, 'original\n')))
  const run = git.git.bind(git)
  git.git = async (repo, args, options) => {
    // Exercise the Windows process argument limit even when this test runs on Linux.
    if (args.join(' ').length > 32767)
      throw new Error('Windows command line exceeds 32767 characters')
    return run(repo, args, options)
  }
  await act(git, root, { action: 'stage', paths: files })
  assert.deepEqual((await git.status(root)).staged.map((f) => f.path).sort(), files.toSorted())
  await act(git, root, { action: 'unstage', paths: files })
  assert.equal((await git.status(root)).staged.length, 0)
  await act(git, root, { action: 'stage', paths: files })
  await act(git, root, { action: 'commit', message: 'long selected file list' })
  await Promise.all(files.map((file) => write(file, 'working content\n')))
  await act(git, root, { action: 'stage', paths: files })
  await act(git, root, { action: 'unstage', paths: files })
  const status = await git.status(root)
  assert.equal(status.staged.length, 0)
  assert.deepEqual(status.unstaged.map((f) => f.path).sort(), files.toSorted())
  for (const file of files)
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), 'working content\n')
})

test('Unicode diff truncation preserves character boundaries', async (t) => {
  const { root, git, write } = await repository(t)
  await write('large.txt', '字'.repeat(MAX_DIFF + 100))
  const result = await git.diff(root, 'large.txt', false)
  assert.equal(result.truncated, true)
  assert.equal(Array.from(result.diff).length, MAX_DIFF)
})

test('create exclusively initializes new directories and local clone preserves commits', async (t) => {
  const { root, git, write, commit } = await repository(t)
  const fresh = path.join(root, 'new-project')
  assert.equal((await git.create({ kind: 'init', path: fresh })).snapshot.branch, 'main')
  await assert.rejects(git.create({ kind: 'init', path: root }), /已存在/)
  await fs.rm(fresh, { recursive: true, force: true })
  await write('a.txt')
  const head = await commit()
  const target = path.join(root, 'cloned')
  const result = await git.create({ kind: 'clone', path: target, url: root })
  assert.equal(result.snapshot.head, head)
  assert.ok(result.snapshot.branches.some((b) => b.kind === 'remote'))
})

test('invalid creation requests have no filesystem effects', async (t) => {
  const { root, git } = await repository(t)
  const target = path.join(root, 'must-not-exist')
  for (const request of [
    { kind: 'delete', path: target },
    { kind: 'init', path: 'relative' },
    { kind: 'clone', path: target, url: 'ext::sh -c unsafe' },
    { kind: 'clone', path: target, url: '--upload-pack=unsafe' },
  ])
    await assert.rejects(git.create(request))
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})

test('fetch, fast-forward pull and push work with a local remote', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  await commit()
  const remote = path.join(root, '.git', 'test-remote.git')
  await git.git(root, ['init', '--bare', remote])
  await git.git(root, ['remote', 'add', 'origin', remote])
  await git.git(root, ['push', '--set-upstream', 'origin', 'main'])
  await act(git, root, { action: 'fetch' })
  await act(git, root, { action: 'pull' })
  await write('a.txt', 'next\n')
  const next = await commit('next')
  await act(git, root, { action: 'push' })
  assert.equal((await git.git(remote, ['rev-parse', 'main'])).trim(), next)
})

test('input validation and status parser handle conflicts and invalid paths', () => {
  for (const value of ['', 'HEAD', 'HEAD;echo unsafe', 'a'.repeat(41)])
    assert.throws(() => revision(value))
  assert.equal(revision('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(revision('a'.repeat(64)), 'a'.repeat(64))
  for (const value of ['', '../escape', '/absolute', 'file\0name'])
    assert.throws(() => filePath(value))
  assert.throws(() => absolutePath('relative'))
  assert.equal(validRemote('ext::sh -c unsafe'), false)
  assert.equal(validRemote('git@github.com:owner/repo.git'), true)
  const state = parseStatus('R  after.txt\0before.txt\0UU conflict.txt\0?? new.txt\0MM both.txt\0')
  assert.equal(state.staged.length, 2)
  assert.equal(state.unstaged.length, 3)
  assert.equal(state.staged[0].oldPath, 'before.txt')
  assert.equal(state.unstaged[0].status, 'U')
})

test('active process cancellation terminates the child promptly', async () => {
  const controller = new AbortController(),
    started = Date.now()
  const result = execute(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    timeout: 35_000,
    signal: controller.signal,
  })
  const rejected = assert.rejects(result, /已取消/)
  await new Promise((resolve) => setTimeout(resolve, 80))
  controller.abort()
  await rejected
  assert.ok(Date.now() - started < 5000)
})

test('timeout terminates a process rather than hanging the UI', async () => {
  await assert.rejects(
    execute(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 80 }),
    /超时/,
  )
})

test('cancellation invalidates active and queued jobs; later jobs can proceed', async () => {
  const git = new GitService()
  let release
  const first = git.job(async (signal) => {
    await new Promise((resolve) => {
      release = resolve
    })
    if (signal.aborted) throw new Error('cancelled')
  })
  const second = git.job(async () => {
    throw new Error('must not run')
  })
  const one = assert.rejects(first, /cancelled/),
    two = assert.rejects(second, /已取消/)
  await new Promise((resolve) => setImmediate(resolve))
  git.cancel()
  release()
  await Promise.all([one, two])
  assert.equal(await git.job(async () => 'new job'), 'new job')
  await git.shutdown()
  await assert.rejects(
    git.job(async () => 'must not run'),
    /已取消/,
  )
})

test('directory browser identifies repositories and remembers the last folder', async (t) => {
  const { root, git } = await repository(t)
  await fs.mkdir(path.join(root, 'plain'))
  await fs.mkdir(path.join(root, '.hidden'))
  await git.create({ kind: 'init', path: path.join(root, 'repo') })
  await fs.mkdir(path.join(root, 'worktree'))
  await fs.writeFile(path.join(root, 'worktree', '.git'), 'gitdir: /not-read-by-browser')
  await fs.writeFile(path.join(root, 'file.txt'), 'not a directory')
  const list = await git.listDirectory(root)
  assert.equal(list.path, await fs.realpath(root))
  assert.equal(list.folders.find((f) => f.name === 'repo').isGit, true)
  assert.equal(list.folders.find((f) => f.name === 'worktree').isGit, true)
  assert.equal(list.folders.find((f) => f.name === '.hidden').hidden, true)
  assert.ok(!list.folders.some((f) => ['file.txt', '.git'].includes(f.name)))
  assert.equal((await git.listDirectory()).path, list.path)
  await assert.rejects(git.listDirectory(path.join(root, 'file.txt')), /目录/)
})

test('context branch creation uses the selected commit and does not switch by default', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt', 'old\n')
  const old = await commit('old')
  await write('a.txt', 'new\n')
  const head = await commit('new')
  await write('local.txt', 'draft')
  const before = await git.status(root)
  const result = await act(git, root, {
    action: 'create-branch',
    name: 'feature/旧提交',
    startOid: old,
    switchAfter: false,
  })
  assert.equal(result.snapshot.head, head)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.branches.find((b) => b.name === 'feature/旧提交').hash, old)
  assert.equal(result.snapshot.branches.find((b) => b.name === 'feature/旧提交').upstream, '')
  assert.deepEqual(await git.status(root), before)
  await assert.rejects(
    act(git, root, {
      action: 'create-branch',
      name: 'feature/旧提交',
      startOid: head,
      switchAfter: false,
    }),
  )
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/feature/旧提交'])).trim(), old)
})

test('context rename and delete reject stale targets and preserve worktree protections', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const head = await commit()
  await git.git(root, ['branch', 'topic'])
  const guards = { expectedHead: head, expectedBranch: 'main', expectedOid: head }
  await act(git, root, {
    action: 'rename-branch',
    name: 'topic',
    newName: 'feature/renamed',
    ...guards,
  })
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/feature/renamed'])).trim(), head)
  await assert.rejects(
    act(git, root, { action: 'delete-branch', name: 'main', ...guards }),
    /工作区/,
  )
  const worktree = path.join(root, 'linked')
  await git.git(root, ['worktree', 'add', worktree, 'feature/renamed'])
  await assert.rejects(
    act(git, root, {
      action: 'rename-branch',
      name: 'feature/renamed',
      newName: 'other',
      ...guards,
    }),
    /工作区/,
  )
  await assert.rejects(
    act(git, root, { action: 'delete-branch', name: 'feature/renamed', ...guards }),
    /工作区/,
  )
  await git.git(root, ['worktree', 'remove', worktree])
  await write('a.txt', 'new\n')
  await commit('new')
  await assert.rejects(
    act(git, root, { action: 'delete-branch', name: 'feature/renamed', ...guards }),
    /HEAD 已变化/,
  )
  const currentHead = (await git.git(root, ['rev-parse', 'HEAD'])).trim()
  await assert.rejects(
    act(git, root, {
      action: 'delete-branch',
      name: 'feature/renamed',
      ...guards,
      expectedHead: currentHead,
      expectedOid: currentHead,
    }),
    /目标分支已变化/,
  )
  await act(git, root, {
    action: 'delete-branch',
    name: 'feature/renamed',
    ...guards,
    expectedHead: currentHead,
  })
  assert.equal((await git.git(root, ['branch', '--list', 'feature/renamed'])).trim(), '')
})

test('tracking creation handles non-origin remotes with slash names without overwriting', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const head = await commit()
  await git.git(root, ['remote', 'add', 'team/upstream', root])
  await git.git(root, ['fetch', 'team/upstream'])
  const fullRef = 'refs/remotes/team/upstream/main'
  const result = await act(git, root, {
    action: 'track-branch',
    name: 'tracking/topic',
    fullRef,
    expectedOid: head,
    switchAfter: false,
  })
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(
    (await git.git(root, ['config', '--get', 'branch.tracking/topic.remote'])).trim(),
    'team/upstream',
  )
  assert.equal(
    (await git.git(root, ['config', '--get', 'branch.tracking/topic.merge'])).trim(),
    'refs/heads/main',
  )
  await assert.rejects(
    act(git, root, {
      action: 'track-branch',
      name: 'main',
      fullRef,
      expectedOid: head,
      switchAfter: false,
    }),
  )
  assert.equal(
    (await git.git(root, ['config', '--get', 'branch.main.remote'], { optional: true })).trim(),
    '',
  )
})

test('partial success reports created branches and refresh errors without claiming rollback', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt', 'old\n')
  const old = await commit('old')
  await write('a.txt', 'new\n')
  const head = await commit('new')
  await write('a.txt', 'local changes\n')
  const result = await act(git, root, {
    action: 'create-branch',
    name: 'old/topic',
    startOid: old,
    switchAfter: true,
    expectedHead: head,
    expectedBranch: 'main',
  })
  assert.match(result.warning, /已创建.*切换失败/)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'local changes\n')
  const snapshot = git.snapshot
  git.snapshot = async () => {
    throw new Error('test refresh failure')
  }
  const refreshed = await act(git, root, {
    action: 'create-branch',
    name: 'created/topic',
    startOid: head,
    switchAfter: false,
  })
  git.snapshot = snapshot
  assert.equal(refreshed.snapshot, null)
  assert.match(refreshed.refreshError, /test refresh failure/)
  assert.equal(refreshed.outcome, 'succeeded')
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/created/topic'])).trim(), head)
})

test('current-branch rename is supported and unmerged deletion is protected by default', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const main = await commit()
  await git.git(root, ['switch', '-c', 'unmerged'])
  await write('a.txt', 'unmerged changes\n')
  const topic = await commit('unmerged')
  await git.git(root, ['switch', 'main'])
  const renamed = await act(git, root, {
    action: 'rename-branch',
    name: 'main',
    newName: 'main/renamed',
    expectedOid: main,
    expectedHead: main,
    expectedBranch: 'main',
  })
  assert.equal(renamed.snapshot.branch, 'main/renamed')
  await assert.rejects(
    act(git, root, {
      action: 'delete-branch',
      name: 'unmerged',
      expectedOid: topic,
      expectedHead: main,
      expectedBranch: 'main/renamed',
    }),
    /合并检查/,
  )
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/unmerged'])).trim(), topic)
  assert.equal((await git.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'main/renamed')
})

async function planFor(git, root, kind) {
  return git.syncPlan(root, kind, {
    expectedHead: await git.head(root),
    expectedBranch: (await git.currentBranch(root)) || 'detached HEAD',
  })
}
async function remoteFixture(t) {
  const fixture = await repository(t)
  await fixture.write('a.txt', 'initial\n')
  const head = await fixture.commit()
  const bare = path.join(fixture.root, '.git', 'remote-test.git')
  await fixture.git.git(fixture.root, ['init', '--bare', bare])
  await fixture.git.git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await fixture.git.git(fixture.root, ['remote', 'add', 'origin', bare])
  await fixture.git.git(fixture.root, ['push', '-u', 'origin', 'main'])
  async function peer() {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-peer-'))
    t.after(() => fs.rm(folder, { recursive: true, force: true }))
    await fixture.git.git(fixture.root, ['clone', bare, folder])
    for (const [key, value] of [
      ['user.name', 'Peer'],
      ['user.email', 'peer@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await fixture.git.git(folder, ['config', key, value])
    return folder
  }
  return { ...fixture, bare, head, peer }
}

test('push plan ignores matching and followTags: only the approved branch changes', async (t) => {
  const { root, git, write, commit, bare, head } = await remoteFixture(t)
  await git.git(root, ['branch', 'topic'])
  await git.git(root, ['push', 'origin', 'topic'])
  await write('a.txt', 'main next\n')
  const main = await commit('main next')
  await git.git(root, ['tag', '-a', 'not-approved', '-m', 'tag'])
  await git.git(root, ['switch', 'topic'])
  await write('a.txt', 'topic next\n')
  await commit('topic next')
  await git.git(root, ['switch', 'main'])
  await git.git(root, ['config', 'push.default', 'matching'])
  await git.git(root, ['config', 'push.followTags', 'true'])
  const plan = await planFor(git, root, 'push')
  assert.equal(plan.destinationRef, 'refs/heads/main')
  const result = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await git.git(bare, ['rev-parse', 'main'])).trim(), main)
  assert.equal((await git.git(bare, ['rev-parse', 'topic'])).trim(), head)
  assert.equal((await git.git(bare, ['tag', '--list'])).trim(), '')
  assert.equal((await git.action(root, { action: 'push', planId: plan.id })).outcome, 'failed')
})

test('selected branch push preserves a dirty current worktree and never pushes its HEAD', async (t) => {
  const { root, git, write, commit, bare, head } = await remoteFixture(t)
  await git.git(root, ['branch', 'feature/topic'])
  await git.git(root, ['push', '-u', 'origin', 'feature/topic'])
  await git.git(root, ['switch', 'feature/topic'])
  await write('feature.txt', 'feature change\n')
  const feature = await commit('feature commit')
  await git.git(root, ['switch', 'main'])
  await write('main.txt', 'local main only\n')
  const main = await commit('main local commit')
  await write('a.txt', 'staged draft\n')
  await git.git(root, ['add', 'a.txt'])
  await write('a.txt', 'unstaged draft\n')
  await write('untracked.txt', 'keep this\n')
  const status = await git.git(root, ['status', '--porcelain=v1', '-z'])
  const index = await git.git(root, ['diff', '--cached'])
  const expected = {
    expectedHead: main,
    expectedBranch: 'main',
    sourceRef: 'refs/heads/feature/topic',
    sourceOid: feature,
  }
  const plan = await git.syncPlan(root, 'push', expected)
  assert.equal(plan.head, feature)
  assert.equal(plan.branch, 'feature/topic')
  assert.equal(plan.worktreeBranch, 'main')
  assert.equal(plan.destinationRef, 'refs/heads/feature/topic')
  const result = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), feature)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/main'])).trim(), head)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.head, main)
  assert.equal(await git.git(root, ['status', '--porcelain=v1', '-z']), status)
  assert.equal(await git.git(root, ['diff', '--cached']), index)
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'unstaged draft\n')
  assert.equal(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8'), 'keep this\n')
})

test('selected sync rejects stale refs, changed upstream, invalid sources and non-current pull', async (t) => {
  const { root, git, write, commit, bare, head } = await remoteFixture(t)
  await git.git(root, ['branch', 'feature/topic'])
  await git.git(root, ['push', '-u', 'origin', 'feature/topic'])
  const expected = {
    expectedHead: head,
    expectedBranch: 'main',
    sourceRef: 'refs/heads/feature/topic',
    sourceOid: head,
  }
  await assert.rejects(git.syncPlan(root, 'pull', expected), /请先切换/)
  await assert.rejects(
    git.syncPlan(root, 'push', { ...expected, sourceRef: 'refs/remotes/origin/main' }),
    /本地分支/,
  )
  await assert.rejects(git.syncPlan(root, 'push', { ...expected, sourceOid: undefined }), /无效/)
  const configPlan = await git.syncPlan(root, 'push', expected)
  await git.git(root, ['config', 'branch.feature/topic.merge', 'refs/heads/main'])
  const changed = await git.action(root, { action: 'push', planId: configPlan.id })
  assert.equal(changed.outcome, 'failed')
  assert.match(changed.error, /配置已变化/)
  await git.git(root, ['config', 'branch.feature/topic.merge', 'refs/heads/feature/topic'])
  const refPlan = await git.syncPlan(root, 'push', expected)
  await git.git(root, ['switch', 'feature/topic'])
  await write('topic.txt', 'external\n')
  const moved = await commit('external branch change')
  await git.git(root, ['switch', 'main'])
  const stale = await git.action(root, { action: 'push', planId: refPlan.id })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /分支已变化/)
  await assert.rejects(git.syncPlan(root, 'push', expected), /分支已变化/)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), head)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/main'])).trim(), head)
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/feature/topic'])).trim(), moved)
})

test('selected branch push refuses remote divergence without switching or forcing', async (t) => {
  const { root, git, write, commit, bare, peer, head } = await remoteFixture(t)
  await git.git(root, ['branch', 'feature/topic'])
  await git.git(root, ['push', '-u', 'origin', 'feature/topic'])
  const other = await peer()
  await git.git(other, ['switch', 'feature/topic'])
  await fs.writeFile(path.join(other, 'remote.txt'), 'remote feature\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'remote feature'])
  await git.git(other, ['push', 'origin', 'feature/topic'])
  const remoteHead = await git.head(other)
  await git.git(root, ['switch', 'feature/topic'])
  await write('local.txt', 'local feature\n')
  const feature = await commit('local feature')
  await git.git(root, ['switch', 'main'])
  const plan = await git.syncPlan(root, 'push', {
    expectedHead: head,
    expectedBranch: 'main',
    sourceRef: 'refs/heads/feature/topic',
    sourceOid: feature,
  })
  const result = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(result.outcome, 'failed')
  assert.ok(result.error)
  assert.match(result.warning, /核对目标分支/)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/feature/topic'])).trim(), remoteHead)
  assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/main'])).trim(), head)
  assert.equal(result.snapshot.branch, 'main')
  assert.equal(result.snapshot.head, head)
})

test('sync plans reject mirrors, unsafe fetch mappings, multiple push URLs and stale config', async (t) => {
  const { root, git, bare, head } = await remoteFixture(t)
  await git.git(bare, ['update-ref', 'refs/heads/server-only', head])
  await git.git(root, ['config', 'remote.origin.mirror', 'true'])
  await assert.rejects(planFor(git, root, 'push'), /镜像/)
  assert.equal((await git.git(bare, ['rev-parse', 'server-only'])).trim(), head)
  await git.git(root, ['config', '--unset', 'remote.origin.mirror'])
  await git.git(root, ['config', 'remote.origin.push', '+refs/heads/*:refs/heads/*'])
  await assert.rejects(planFor(git, root, 'push'), /推送映射/)
  await git.git(root, ['config', '--unset', 'remote.origin.push'])
  await git.git(root, ['config', '--add', 'remote.origin.pushurl', bare])
  await git.git(root, ['config', '--add', 'remote.origin.pushurl', bare])
  await assert.rejects(planFor(git, root, 'push'), /多个地址/)
  await git.git(root, ['config', '--unset-all', 'remote.origin.pushurl'])
  const approved = await planFor(git, root, 'push')
  await git.git(root, ['config', 'remote.origin.url', path.join(root, 'different.git')])
  const stale = await git.action(root, { action: 'push', planId: approved.id })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /配置已变化/)
  await git.git(root, ['config', 'remote.origin.url', bare])
  await git.git(root, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'])
  await assert.rejects(planFor(git, root, 'fetch'), /获取映射/)
})

test('fetch removes a server-deleted branch without changing local branches, tags, index or worktree', async (t) => {
  const { root, git, bare, head, write } = await remoteFixture(t)
  await git.git(bare, ['update-ref', 'refs/heads/topic', head])
  await act(git, root, { action: 'fetch' })
  assert.equal((await git.git(root, ['rev-parse', 'refs/remotes/origin/topic'])).trim(), head)
  await git.git(root, ['branch', 'topic', head])
  await git.git(root, ['tag', 'local-only', head])
  await git.git(root, ['update-ref', 'refs/remotes/other/keep', head])
  await git.git(root, ['config', 'fetch.pruneTags', 'true'])
  await git.git(root, ['config', 'remote.origin.pruneTags', 'true'])
  await git.git(bare, ['update-ref', '-d', 'refs/heads/topic'])
  await git.git(bare, ['update-ref', 'refs/heads/new-on-server', head])
  await git.git(bare, ['update-ref', 'refs/tags/remote-only', head])
  await write('a.txt', 'staged change\n')
  await git.git(root, ['add', 'a.txt'])
  await write('a.txt', 'unstaged change\n')
  const index = await git.indexFingerprint(root)
  const state = await act(git, root, { action: 'fetch' })
  assert.ok(!state.snapshot.branches.some((branch) => branch.name === 'origin/topic'))
  assert.ok(state.snapshot.branches.some((branch) => branch.name === 'origin/new-on-server'))
  for (const ref of ['refs/heads/topic', 'refs/tags/local-only', 'refs/remotes/other/keep'])
    assert.equal((await git.git(root, ['rev-parse', ref])).trim(), head)
  assert.equal((await git.git(root, ['tag', '--list'])).trim(), 'local-only')
  assert.equal(await git.head(root), head)
  assert.equal(await git.currentBranch(root), 'main')
  assert.equal(await git.indexFingerprint(root), index)
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'unstaged change\n')
})

test('fetch prunes reachable remote tracking refs while preserving unreachable remotes and tags', async (t) => {
  const { root, git, bare, peer, head } = await remoteFixture(t)
  await git.git(root, ['update-ref', 'refs/remotes/origin/deleted-on-server', head])
  await git.git(root, ['config', 'fetch.prune', 'true'])
  await git.git(root, ['config', 'fetch.pruneTags', 'true'])
  const other = await peer()
  await fs.writeFile(path.join(other, 'new.txt'), 'remote\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'new'])
  const next = (await git.git(other, ['rev-parse', 'HEAD'])).trim()
  await git.git(other, ['tag', 'remote-tag'])
  await git.git(other, ['push', 'origin', 'main', 'remote-tag'])
  await git.git(root, ['remote', 'add', 'broken', path.join(root, '.git', 'nonexistent.git')])
  await git.git(root, ['update-ref', 'refs/remotes/broken/keep-on-failure', head])
  const plan = await planFor(git, root, 'fetch')
  const result = await git.action(root, { action: 'fetch', planId: plan.id })
  assert.equal(result.outcome, 'partial')
  assert.ok(result.steps.some((step) => step.remote === 'origin' && step.ok))
  assert.ok(result.steps.some((step) => step.remote === 'broken' && !step.ok))
  assert.equal(result.snapshot.branches.find((b) => b.name === 'origin/main').hash, next)
  assert.ok(!result.snapshot.branches.some((b) => b.name === 'origin/deleted-on-server'))
  assert.ok(result.snapshot.branches.some((b) => b.name === 'broken/keep-on-failure'))
  assert.equal((await git.git(root, ['tag', '--list'])).trim(), '')
  assert.equal((await git.git(bare, ['rev-parse', 'main'])).trim(), next)
})

test('pull fast-forwards the fetched object; divergence refreshes refs and cleans private refs', async (t) => {
  const { root, git, write, commit, peer } = await remoteFixture(t)
  const other = await peer()
  await fs.writeFile(path.join(other, 'remote.txt'), 'one\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'one'])
  await git.git(other, ['push', 'origin', 'main'])
  const first = (await git.git(other, ['rev-parse', 'HEAD'])).trim()
  let plan = await planFor(git, root, 'pull')
  let result = await git.action(root, { action: 'pull', planId: plan.id })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.head, first)
  await write('local.txt', 'local\n')
  const local = await commit('local')
  await fs.writeFile(path.join(other, 'remote.txt'), 'two\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'two'])
  await git.git(other, ['push', 'origin', 'main'])
  plan = await planFor(git, root, 'pull')
  result = await git.action(root, { action: 'pull', planId: plan.id })
  assert.equal(result.outcome, 'partial')
  assert.ok(result.error)
  assert.equal(result.snapshot.head, local)
  assert.equal(
    result.snapshot.branches.find((b) => b.name === 'origin/main').hash,
    (await git.git(other, ['rev-parse', 'HEAD'])).trim(),
  )
  assert.equal(
    (await git.git(root, ['for-each-ref', '--format=%(refname)', 'refs/gitcode/requests/'])).trim(),
    '',
  )
})

test('sync rejects externally changed HEAD and can plan automatic protection of dirty worktrees', async (t) => {
  const { root, git, write, commit, head } = await remoteFixture(t)
  const plan = await planFor(git, root, 'push')
  await git.git(root, ['switch', '-c', 'other'])
  await write('a.txt', 'other\n')
  await commit('other')
  const stale = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /HEAD 已变化/)
  const created = await git.action(root, {
    action: 'create-branch',
    name: 'frozen',
    startOid: head,
    switchAfter: true,
    expectedHead: head,
    expectedBranch: 'main',
  })
  assert.equal(created.outcome, 'failed')
  assert.match(created.error, /HEAD 已变化/)
  const missingContext = await git.action(root, { action: 'commit', message: 'must refuse' })
  assert.equal(missingContext.outcome, 'failed')
  assert.match(missingContext.error, /缺少仓库上下文/)
  await git.git(root, ['switch', 'main'])
  await write('a.txt', 'dirty\n')
  await git.git(root, ['config', 'merge.autoStash', 'true'])
  const dirtyPlan = await planFor(git, root, 'pull')
  assert.equal(dirtyPlan.kind, 'pull')
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'dirty\n')
  assert.equal((await git.git(root, ['stash', 'list'])).trim(), '')
})

test('refs with commas remain intact and hook failure reports state changes with fresh snapshot', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const head = await commit()
  await git.git(root, ['branch', 'feature/with,comma'])
  await git.git(root, ['tag', '-a', 'tag,comma', '-m', 'tag'])
  const snapshot = await git.snapshot(root)
  assert.ok(snapshot.commits.find((c) => c.hash === head).refs.includes('feature/with,comma'))
  assert.ok(snapshot.commits.find((c) => c.hash === head).refs.includes('tag: tag,comma'))
  await write('a.txt', 'next\n')
  await git.git(root, ['add', 'a.txt'])
  const hooks = path.join(root, '.git', 'audit-hooks')
  await fs.mkdir(hooks)
  await git.git(root, ['config', 'core.hooksPath', hooks])
  await fs.writeFile(
    path.join(hooks, 'pre-commit'),
    '#!/bin/sh\nprintf "hook changed\\n" > hook.txt\ngit add hook.txt\nexit 1\n',
    { mode: 0o755 },
  )
  const result = await git.action(root, {
    action: 'commit',
    message: 'hook rejection',
    expectedHead: head,
    expectedBranch: 'main',
  })
  assert.equal(result.outcome, 'partial')
  assert.match(result.warning, /提交未生成.*暂存内容已变化/)
  assert.equal(result.snapshot.head, head)
  assert.ok(result.snapshot.staged.some((f) => f.path === 'hook.txt'))
})

test('cancelled pull uses a fresh signal for cleanup and refreshed state', async (t) => {
  const { root, git, peer } = await remoteFixture(t)
  const other = await peer()
  await fs.writeFile(path.join(other, 'remote.txt'), 'new\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'remote'])
  await git.git(other, ['push', 'origin', 'main'])
  const plan = await planFor(git, root, 'pull'),
    controller = new AbortController()
  const original = git.git.bind(git)
  git.git = async (repo, args, options) => {
    const result = await original(repo, args, options)
    if (args[0] === 'fetch') controller.abort()
    return result
  }
  const result = await git.action(root, { action: 'pull', planId: plan.id }, controller.signal)
  git.git = original
  assert.equal(result.outcome, 'cancelled')
  assert.ok(result.snapshot)
  assert.equal(
    (await git.git(root, ['for-each-ref', '--format=%(refname)', 'refs/gitcode/requests/'])).trim(),
    '',
  )
})

test('external checkout after pull fetch prevents merge into the new branch', async (t) => {
  const { root, git, peer, head } = await remoteFixture(t)
  await git.git(root, ['branch', 'other'])
  const other = await peer()
  await fs.writeFile(path.join(other, 'new.txt'), 'remote\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'remote'])
  await git.git(other, ['push', 'origin', 'main'])
  const plan = await planFor(git, root, 'pull'),
    original = git.git.bind(git)
  git.git = async (repo, args, options) => {
    const result = await original(repo, args, options)
    if (args[0] === 'fetch') await original(root, ['switch', 'other'])
    return result
  }
  const result = await git.action(root, { action: 'pull', planId: plan.id })
  git.git = original
  assert.equal(result.outcome, 'partial')
  assert.match(result.error, /HEAD 已变化/)
  assert.equal(result.snapshot.branch, 'other')
  assert.equal(result.snapshot.head, head)
  assert.equal(
    (await git.git(root, ['for-each-ref', '--format=%(refname)', 'refs/gitcode/requests/'])).trim(),
    '',
  )
})

test('push preserves named-remote hooks and rejects instead of bypassing hook failures', async (t) => {
  const { root, git, write, commit, bare, head } = await remoteFixture(t)
  await write('a.txt', 'new\n')
  const next = await commit('new')
  const hooks = path.join(root, '.git', 'audit-hooks')
  await fs.mkdir(hooks)
  await git.git(root, ['config', 'core.hooksPath', hooks])
  await fs.writeFile(
    path.join(hooks, 'pre-push'),
    '#!/bin/sh\nprintf "%s\\n" "$1" > .git/hook-remote\ncat > .git/hook-input\nexit 1\n',
    { mode: 0o755 },
  )
  const plan = await planFor(git, root, 'push')
  const result = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(result.outcome, 'failed')
  assert.equal((await fs.readFile(path.join(root, '.git', 'hook-remote'), 'utf8')).trim(), 'origin')
  assert.match(
    await fs.readFile(path.join(root, '.git', 'hook-input'), 'utf8'),
    new RegExp(`^${next} ${next} refs/heads/main `),
  )
  assert.equal((await git.git(bare, ['rev-parse', 'main'])).trim(), head)
})

test('sync preview strips credentials and clone/init distinguish creation from read failure', async (t) => {
  const { root, git } = await remoteFixture(t)
  await git.git(root, [
    'config',
    'remote.origin.url',
    'https://username:secret@example.test/repo?token=private',
  ])
  const plan = await planFor(git, root, 'push')
  assert.doesNotMatch(JSON.stringify(plan), /secret|private|username/)
  const target = path.join(root, 'created-with-refresh-failure'),
    snapshot = git.snapshot
  git.snapshot = async () => {
    throw new Error('read failure')
  }
  const created = await git.create({ kind: 'init', path: target })
  git.snapshot = snapshot
  assert.equal(created.snapshot, null)
  // Windows TEMP can use an 8.3 alias while creation returns the canonical path.
  assert.equal(await fs.realpath(created.path), await fs.realpath(target))
  assert.match(created.warning, /已创建.*读取失败/)
  assert.ok((await fs.stat(path.join(target, '.git'))).isDirectory())
})

test('pull cleanup never deletes a concurrently changed private ref', async (t) => {
  const { root, git, peer, head } = await remoteFixture(t)
  const other = await peer()
  await fs.writeFile(path.join(other, 'new.txt'), 'remote\n')
  await git.git(other, ['add', '.'])
  await git.git(other, ['commit', '-m', 'remote'])
  await git.git(other, ['push', 'origin', 'main'])
  const plan = await planFor(git, root, 'pull'),
    original = git.git.bind(git)
  let changed
  git.git = async (repo, args, options) => {
    if (
      args[0] === 'update-ref' &&
      args[1] === '-d' &&
      args[2].startsWith('refs/gitcode/requests/')
    ) {
      changed = args[2]
      await original(repo, ['update-ref', changed, head])
    }
    return original(repo, args, options)
  }
  const result = await git.action(root, { action: 'pull', planId: plan.id })
  git.git = original
  assert.equal(result.outcome, 'succeeded')
  assert.ok(result.cleanupError)
  assert.equal((await git.git(root, ['rev-parse', changed])).trim(), head)
  await git.git(root, ['update-ref', '-d', changed, head])
})

test('named remote preserves URL rewriting and include configuration invalidates old plans', async (t) => {
  const { root, git, bare, write, commit, head } = await remoteFixture(t)
  await write('a.txt', 'rewritten remote\n')
  const next = await commit('rewritten')
  await git.git(root, ['config', `url.${bare}.insteadOf`, 'review://source'])
  await git.git(root, ['config', 'remote.origin.url', 'review://source'])
  const include = path.join(root, '.git', 'included-config')
  await fs.writeFile(include, '[push]\n\tfollowTags = false\n')
  await git.git(root, ['config', 'include.path', include])
  const oldPlan = await planFor(git, root, 'push')
  await fs.writeFile(include, '[push]\n\tfollowTags = true\n')
  const stale = await git.action(root, { action: 'push', planId: oldPlan.id })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /配置已变化/)
  assert.equal((await git.git(bare, ['rev-parse', 'main'])).trim(), head)
  const plan = await planFor(git, root, 'push')
  const result = await git.action(root, { action: 'push', planId: plan.id })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await git.git(bare, ['rev-parse', 'main'])).trim(), next)
})

test('both pull methods preserve ignored local files when the remote adds the same path', async (t) => {
  for (const method of ['ff-only', 'merge']) {
    const { root, git, peer, head } = await remoteFixture(t)
    const other = await peer()
    await fs.writeFile(path.join(other, 'ignored-local.txt'), 'incoming content\n')
    await git.git(other, ['add', '.'])
    await git.git(other, ['commit', '-m', 'add ignored path'])
    await git.git(other, ['push', 'origin', 'main'])
    const remoteHead = await git.head(other)
    await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\nignored-local.txt\n')
    await fs.writeFile(path.join(root, 'ignored-local.txt'), 'preserve ignored local data\n')
    const plan = await git.syncPlan(root, 'pull', {
      expectedHead: head,
      expectedBranch: 'main',
      method,
    })
    const result = await git.action(root, { action: 'pull', planId: plan.id })
    assert.equal(result.outcome, 'partial')
    assert.match(result.error, /被忽略的文件冲突/)
    assert.equal(result.snapshot.head, head)
    assert.equal(result.snapshot.merge, null)
    assert.equal(
      result.snapshot.branches.find((branch) => branch.name === 'origin/main').hash,
      remoteHead,
    )
    assert.equal(
      await fs.readFile(path.join(root, 'ignored-local.txt'), 'utf8'),
      'preserve ignored local data\n',
    )
    assert.equal(
      (
        await git.git(root, ['for-each-ref', '--format=%(refname)', 'refs/gitcode/requests/'])
      ).trim(),
      '',
    )
  }
})

test('snapshot exposes configured remote names even before they have tracking branches', async (t) => {
  const { root, git, bare } = await remoteFixture(t)
  await git.git(root, ['remote', 'add', 'team/company', bare])
  const snapshot = await git.snapshot(root)
  assert.deepEqual(snapshot.remotes, ['origin', 'team/company'])
  assert.equal(
    snapshot.branches.some((branch) => branch.name.startsWith('team/company/')),
    false,
  )
})

test('unmerged local branches can be explicitly force deleted without changing current or remote branches', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('base.txt')
  const base = await commit('base')
  await git.git(root, ['switch', '-c', 'feature/unmerged'])
  await write('topic.txt', 'unique commit\n')
  const tip = await commit('topic')
  await git.git(root, ['switch', 'main'])
  await git.git(root, ['update-ref', 'refs/remotes/origin/feature/unmerged', tip])
  const request = {
    action: 'delete-branch',
    name: 'feature/unmerged',
    expectedOid: tip,
    expectedHead: base,
    expectedBranch: 'main',
  }
  const rejected = await git.action(root, request)
  assert.equal(rejected.outcome, 'failed')
  assert.equal(rejected.branchDeleteBlocked, 'unmerged')
  assert.match(rejected.error, /强制删除/)
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/feature/unmerged'])).trim(), tip)
  const invalid = await git.action(root, { ...request, force: 'true' })
  assert.equal(invalid.outcome, 'failed')
  assert.match(invalid.error, /无效/)
  const deleted = await git.action(root, { ...request, force: true })
  assert.equal(deleted.outcome, 'succeeded', deleted.error)
  assert.equal(await git.head(root), base)
  assert.equal(await git.currentBranch(root), 'main')
  assert.equal((await git.git(root, ['branch', '--list', 'feature/unmerged'])).trim(), '')
  assert.equal(
    (await git.git(root, ['rev-parse', 'refs/remotes/origin/feature/unmerged'])).trim(),
    tip,
  )
})

test('force deletion still rejects changed branches and branches used by any worktree', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('base.txt')
  const base = await commit('base')
  await git.git(root, ['branch', 'topic'])
  const request = {
    action: 'delete-branch',
    name: 'topic',
    force: true,
    expectedOid: base,
    expectedHead: base,
    expectedBranch: 'main',
  }
  const current = await git.action(root, { ...request, name: 'main' })
  assert.equal(current.outcome, 'failed')
  assert.match(current.error, /工作区/)
  const linked = path.join(root, 'linked')
  await git.git(root, ['worktree', 'add', linked, 'topic'])
  const inUse = await git.action(root, request)
  assert.equal(inUse.outcome, 'failed')
  assert.match(inUse.error, /工作区/)
  await git.git(root, ['worktree', 'remove', linked])
  await write('other.txt', 'advance\n')
  const next = await commit('advance')
  await git.git(root, ['update-ref', 'refs/heads/topic', next, base])
  const stale = await git.action(root, { ...request, expectedHead: next })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /目标分支已变化/)
  assert.equal((await git.git(root, ['rev-parse', 'refs/heads/topic'])).trim(), next)
})

test('setting upstream validates both refs and worktree occupancy is exposed without changing branches', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('base.txt')
  const oid = await commit('base')
  await git.git(root, ['remote', 'add', 'origin', path.join(root, 'unused-remote')])
  await git.git(root, ['update-ref', 'refs/remotes/origin/topic', oid])
  await git.git(root, ['branch', 'topic'])
  const linked = root + '-linked'
  t.after(() => fs.rm(linked, { recursive: true, force: true, maxRetries: 3 }))
  await git.git(root, ['worktree', 'add', linked, 'topic'])
  const snapshot = await git.snapshot(root)
  // Git emits slash-separated canonical paths on Windows, including for 8.3 inputs.
  assert.equal(
    await fs.realpath(snapshot.branches.find((b) => b.name === 'topic').worktreePath),
    await fs.realpath(linked),
  )
  assert.equal(
    await fs.realpath(snapshot.branches.find((b) => b.name === 'main').worktreePath),
    await fs.realpath(root),
  )
  const request = {
    action: 'set-upstream',
    name: 'main',
    expectedOid: oid,
    fullRef: 'refs/remotes/origin/topic',
    upstreamOid: oid,
  }
  const result = await act(git, root, request)
  assert.equal(result.snapshot.branches.find((b) => b.name === 'main').upstream, 'origin/topic')
  assert.equal(await git.head(root), oid)
  assert.equal(await git.currentBranch(root), 'main')
  await git.git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic'])
  await assert.rejects(
    act(git, root, { ...request, fullRef: 'refs/remotes/origin/HEAD' }),
    /符号引用/,
  )
  await assert.rejects(act(git, root, { ...request, upstreamOid: 'f'.repeat(40) }), /已变化/)
  await assert.rejects(act(git, root, { ...request, fullRef: 'refs/heads/topic' }), /远程上游/)
})

test('branch identity remains exact with same-name tags and literal heads prefixes', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const base = await commit()
  await git.git(root, ['tag', 'main'])
  assert.equal(await git.currentBranch(root), 'main')
  assert.equal((await git.snapshot(root)).branch, 'main')
  await git.git(root, ['switch', '-c', 'heads/main'])
  await git.git(root, ['tag', 'heads/main'])
  assert.equal(await git.currentBranch(root), 'heads/main')
  await git.git(root, ['switch', '--orphan', 'qa/unborn'])
  await git.git(root, ['tag', 'qa/unborn', base])
  assert.equal(await git.currentBranch(root), 'qa/unborn')
  assert.equal(await git.head(root), '')
  await git.git(root, ['switch', '--detach', base])
  assert.equal(await git.currentBranch(root), '')
})

test('file-directory transitions reject partial stage and unstage selections without touching the index', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('entry', 'old\n')
  await commit()
  await fs.rm(path.join(root, 'entry'))
  await fs.mkdir(path.join(root, 'entry'))
  await write('entry/child.txt', 'new\n')
  const before = await git.indexFingerprint(root)
  await assert.rejects(act(git, root, { action: 'stage', paths: ['entry'] }), /一并选择/)
  assert.equal(await git.indexFingerprint(root), before)
  await act(git, root, { action: 'stage', paths: ['entry', 'entry/child.txt'] })
  const staged = await git.indexFingerprint(root)
  await assert.rejects(act(git, root, { action: 'unstage', paths: ['entry'] }), /一并选择/)
  assert.equal(await git.indexFingerprint(root), staged)
  await assert.rejects(
    act(git, root, { action: 'unstage', paths: ['entry/child.txt'] }),
    /一并选择/,
  )
  await act(git, root, { action: 'unstage', paths: ['entry', 'entry/child.txt'] })
  assert.equal((await git.status(root)).staged.length, 0)
  assert.equal(await fs.readFile(path.join(root, 'entry', 'child.txt'), 'utf8'), 'new\n')
})

test('normal history and count exclude metadata refs while retaining detached HEAD and public tags', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('a.txt')
  const base = await commit()
  await git.git(root, ['notes', 'add', '-m', 'private metadata'])
  const tree = (await git.git(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const extra = (await git.git(root, ['commit-tree', tree, '-m', 'metadata only'])).trim()
  for (const ref of [
    'refs/prefetch/remotes/origin/hidden',
    'refs/other/hidden',
    'refs/gitcode/recovery/test',
  ])
    await git.git(root, ['update-ref', ref, extra])
  let state = await git.snapshot(root)
  assert.equal(state.total, 1)
  assert.deepEqual(
    state.commits.map((c) => c.hash),
    [base],
  )
  await git.git(root, ['tag', '-a', 'public-tag', '-m', 'tag', extra])
  state = await git.snapshot(root)
  assert.equal(state.total, 2)
  assert.ok(state.commits.some((c) => c.hash === extra))
  await git.git(root, ['tag', '-d', 'public-tag'])
  await git.git(root, ['switch', '--detach', extra])
  state = await git.snapshot(root)
  assert.equal(state.total, 2)
  assert.ok(state.commits.some((c) => c.hash === extra))
})

test('staged rename diffs preserve both paths even when rename detection is disabled in user config', async (t) => {
  const { root, git, write, commit } = await repository(t)
  await write('old.txt', 'one\ntwo\nthree\n')
  await commit()
  await git.git(root, ['mv', 'old.txt', 'renamed.txt'])
  await git.git(root, ['config', 'diff.renames', 'false'])
  const diff = await git.diff(root, 'renamed.txt', true)
  assert.match(diff.diff, /rename from old.txt/)
  assert.match(diff.diff, /rename to renamed.txt/)
  assert.doesNotMatch(diff.diff, /new file mode/)
})

test(
  'Windows long paths remain visible and can be staged without changing repository configuration',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, git, write, commit } = await repository(t)
    await write('base.txt')
    await commit()
    await git.git(root, ['config', 'core.longpaths', 'false'])
    const name =
      Array.from({ length: 10 }, (_, i) => 'directory-' + i + '-abcdefghijklmnop').join('/') +
      '/deep.txt'
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await write(name, 'deep\n')
    assert.ok(path.join(root, name).length > 260)
    assert.ok((await git.status(root)).unstaged.some((file) => file.path === name))
    const result = await act(git, root, { action: 'stage', paths: [name] })
    assert.ok(result.snapshot.staged.some((file) => file.path === name))
    assert.match(await fs.readFile(path.join(root, '.git', 'config'), 'utf8'), /longpaths = false/)
  },
)
