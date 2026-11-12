'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')

async function fixture(t, initial = true, format) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-selected-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', ...(format ? [`--object-format=${format}`] : []), '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Selected commit test'],
    ['user.email', 'selected@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', key, value])
  const write = (name, content) => fs.writeFile(path.join(repo, name), content)
  if (initial) {
    for (const name of ['a.txt', 'b.txt', 'old.txt']) await write(name, `base ${name}\n`)
    await git.git(repo, ['add', '--all'])
    await git.git(repo, ['commit', '-m', 'base'])
  }
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
  })
  const plan = async (paths) => git.selectedCommitPlan(repo, { ...(await context()), paths })
  const commit = async (plan, extra = {}) =>
    git.action(repo, {
      ...(await context()),
      action: 'commit-selected',
      planId: plan.id,
      message: 'selected files',
      ...extra,
    })
  const index = () =>
    fs
      .readFile(path.join(repo, '.git', 'index'))
      .catch((e) => (e.code === 'ENOENT' ? Buffer.alloc(0) : Promise.reject(e)))
  const hook = async (name, script) => {
    const hooks = path.join(repo, 'test-hooks')
    await fs.mkdir(hooks, { recursive: true })
    await git.git(repo, ['config', 'core.hooksPath', 'test-hooks'])
    await fs.writeFile(path.join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  }
  return { repo, git, write, context, plan, commit, index, hook }
}

test('selected complete files preserve unselected index and require explicit partial-staging confirmation', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'staged part\n')
  await f.git.git(f.repo, ['add', 'a.txt'])
  await f.write('a.txt', 'complete selected content\n')
  await f.write('b.txt', 'unselected staged content\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  await f.write('keep-intent.txt', 'unselected intent to add\n')
  await f.git.git(f.repo, ['add', '--intent-to-add', 'keep-intent.txt'])
  const intentEntry = await f.git.git(f.repo, ['ls-files', '--stage', '--', 'keep-intent.txt'])
  await f.write('新增 文件.txt', 'new file\n')
  await fs.rename(path.join(f.repo, 'old.txt'), path.join(f.repo, 'renamed.txt'))
  await f.git.git(f.repo, ['add', '--all', '--', 'old.txt', 'renamed.txt'])
  const beforeHead = await f.git.head(f.repo),
    beforeIndex = await f.index()
  const plan = await f.plan(['a.txt', 'renamed.txt', '新增 文件.txt'])
  assert.deepEqual(plan.partialPaths, ['a.txt'])
  assert.equal(plan.files.find((file) => file.path === 'renamed.txt').oldPath, 'old.txt')
  const denied = await f.commit(plan)
  assert.equal(denied.outcome, 'failed')
  assert.match(denied.error, /部分暂存/)
  assert.deepEqual(await f.index(), beforeIndex)
  assert.equal(await f.git.head(f.repo), beforeHead)
  const result = await f.commit(plan, { confirmPartial: true })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(await f.git.git(f.repo, ['show', 'HEAD:a.txt']), 'complete selected content\n')
  assert.equal(await f.git.git(f.repo, ['show', ':b.txt']), 'unselected staged content\n')
  assert.equal(await f.git.git(f.repo, ['show', 'HEAD:b.txt']), 'base b.txt\n')
  assert.deepEqual(
    (await f.git.status(f.repo)).staged.map((file) => file.path),
    ['b.txt'],
  )
  assert.equal(
    await f.git.git(f.repo, ['ls-files', '--stage', '--', 'keep-intent.txt']),
    intentEntry,
  )
  assert.ok((await f.git.status(f.repo)).unstaged.some((file) => file.path === 'keep-intent.txt'))
  assert.match((await f.commit(plan, { confirmPartial: true })).error, /过期|不存在/)
})

test('selected initial commit excludes unrelated staged files and supports subsequent deletion', async (t) => {
  const f = await fixture(t, false)
  await f.write('a.txt', 'first\n')
  await f.write('b.txt', 'not selected\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  const first = await f.commit(await f.plan(['a.txt']))
  assert.equal(first.outcome, 'succeeded', JSON.stringify(first))
  assert.deepEqual(
    (await f.git.git(f.repo, ['ls-tree', '--name-only', 'HEAD'])).trim().split('\n'),
    ['a.txt'],
  )
  assert.equal(await f.git.git(f.repo, ['show', ':b.txt']), 'not selected\n')
  await fs.rm(path.join(f.repo, 'a.txt'))
  const deleted = await f.commit(await f.plan(['a.txt']))
  assert.equal(deleted.outcome, 'succeeded', JSON.stringify(deleted))
  assert.equal((await f.git.git(f.repo, ['ls-tree', '--name-only', 'HEAD'])).trim(), '')
  assert.deepEqual(
    (await f.git.status(f.repo)).staged.map((file) => file.path),
    ['b.txt'],
  )
})

test('plans reject same-status content changes, external staging, locks, expiry and HEAD changes', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  const content = await f.plan(['a.txt']),
    initialIndex = await f.index()
  await f.write('a.txt', 'changed!\n')
  assert.match((await f.commit(content)).error, /已变化/)
  assert.deepEqual(await f.index(), initialIndex)
  const indexPlan = await f.plan(['a.txt'])
  await f.write('b.txt', 'other\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  assert.match((await f.commit(indexPlan)).error, /已变化/)
  const locked = await f.plan(['a.txt'])
  await fs.writeFile(path.join(f.repo, '.git', 'index.lock'), 'external lock')
  assert.match((await f.commit(locked)).error, /其他 Git/)
  assert.equal(await fs.readFile(path.join(f.repo, '.git', 'index.lock'), 'utf8'), 'external lock')
  await fs.rm(path.join(f.repo, '.git', 'index.lock'))
  const expired = await f.plan(['a.txt'])
  f.git.selectedCommit.plans.get(expired.id).expiresAt = Date.now() - 1
  assert.match((await f.commit(expired)).error, /过期/)
  const contextPlan = await f.plan(['a.txt'])
  await f.git.git(f.repo, ['switch', '-c', 'other'])
  assert.match((await f.commit(contextPlan)).error, /上下文/)
})

test('pre-commit and reference hooks are honored without changing real index after failure', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.write('b.txt', 'other\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  const head = await f.git.head(f.repo),
    index = await f.index()
  await f.hook('pre-commit', 'echo hook-refused >&2\nexit 1')
  const rejected = await f.commit(await f.plan(['a.txt']))
  assert.equal(rejected.outcome, 'failed')
  assert.match(rejected.error, /pre-commit Hook 阻止/)
  assert.match(rejected.details, /hook-refused/)
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
  await fs.rm(path.join(f.repo, 'test-hooks', 'pre-commit'))
  await f.hook(
    'reference-transaction',
    '[ "$1" != prepared ] || { echo reference-refused >&2; exit 1; }',
  )
  const refRejected = await f.commit(await f.plan(['a.txt']))
  assert.equal(refRejected.outcome, 'failed')
  assert.match(refRejected.error, /reference-refused|ref updates/)
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
})

test('reference-transaction hooks receive original ref-update stdin and can refuse the commit', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.write('b.txt', 'unselected staged\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  await f.hook(
    'reference-transaction',
    'cat > "hook-input-$1"\nif [ "$1" = prepared ] && grep -q "refs/heads/main" "hook-input-$1"; then\n  echo stdin-reference-refused >&2\n  exit 1\nfi',
  )
  const head = await f.git.head(f.repo),
    index = await f.index()
  const result = await f.commit(await f.plan(['a.txt']))
  assert.equal(result.outcome, 'failed', JSON.stringify(result))
  assert.match(result.error, /stdin-reference-refused|ref updates/)
  const input = await fs.readFile(path.join(f.repo, 'hook-input-prepared'), 'utf8')
  assert.match(input, new RegExp(`^${head} [a-f0-9]{${head.length}} refs/heads/main$`, 'm'))
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
  assert.equal(await fs.stat(path.join(f.repo, '.git', 'index.lock')).catch(() => null), null)
})

test('older Git and configured event hooks fail before altering HEAD or index', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  const head = await f.git.head(f.repo),
    index = await f.index(),
    version = f.git.gitVersion
  try {
    f.git.gitVersion = 'git version 2.45.2.windows.1'
    await assert.rejects(f.plan(['a.txt']), /Git 2\.46/)
  } finally {
    f.git.gitVersion = version
  }
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
  await f.git.git(f.repo, ['config', 'hook.custom.command', 'do-not-display-this-command'])
  await f.git.git(f.repo, ['config', 'hook.custom.event', 'pre-commit'])
  await assert.rejects(
    f.plan(['a.txt']),
    (error) =>
      /配置式 hooks/.test(error.message) && !error.message.includes('do-not-display-this-command'),
  )
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
  assert.equal(await fs.stat(path.join(f.repo, '.git', 'index.lock')).catch(() => null), null)
  await f.git.git(f.repo, ['config', '--unset', 'hook.custom.command'])
  await f.git.git(f.repo, ['config', '--unset', 'hook.custom.event'])
})

test('hooks cannot silently expand or replace the reviewed commit tree', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.write('b.txt', 'unselected\n')
  const head = await f.git.head(f.repo),
    index = await f.index()
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
    await f.hook(name, 'git add b.txt')
    const result = await f.commit(await f.plan(['a.txt']))
    assert.equal(result.outcome, 'failed', JSON.stringify(result))
    assert.match(result.error, /reviewed commit content|ref updates/)
    assert.equal(await f.git.head(f.repo), head)
    assert.deepEqual(await f.index(), index)
    await fs.rm(path.join(f.repo, 'test-hooks', name))
  }
  await f.hook('pre-commit', 'printf "hook changed selected\\n" > a.txt\ngit add a.txt')
  const altered = await f.commit(await f.plan(['a.txt']))
  assert.equal(altered.outcome, 'failed')
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
  await fs.rm(path.join(f.repo, 'test-hooks', 'pre-commit'))
  await f.hook('reference-transaction', '[ "$1" != prepared ] || git add b.txt')
  const referenceAltered = await f.commit(await f.plan(['a.txt']))
  assert.equal(referenceAltered.outcome, 'failed')
  assert.equal(await f.git.head(f.repo), head)
  assert.deepEqual(await f.index(), index)
})

test('message hooks and failing post-commit hooks retain native Git commit semantics', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.hook('prepare-commit-msg', 'printf "prepared message\\n" > "$1"')
  await f.hook('commit-msg', 'printf "validated message\\n" >> "$1"')
  await f.hook('post-commit', 'exit 1')
  const result = await f.commit(await f.plan(['a.txt']))
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.match(
    await f.git.git(f.repo, ['show', '-s', '--format=%B', 'HEAD']),
    /prepared message\nvalidated message/,
  )
})

test('post-commit index edits are retained in recovery without overwriting external staging', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.write('b.txt', 'original staged\n')
  await f.git.git(f.repo, ['add', 'b.txt'])
  await f.write('b.txt', 'hook staged\n')
  await f.hook('post-commit', 'git add b.txt')
  const result = await f.commit(await f.plan(['a.txt']))
  assert.equal(result.outcome, 'partial', JSON.stringify(result))
  assert.match(result.warning, /恢复索引/)
  assert.equal(await f.git.git(f.repo, ['show', ':b.txt']), 'original staged\n')
  const files = await fs.readdir(path.join(f.repo, '.git', 'gitcode-recovery'))
  const recovered = path.join(
    f.repo,
    '.git',
    'gitcode-recovery',
    files.find((name) => name.endsWith('.index')),
  )
  assert.equal(
    await f.git.git(f.repo, ['show', ':b.txt'], { indexFile: recovered }),
    'hook staged\n',
  )
  assert.equal(await f.git.git(f.repo, ['show', 'HEAD:b.txt']), 'base b.txt\n')
})

test('external index replacement after publication is reported partial and never overwritten', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  await f.write('b.txt', 'external staged\n')
  await f.hook('post-commit', 'unset GIT_INDEX_FILE\nrm -f .git/index.lock\ngit add b.txt')
  const result = await f.commit(await f.plan(['a.txt']))
  assert.equal(result.outcome, 'partial', JSON.stringify(result))
  assert.match(result.error, /真实暂存区被外部修改/)
  assert.equal(await f.git.git(f.repo, ['show', ':b.txt']), 'external staged\n')
  assert.equal(await f.git.git(f.repo, ['show', 'HEAD:b.txt']), 'base b.txt\n')
  assert.equal(await f.git.git(f.repo, ['show', 'HEAD:a.txt']), 'selected\n')
  const retained = result.error.match(/提交私有索引保留在 (.+?)，/)[1]
  assert.ok((await fs.stat(retained)).isFile())
  t.after(() => fs.rm(path.dirname(retained), { recursive: true, force: true }))
})

test('cancelled hook and temporary-directory failure release only our index lock', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'selected\n')
  const index = await f.index(),
    plan = await f.plan(['a.txt'])
  const mkdtemp = fs.mkdtemp
  try {
    fs.mkdtemp = async () => {
      throw new Error('simulated disk full')
    }
    assert.match((await f.commit(plan)).error, /simulated disk full/)
  } finally {
    fs.mkdtemp = mkdtemp
  }
  assert.equal(await fs.stat(path.join(f.repo, '.git', 'index.lock')).catch(() => null), null)
  await f.hook('pre-commit', 'echo ready > hook-ready\nsleep 10')
  const cancelPlan = await f.plan(['a.txt']),
    controller = new AbortController()
  const pending = f.git.action(
    f.repo,
    {
      ...(await f.context()),
      action: 'commit-selected',
      planId: cancelPlan.id,
      message: 'cancelled',
    },
    controller.signal,
  )
  for (
    let i = 0;
    i < 200 && !(await fs.stat(path.join(f.repo, 'hook-ready')).catch(() => null));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.outcome, 'cancelled', JSON.stringify(cancelled))
  assert.deepEqual(await f.index(), index)
  assert.equal(await fs.stat(path.join(f.repo, '.git', 'index.lock')).catch(() => null), null)
})

test('working diff includes staged plus unstaged content and untracked files', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'staged version\n')
  await f.git.git(f.repo, ['add', 'a.txt'])
  await f.write('a.txt', 'complete working version\n')
  const working = await f.git.diff(f.repo, 'a.txt', 'working', null)
  assert.match(working.diff, /-base a.txt/)
  assert.match(working.diff, /\+complete working version/)
  assert.doesNotMatch(working.diff, /staged version/)
  await f.write('new.txt', 'untracked\n')
  assert.match((await f.git.diff(f.repo, 'new.txt', 'working', null)).diff, /\+untracked/)
  await fs.rename(path.join(f.repo, 'old.txt'), path.join(f.repo, 'renamed.txt'))
  await f.git.git(f.repo, ['add', '--all', '--', 'old.txt', 'renamed.txt'])
  const renamed = await f.git.diff(f.repo, 'renamed.txt', 'working', null)
  assert.match(renamed.diff, /rename from old.txt/)
  assert.match(renamed.diff, /rename to renamed.txt/)
  await assert.rejects(f.git.diff(f.repo, 'a.txt', 'working', await f.git.head(f.repo)), /历史提交/)
  const empty = await fixture(t, false)
  await empty.write('new.txt', 'new staged\n')
  await empty.git.git(empty.repo, ['add', 'new.txt'])
  assert.match((await empty.git.diff(empty.repo, 'new.txt', 'working', null)).diff, /\+new staged/)
})

test('linked worktrees and SHA-256 initial commits keep their own index and ref contexts', async (t) => {
  const f = await fixture(t)
  const mainHead = await f.git.head(f.repo),
    linked = f.repo + '-linked'
  t.after(() => fs.rm(linked, { recursive: true, force: true, maxRetries: 3 }))
  await f.git.git(f.repo, ['worktree', 'add', '-b', 'linked', linked])
  await fs.writeFile(path.join(linked, 'a.txt'), 'linked selected\n')
  await fs.writeFile(path.join(linked, 'b.txt'), 'linked staged\n')
  await f.git.git(linked, ['add', 'b.txt'])
  const expected = { expectedHead: mainHead, expectedBranch: 'linked' }
  const plan = await f.git.selectedCommitPlan(linked, { ...expected, paths: ['a.txt'] })
  const result = await f.git.action(linked, {
    ...expected,
    action: 'commit-selected',
    planId: plan.id,
    message: 'linked only',
  })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(await f.git.head(f.repo), mainHead)
  assert.equal(await f.git.git(linked, ['show', ':b.txt']), 'linked staged\n')
  const sha = await fixture(t, false, 'sha256')
  await sha.write('first.txt', 'SHA-256 initial\n')
  assert.equal((await sha.commit(await sha.plan(['first.txt']))).outcome, 'succeeded')
  assert.equal((await sha.git.head(sha.repo)).length, 64)
})
