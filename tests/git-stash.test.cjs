const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, initial = true) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-stash-中文 ')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'main'])
  for (const [k, v] of [
    ['user.name', 'Stash test'],
    ['user.email', 'stash@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', k, v])
  const write = (name, text) => fs.writeFile(path.join(repo, name), text)
  if (initial) {
    await write('a.txt', 'base\n')
    await write('.gitignore', '*.ignored\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'Base'])
  }
  const request = async (extra) => ({
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
    stashSignature: (await git.stash.list(repo)).signature,
    ...extra,
  })
  const act = async (extra) => git.action(repo, await request(extra))
  const create = async (includeUntracked = true) => {
    const result = await act({ action: 'stash-create', message: '中文 stash', includeUntracked })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    return result.snapshot.stashes[0]
  }
  const operate = (entry, action = 'stash-apply', extra = {}) =>
    act({ action, stashOid: entry.oid, stashRef: entry.ref, restoreIndex: true, ...extra })
  return { repo, git, write, request, act, create, operate }
}
test('stash captures partial index and untracked, excludes ignored and ordinary graph, previews both versions', async (t) => {
  const { repo, git, write, create, operate } = await fixture(t)
  await write('a.txt', 'index\n')
  await git.git(repo, ['add', 'a.txt'])
  await write('a.txt', 'working\n')
  await write('新 文件.txt', 'new\n')
  await write('literal[1].txt', 'literal\n')
  await write('keep.ignored', 'ignored\n')
  const head = await git.head(repo),
    entry = await create(),
    snapshot = await git.snapshot(repo)
  assert.equal(snapshot.head, head)
  assert.equal(snapshot.total, 1)
  assert.equal(snapshot.commits.length, 1)
  assert.deepEqual(snapshot.staged, [])
  assert.deepEqual(snapshot.unstaged, [])
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'base\n')
  assert.equal(await fs.readFile(repo + '/keep.ignored', 'utf8'), 'ignored\n')
  const detail = await git.stash.read(repo, entry.oid, 'a.txt')
  assert.match(detail.diff.diff, /\+working/)
  assert.match(detail.indexDiff.diff, /\+index/)
  assert.match((await git.stash.read(repo, entry.oid, '新 文件.txt')).diff.diff, /\+new/)
  const result = await operate(entry)
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.stashes.length, 1)
  assert.equal(await git.git(repo, ['show', ':a.txt']), 'index\n')
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'working\n')
  assert.equal(await fs.readFile(repo + '/新 文件.txt', 'utf8'), 'new\n')
  assert.equal(await fs.readFile(repo + '/literal[1].txt', 'utf8'), 'literal\n')
})
test('excluding untracked retains those files; index-only changes remain visible in preview', async (t) => {
  const { repo, git, write, create } = await fixture(t)
  await write('a.txt', 'index\n')
  await git.git(repo, ['add', 'a.txt'])
  await write('a.txt', 'base\n')
  await write('leave.txt', 'leave\n')
  const entry = await create(false)
  assert.equal(await fs.readFile(repo + '/leave.txt', 'utf8'), 'leave\n')
  const details = await git.stash.read(repo, entry.oid, 'a.txt')
  assert.equal(details.diff.diff, '')
  assert.match(details.indexDiff.diff, /\+index/)
  assert.equal(details.files.length, 1)
})
test('restoreIndex false overrides stash.index configuration and pop removes only the chosen older entry', async (t) => {
  const { repo, git, write, create, operate } = await fixture(t)
  await write('a.txt', 'first\n')
  await git.git(repo, ['add', 'a.txt'])
  const first = await create()
  await write('a.txt', 'second\n')
  const second = await create()
  const list = await git.stash.list(repo),
    older = list.entries.find((e) => e.oid === first.oid)
  await git.git(repo, ['config', 'stash.index', 'true'])
  const result = await operate(older, 'stash-pop', { restoreIndex: false })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.deepEqual(
    result.snapshot.stashes.map((e) => e.oid),
    [second.oid],
  )
  assert.equal(result.snapshot.staged.length, 0)
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'first\n')
})
test('stale lists, invalid identities and changed HEAD never apply or delete another entry', async (t) => {
  const { repo, git, write, create, request } = await fixture(t)
  await write('a.txt', 'one\n')
  const entry = await create()
  const old = await request({
    action: 'stash-drop',
    stashOid: entry.oid,
    stashRef: entry.ref,
    confirmDelete: true,
  })
  await write('a.txt', 'two\n')
  await create()
  const reject = await git.action(repo, old)
  assert.equal(reject.outcome, 'failed')
  assert.equal(reject.snapshot.stashes.length, 2)
  const wrong = await git.action(
    repo,
    await request({
      action: 'stash-drop',
      stashOid: entry.oid,
      stashRef: 'stash@{0}',
      confirmDelete: true,
    }),
  )
  assert.equal(wrong.outcome, 'failed')
  const stale = await request({
    action: 'stash-apply',
    stashOid: entry.oid,
    stashRef: 'stash@{1}',
    restoreIndex: true,
  })
  await git.git(repo, ['commit', '--allow-empty', '-m', 'External'])
  assert.equal((await git.action(repo, stale)).outcome, 'failed')
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'base\n')
})
test('dirty workspace, unborn repository and in-progress operations explain blockers', async (t) => {
  const { repo, git, write, create, operate, act } = await fixture(t)
  await write('a.txt', 'stash\n')
  const entry = await create()
  await write('new.txt', 'untracked\n')
  assert.match((await operate(entry)).error, /当前工作区/)
  await fs.rm(repo + '/new.txt')
  await fs.writeFile(repo + '/.git/MERGE_HEAD', await git.head(repo))
  assert.match(
    (await act({ action: 'stash-create', message: '', includeUntracked: true })).error,
    /未完成/,
  )
  const empty = await fixture(t, false)
  await empty.write('a', 'new')
  assert.match(
    (await empty.act({ action: 'stash-create', message: '', includeUntracked: true })).error,
    /首次提交/,
  )
})
test('conflicting pop keeps stash and reports partial restoration without resetting files', async (t) => {
  const { repo, git, write, create, operate } = await fixture(t)
  await write('a.txt', 'stash value\n')
  const entry = await create()
  await write('a.txt', 'other branch value\n')
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'Different base'])
  const result = await operate(entry, 'stash-pop', { restoreIndex: false })
  assert.equal(result.outcome, 'partial')
  assert.equal(result.snapshot.stashes[0].oid, entry.oid)
  assert.ok(result.snapshot.unstaged.some((f) => f.status === 'U'))
  assert.match(await fs.readFile(repo + '/a.txt', 'utf8'), /<<<<<<<|=======/)
  assert.match(result.warning, /记录保留/)
})
test('drop requires explicit confirmation and never modifies working files', async (t) => {
  const { repo, write, create, operate } = await fixture(t)
  await write('a.txt', 'stash\n')
  const entry = await create()
  await write('a.txt', 'local remains\n')
  assert.equal((await operate(entry, 'stash-drop')).outcome, 'failed')
  const result = await operate(entry, 'stash-drop', { confirmDelete: true })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.snapshot.stashes.length, 0)
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'local remains\n')
})
test('apply succeeded but removal failure retains stash and reports partial without retry', async (t) => {
  const { repo, git, write, create, operate } = await fixture(t)
  await write('a.txt', 'restored\n')
  const entry = await create()
  const run = git.git.bind(git)
  let drops = 0
  git.git = async (r, args, options) => {
    if (args[0] === 'stash' && args[1] === 'drop') {
      drops++
      throw new Error('test drop failed')
    }
    return run(r, args, options)
  }
  const result = await operate(entry, 'stash-pop')
  assert.equal(result.outcome, 'partial')
  assert.match(result.warning, /内容已恢复/)
  assert.equal(drops, 1)
  assert.equal(result.snapshot.stashes.length, 1)
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'restored\n')
})
test('stash reads validate identity and member paths, never invoking external diff helpers', async (t) => {
  const { repo, git, write, create } = await fixture(t)
  await write('a.txt', 'stash\n')
  const entry = await create()
  await assert.rejects(git.stash.read(repo, 'HEAD', 'a.txt'), /无效/)
  await assert.rejects(git.stash.read(repo, entry.oid, '../secret'), /路径/)
  await assert.rejects(git.stash.read(repo, entry.oid, 'not-present'), /不在/)
})

test('cancellation after files restored does not drop the record or reset restored files', async (t) => {
  const { repo, git, write, create, request } = await fixture(t)
  await write('a.txt', 'cancelled restore\n')
  const entry = await create()
  const controller = new AbortController(),
    run = git.git.bind(git)
  let drops = 0
  git.git = async (r, args, options) => {
    if (args[0] === 'stash' && args[1] === 'drop') drops++
    const result = await run(r, args, options)
    if (args.includes('stash') && args.includes('apply')) controller.abort()
    return result
  }
  const result = await git.action(
    repo,
    await request({
      action: 'stash-pop',
      stashOid: entry.oid,
      stashRef: entry.ref,
      restoreIndex: true,
    }),
    controller.signal,
  )
  assert.equal(result.outcome, 'cancelled')
  assert.equal(drops, 0)
  assert.equal(result.snapshot.stashes.length, 1)
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'cancelled restore\n')
})
test('stash list change after apply preserves both records instead of dropping a shifted ordinal', async (t) => {
  const { repo, git, write, create, operate } = await fixture(t)
  await write('a.txt', 'restored\n')
  const entry = await create()
  const run = git.git.bind(git)
  let drops = 0
  const indexParent = (await git.git(repo, ['rev-parse', `${entry.oid}^2`])).trim()
  const external = (
    await git.git(repo, [
      'commit-tree',
      `${entry.oid}^{tree}`,
      '-p',
      entry.base,
      '-p',
      indexParent,
      '-m',
      'External snapshot',
    ])
  ).trim()
  git.git = async (r, args, options) => {
    if (args[0] === 'stash' && args[1] === 'drop') drops++
    const result = await run(r, args, options)
    if (args.includes('stash') && args.includes('apply'))
      await run(r, ['stash', 'store', '-m', 'External record', external])
    return result
  }
  const result = await operate(entry, 'stash-pop')
  assert.equal(result.outcome, 'partial')
  assert.equal(drops, 0)
  assert.equal(result.snapshot.stashes.length, 2)
  assert.equal(await fs.readFile(repo + '/a.txt', 'utf8'), 'restored\n')
})
