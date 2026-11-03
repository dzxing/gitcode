const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, type = 'feature') {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-finish-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'production'])
  for (const [k, v] of [
    ['user.name', 'Finish test'],
    ['user.email', 'finish@example.test'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
    ['gitflow.branch.master', 'production'],
    ['gitflow.branch.develop', 'develop'],
    ['gitflow.prefix.feature', 'feature/'],
    ['gitflow.prefix.release', 'release/'],
    ['gitflow.prefix.hotfix', 'hotfix/'],
    ['gitflow.prefix.versiontag', 'v'],
  ])
    await git.git(repo, ['config', k, v])
  const write = (file, text) => fs.writeFile(path.join(repo, file), text),
    commit = async (msg) => {
      await git.git(repo, ['add', '.'])
      await git.git(repo, ['commit', '-m', msg])
      return git.head(repo)
    }
  await write('shared.txt', 'base\n')
  const base = await commit('base')
  await git.git(repo, ['branch', 'develop'])
  const branch = type + '/1.0.0'
  await git.git(repo, ['switch', '-c', branch, type === 'hotfix' ? 'production' : 'develop'])
  await write('shared.txt', type + ' content\n')
  const source = await commit('source work')
  const action = async (name, extra = {}) =>
    git.action(repo, {
      action: name,
      expectedHead: await git.head(repo),
      expectedBranch: await git.currentBranch(repo),
      ...extra,
    })
  const finish = async (extra = {}) => {
    const snap = await git.snapshot(repo)
    return action('gitflow-finish', {
      signature: snap.gitflow.signature,
      branch,
      sourceOid: source,
      targetOids: Object.fromEntries(
        snap.branches.filter((b) => b.kind === 'local').map((b) => [b.name, b.hash]),
      ),
      deleteBranch: true,
      createTag: type !== 'feature',
      tagName: 'v1.0.0',
      tagMessage: 'Version 1.0.0',
      ...extra,
    })
  }
  return { repo, git, base, branch, source, write, commit, action, finish }
}
for (const type of ['feature', 'release', 'hotfix'])
  test(
    type + ' Finish executes merges and cleanup, tags the production result when requested',
    async (t) => {
      const f = await fixture(t, type),
        result = await f.finish()
      assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
      assert.equal(result.snapshot.gitflow.finish, null)
      assert.equal(result.snapshot.branch, 'develop')
      assert.ok(!result.snapshot.branches.some((b) => b.name === f.branch))
      assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), type + ' content\n')
      assert.equal((await f.git.git(f.repo, ['merge-base', f.source, 'develop'])).trim(), f.source)
      if (type === 'feature')
        assert.equal((await f.git.git(f.repo, ['rev-parse', 'production'])).trim(), f.base)
      else {
        const production = (await f.git.git(f.repo, ['rev-parse', 'production'])).trim()
        assert.notEqual(production, f.base)
        assert.equal((await f.git.git(f.repo, ['rev-parse', 'v1.0.0^{}'])).trim(), production)
        assert.equal((await f.git.git(f.repo, ['cat-file', '-t', 'v1.0.0'])).trim(), 'tag')
      }
    },
  )
test('Finish pauses before switching over an ignored local file and can safely resume', async (t) => {
  const f = await fixture(t)
  const exclude = (await f.git.git(f.repo, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  await fs.appendFile(path.resolve(f.repo, exclude), '\nprivate.txt\n')
  await f.git.git(f.repo, ['switch', 'develop'])
  await f.write('private.txt', 'tracked target\n')
  await f.git.git(f.repo, ['add', '-f', 'private.txt'])
  const target = await f.commit('target tracks ignored path')
  await f.git.git(f.repo, ['switch', f.branch])
  await f.write('private.txt', 'local data to preserve\n')
  const blocked = await f.finish()
  assert.notEqual(blocked.outcome, 'succeeded', JSON.stringify(blocked))
  assert.equal(blocked.snapshot.branch, f.branch)
  assert.equal(
    await fs.readFile(path.join(f.repo, 'private.txt'), 'utf8'),
    'local data to preserve\n',
  )
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'develop'])).trim(), target)
  assert.equal((await f.git.git(f.repo, ['rev-parse', f.branch])).trim(), f.source)
  assert.ok(blocked.snapshot.gitflow.finish, JSON.stringify(blocked))
  await fs.rm(path.join(f.repo, 'private.txt'))
  const resumed = await f.action('gitflow-finish-continue', {
    finishSignature: blocked.snapshot.gitflow.finish.signature,
  })
  assert.equal(resumed.outcome, 'succeeded', JSON.stringify(resumed))
  assert.equal(resumed.snapshot.branch, 'develop')
  assert.equal(await fs.readFile(path.join(f.repo, 'private.txt'), 'utf8'), 'tracked target\n')
})

test('Finish can retain a source branch and skip a version tag', async (t) => {
  const f = await fixture(t, 'hotfix'),
    result = await f.finish({ deleteBranch: false, createTag: false })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.ok(result.snapshot.branches.some((b) => b.name === f.branch))
  assert.equal((await f.git.git(f.repo, ['tag', '--list'])).trim(), '')
})
test('tag collision blocks before changes; dirty worktree is auto-stashed and restored on success', async (t) => {
  const f = await fixture(t, 'release')
  await f.git.git(f.repo, ['tag', 'v1.0.0'])
  let result = await f.finish()
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /标签.*已存在/)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'production'])).trim(), f.base)
  assert.equal(result.snapshot.gitflow.finish, null)
  await f.git.git(f.repo, ['tag', '-d', 'v1.0.0'])
  await f.write('draft.txt', 'keep')
  result = await f.finish()
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(await fs.readFile(path.join(f.repo, 'draft.txt'), 'utf8'), 'keep')
  assert.equal(result.snapshot.stashes.length, 0)
  assert.equal(result.snapshot.gitflow.finish, null)
})
test('conflicted Finish survives a new service and resumes after three-way resolution without duplicate merges', async (t) => {
  const f = await fixture(t, 'release')
  await f.git.git(f.repo, ['switch', 'develop'])
  await f.write('shared.txt', 'develop conflict\n')
  const develop = await f.commit('develop work')
  await f.git.git(f.repo, ['switch', f.branch])
  let result = await f.finish()
  assert.equal(result.outcome, 'partial', result.error)
  assert.ok(result.snapshot.merge.active)
  assert.equal(result.snapshot.branch, 'develop')
  const production = (await f.git.git(f.repo, ['rev-parse', 'production'])).trim()
  assert.notEqual(production, f.base)
  assert.equal(result.snapshot.gitflow.finish.index, 2)
  const restarted = new GitService()
  t.after(() => restarted.shutdown())
  let state = await restarted.snapshot(f.repo)
  const read = await restarted.merge.read(f.repo, 'shared.txt')
  result = await restarted.action(f.repo, {
    action: 'merge-resolve',
    expectedHead: state.head,
    expectedBranch: state.branch,
    mergeSignature: read.state.signature,
    token: read.file.token,
    file: read.file.path,
    choice: 'manual',
    content: 'combined release\n',
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  state = result.snapshot
  result = await restarted.action(f.repo, {
    action: 'merge-finish',
    expectedHead: state.head,
    expectedBranch: state.branch,
    mergeSignature: state.merge.signature,
    message: 'Resolve release integration',
  })
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
  assert.equal(result.snapshot.gitflow.finish, null)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'production'])).trim(), production)
  assert.equal((await f.git.git(f.repo, ['rev-list', '--count', 'production'])).trim(), '3')
  assert.equal((await f.git.git(f.repo, ['merge-base', develop, 'develop'])).trim(), develop)
})
test('abort and stop preserve completed release merges and tags without deleting the source', async (t) => {
  const f = await fixture(t, 'release')
  await f.git.git(f.repo, ['switch', 'develop'])
  await f.write('shared.txt', 'conflict\n')
  await f.commit('develop')
  await f.git.git(f.repo, ['switch', f.branch])
  let result = await f.finish()
  assert.equal(result.outcome, 'partial')
  const production = (await f.git.git(f.repo, ['rev-parse', 'production'])).trim()
  result = await f.action('merge-abort', { mergeSignature: result.snapshot.merge.signature })
  assert.equal(result.outcome, 'succeeded', result.error)
  await f.write('local-draft.txt', 'preserved local draft\n')
  result = await f.action('gitflow-finish-stop', {
    finishSignature: result.snapshot.gitflow.finish.signature,
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'production'])).trim(), production)
  assert.ok(result.snapshot.branches.some((b) => b.name === f.branch))
  assert.equal(result.snapshot.gitflow.finish, null)
  assert.equal(
    await fs.readFile(path.join(f.repo, 'local-draft.txt'), 'utf8'),
    'preserved local draft\n',
  )
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'v1.0.0^{}'])).trim(), production)
})
test('a published source is deleted only locally and its local tracking configuration is removed', async (t) => {
  const f = await fixture(t),
    bare = path.join(f.repo, '.git', 'remote.git')
  await f.git.git(f.repo, ['init', '--bare', bare])
  await f.git.git(f.repo, ['remote', 'add', 'origin', bare])
  await f.git.git(f.repo, ['push', '-u', 'origin', f.branch])
  const result = await f.finish()
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await f.git.git(bare, ['rev-parse', 'refs/heads/' + f.branch])).trim(), f.source)
  assert.equal(
    (
      await f.git.git(f.repo, ['config', '--local', '--get', 'branch.' + f.branch + '.remote'], {
        allowedCodes: [0, 1],
      })
    ).trim(),
    '',
  )
})
test('external changes to an owned tag block cleanup and retain the source', async (t) => {
  const f = await fixture(t, 'release'),
    original = f.git.merge.start.bind(f.git.merge)
  let calls = 0
  f.git.merge.start = async (...args) => {
    if (++calls === 2) throw new Error('simulated pause before backmerge')
    return original(...args)
  }
  let result = await f.finish()
  assert.equal(result.outcome, 'partial')
  assert.ok(result.snapshot.gitflow.finish)
  await f.git.git(f.repo, ['tag', '-d', 'v1.0.0'])
  f.git.merge.start = original
  result = await f.action('gitflow-finish-continue', {
    finishSignature: result.snapshot.gitflow.finish.signature,
  })
  assert.equal(result.outcome, 'partial')
  assert.match(result.error, /标签已被外部/)
  assert.ok(result.snapshot.branches.some((b) => b.name === f.branch))
})
test('a target checked out in another worktree blocks Finish before changing refs', async (t) => {
  const f = await fixture(t),
    other = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-flow-other-'))
  t.after(() => fs.rm(other, { recursive: true, force: true }))
  await f.git.git(f.repo, ['worktree', 'add', other, 'develop'])
  const result = await f.finish()
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /工作区使用/)
  assert.equal(result.snapshot.gitflow.finish, null)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'develop'])).trim(), f.base)
})
test('a merge completed externally is reconciled on resume without replaying production', async (t) => {
  const f = await fixture(t, 'release')
  await f.git.git(f.repo, ['switch', 'develop'])
  await f.write('shared.txt', 'develop conflict\n')
  await f.commit('develop')
  await f.git.git(f.repo, ['switch', f.branch])
  let result = await f.finish()
  assert.equal(result.outcome, 'partial')
  const production = (await f.git.git(f.repo, ['rev-parse', 'production'])).trim()
  await f.write('shared.txt', 'external resolution\n')
  await f.git.git(f.repo, ['add', 'shared.txt'])
  await f.git.git(f.repo, ['commit', '-m', 'Resolve externally'])
  const state = await f.git.snapshot(f.repo)
  result = await f.action('gitflow-finish-continue', {
    finishSignature: state.gitflow.finish.signature,
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(result.snapshot.gitflow.finish, null)
  assert.equal((await f.git.git(f.repo, ['rev-parse', 'production'])).trim(), production)
})
