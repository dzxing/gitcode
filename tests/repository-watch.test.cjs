const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
const { RepositoryWatch } = require('../electron/repository-watch.cjs')

async function setup(t, refFormat) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-watch-中文-'))
  const repo = path.join(directory, 'repo'),
    git = new GitService()
  await fs.mkdir(path.join(repo, 'src', 'deep'), { recursive: true })
  await git.git(repo, [
    'init',
    '-b',
    'qa/base',
    ...(refFormat ? [`--ref-format=${refFormat}`] : []),
  ])
  for (const [key, value] of [
    ['user.name', 'Watch QA'],
    ['user.email', 'watch@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', key, value])
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored/\n')
  await fs.writeFile(path.join(repo, 'src', 'deep', 'file.txt'), 'base\n')
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'baseline'])
  t.after(async () => {
    await git.shutdown()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  return { git, repo, directory, watch: git.repositoryWatch }
}
async function changed(watch, repo, previous) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const status = await watch.status(repo)
    if (status.revision !== previous) return status
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail('Filesystem change was not observed')
}

test('real filesystem edits, atomic saves, new directories and deletions refresh without writing the index', async (t) => {
  const { git, repo, watch } = await setup(t)
  let before = await watch.status(repo)
  const index = await git.indexFingerprint(repo)
  const file = path.join(repo, 'src', 'deep', 'file.txt')
  await fs.writeFile(file, 'edited externally\n')
  before = await changed(watch, repo, before.revision)
  const first = await watch.read(repo, { file: { path: 'src/deep/file.txt', source: 'working' } })
  assert.ok(first.diff.diff.includes('+edited externally'))
  assert.equal(await git.indexFingerprint(repo), index)
  await fs.writeFile(file + '.tmp', 'atomic save\n')
  await fs.rename(file + '.tmp', file)
  before = await changed(watch, repo, before.revision)
  assert.ok(
    (await watch.read(repo, null)).snapshot.unstaged.some((f) => f.path === 'src/deep/file.txt'),
  )
  await fs.mkdir(path.join(repo, 'new', 'nested'), { recursive: true })
  await fs.writeFile(path.join(repo, 'new', 'nested', 'new.txt'), 'new\n')
  before = await changed(watch, repo, before.revision)
  await watch.read(repo, null)
  before = await watch.status(repo)
  await fs.writeFile(path.join(repo, 'new', 'nested', 'new.txt'), 'second edit\n')
  await changed(watch, repo, before.revision)
  await fs.unlink(file)
  assert.ok(
    (await watch.read(repo, null)).snapshot.unstaged.some(
      (f) => f.path === 'src/deep/file.txt' && f.status === 'D',
    ),
  )
  await fs.mkdir(path.join(repo, 'ignored', 'many'), { recursive: true })
  await fs.writeFile(path.join(repo, 'ignored', 'many', 'ignored.txt'), 'ignored')
  await watch.read(repo, null)
  assert.ok(
    ![...watch.entries.get(repo).handles.keys()].some((dir) =>
      dir.includes(path.join('ignored', 'many')),
    ),
  )
})

test('external branch switches and commits update HEAD, graph and references', async (t) => {
  const { git, repo, watch } = await setup(t)
  const initial = await watch.status(repo)
  await git.git(repo, ['switch', '-c', 'qa/external'])
  await changed(watch, repo, initial.revision)
  await fs.writeFile(path.join(repo, 'outside.txt'), 'new commit\n')
  await git.git(repo, ['add', 'outside.txt'])
  await git.git(repo, ['commit', '-m', 'external commit'])
  const result = await watch.read(repo, null)
  assert.equal(result.snapshot.branch, 'qa/external')
  assert.equal(result.snapshot.commits[0].subject, 'external commit')
  assert.equal(result.snapshot.head, await git.head(repo))
})

for (const format of ['files', 'reftable']) {
  test(`${format}: non-current local and remote branch changes update the complete graph without checkout`, async (t) => {
    const { git, repo, watch } = await setup(t, format)
    const head = await git.head(repo)
    const tree = (await git.git(repo, ['rev-parse', 'HEAD^{tree}'])).trim()
    await git.git(repo, ['branch', 'feature/background'])
    const before = await watch.status(repo)
    const commit = (
      await git.git(repo, ['commit-tree', tree, '-p', head, '-m', 'non-current branch commit'])
    ).trim()
    await git.git(repo, ['update-ref', 'refs/heads/feature/background', commit])
    await changed(watch, repo, before.revision)
    const first = (await watch.read(repo, null)).snapshot
    assert.equal(first.head, head)
    assert.equal(first.branch, 'qa/base')
    assert.ok(first.commits.some((c) => c.hash === commit))
    assert.equal(first.branches.find((b) => b.name === 'feature/background').hash, commit)
    const status = await watch.status(repo)
    const remote = (
      await git.git(repo, ['commit-tree', tree, '-p', head, '-m', 'remote tracking commit'])
    ).trim()
    await git.git(repo, ['update-ref', 'refs/remotes/origin/feature/remote', remote])
    await changed(watch, repo, status.revision)
    const next = (await watch.read(repo, null)).snapshot
    assert.equal(next.head, head)
    assert.ok(next.commits.some((c) => c.hash === commit))
    assert.ok(next.commits.some((c) => c.hash === remote))
    assert.equal(next.branches.find((b) => b.name === 'origin/feature/remote').hash, remote)
  })
}

test('readonly updates defer to foreground work and external index locks', async (t) => {
  const { git, repo, watch } = await setup(t)
  await watch.status(repo)
  await fs.writeFile(path.join(repo, '.git', 'index.lock'), 'held by external Git')
  assert.equal((await watch.read(repo, null)).deferred, 'locked')
  await fs.unlink(path.join(repo, '.git', 'index.lock'))
  let release
  const held = git.job(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal((await watch.read(repo, null)).deferred, 'busy')
  release()
  await held
  assert.ok((await watch.read(repo, null)).snapshot)
})

test('linked worktree watches its gitdir and shared refs outside the working directory', async (t) => {
  const { git, repo, directory, watch } = await setup(t)
  const linked = path.join(directory, 'linked')
  await git.git(repo, ['worktree', 'add', '-b', 'qa/linked', linked])
  const status = await watch.status(linked)
  const entry = watch.entries.get(linked)
  assert.notEqual(entry.gitDir, path.join(linked, '.git'))
  assert.equal(await fs.realpath(entry.commonDir), await fs.realpath(path.join(repo, '.git')))
  await git.git(repo, ['branch', 'qa/shared-ref'])
  await changed(watch, linked, status.revision)
  const result = await watch.read(linked, null)
  assert.ok(result.snapshot.branches.some((branch) => branch.name === 'qa/shared-ref'))
  assert.equal(result.snapshot.branch, 'qa/linked')
})

test('unavailable OS watchers fall back to readonly snapshots and reject malformed requests', async (t) => {
  const { git, repo } = await setup(t)
  const watch = new RepositoryWatch(git, {
    watchDirectory: () => {
      throw Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' })
    },
  })
  t.after(() => watch.close())
  const status = await watch.status(repo)
  assert.equal(status.fallback, true)
  assert.equal(status.watched, 0)
  assert.ok((await watch.read(repo, null)).snapshot)
  await assert.rejects(watch.status('relative'), /无效的仓库/)
  await assert.rejects(watch.read(repo, { file: { path: 'file', source: 'shell' } }), /无效的差异/)
  watch.close()
  assert.equal(await watch.status(repo), null)
  assert.equal(watch.entries.size, 0)
})

test('external commits inside an initialized submodule update the parent revision', async (t) => {
  const { git, repo, directory, watch } = await setup(t)
  const source = path.join(directory, 'module-source')
  await fs.mkdir(source)
  await git.git(source, ['init', '-b', 'qa/module'])
  for (const [key, value] of [
    ['user.name', 'Watch QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(source, ['config', key, value])
  await fs.writeFile(path.join(source, 'file.txt'), 'base\n')
  await git.git(source, ['add', '.'])
  await git.git(source, ['commit', '-m', 'module baseline'])
  await git.git(repo, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    source,
    'deps/child',
  ])
  await git.git(repo, ['commit', '-am', 'add module'])
  const sub = path.join(repo, 'deps', 'child')
  for (const [key, value] of [
    ['user.name', 'Watch QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(sub, ['config', key, value])
  await watch.status(repo)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const before = await watch.status(repo)
  await fs.writeFile(path.join(sub, 'file.txt'), 'module update\n')
  await git.git(sub, ['add', '.'])
  await git.git(sub, ['commit', '-m', 'module changed externally'])
  await changed(watch, repo, before.revision)
  assert.ok(
    (await watch.read(repo, null)).snapshot.unstaged.some((file) => file.path === 'deps/child'),
  )
})
