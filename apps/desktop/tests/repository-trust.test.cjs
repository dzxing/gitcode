'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService, execute } = require('../electron/git.cjs')
const { TRUST_READ } = require('../electron/repository-trust.cjs')
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-trust-'))
  const repo = path.join(root, 'app')
  await fs.mkdir(repo)
  const setupGit = new GitService({ dataDirectory: path.join(root, 'log') })
  await setupGit.git(repo, ['init', '-b', 'qa/base'])
  for (const [key, value] of [
    ['user.name', 'QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.git/no-hooks'],
  ])
    await setupGit.git(repo, ['config', key, value])
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n')
  await setupGit.git(repo, ['add', '.'])
  await setupGit.git(repo, ['commit', '-m', 'baseline'])
  const git = new GitService({
    enforceRepositoryTrust: true,
    dataDirectory: path.join(root, 'log'),
  })
  t.after(async () => {
    await git.shutdown()
    await setupGit.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const approve = async (p = repo) => {
    const info = await git.trust.inspect(p)
    await git.trust.approve(p, info.token)
    return info
  }
  return { root, repo, git, setupGit, approve }
}
async function filter(f, include = false) {
  const marker = path.join(f.repo, '.git', 'ran')
  const helper = path.join(f.repo, '.git', 'filter.cjs')
  await fs.writeFile(
    helper,
    "const fs=require('node:fs');fs.writeFileSync(__dirname+'/ran','yes');process.stdin.pipe(process.stdout)",
  )
  const quote = (value) => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"
  const command = quote(process.execPath) + ' ' + quote(helper)
  await fs.writeFile(path.join(f.repo, '.git', 'info', 'attributes'), 'file.txt filter=qa\n')
  const file = path.join(f.repo, '.git', 'included')
  if (include) {
    await f.setupGit.git(f.repo, ['config', '--file', file, 'filter.qa.clean', command])
    await f.setupGit.git(f.repo, ['config', 'include.path', file])
  } else await f.setupGit.git(f.repo, ['config', 'filter.qa.clean', command])
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'BASE\n')
  return { marker, file }
}
test('first open and background reads cannot run local filters before consent', async (t) => {
  const f = await setup(t),
    { marker } = await filter(f)
  const info = await f.git.trust.inspect(f.repo)
  assert.equal(info.trusted, false)
  await assert.rejects(f.git.snapshot(f.repo), /信任/)
  await assert.rejects(f.git.repositoryWatch.read(f.repo, null), /信任/)
  await assert.rejects(f.git.git(f.repo, ['status', '--porcelain']), /信任/)
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  await f.git.trust.approve(f.repo, info.token)
  assert.equal((await f.git.snapshot(f.repo)).unstaged.length, 1)
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes')
})
test('approved repositories work with Git ownership checks without changing global safe directories', async (t) => {
  const f = await setup(t)
  const globalBefore = await f.setupGit.git(
    f.repo,
    ['config', '--global', '--null', '--get-all', 'safe.directory'],
    { allowedCodes: [0, 1] },
  )
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous
  })
  // Reset inherited safe.directory entries for this probe: CI images may trust '*'.
  // The command still exercises Git's real ownership check without changing user config.
  await assert.rejects(
    f.setupGit.git(f.repo, ['-c', 'safe.directory=', 'status', '--porcelain']),
    /dubious ownership/,
  )
  const consent = await f.git.trust.inspect(f.repo)
  assert.equal(consent.trusted, false)
  await assert.rejects(f.git.snapshot(f.repo), /信任/)
  await f.git.trust.approve(f.repo, consent.token)
  assert.equal((await f.git.snapshot(f.repo)).branch, 'qa/base')
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'approved update\n')
  await f.git.git(f.repo, ['add', 'file.txt'])
  await f.git.git(f.repo, ['commit', '-m', 'approved commit'])
  const restarted = new GitService({
    enforceRepositoryTrust: true,
    dataDirectory: path.join(f.root, 'log'),
  })
  t.after(() => restarted.shutdown())
  assert.equal((await restarted.trust.inspect(f.repo)).trusted, true)
  assert.equal((await restarted.snapshot(f.repo)).branch, 'qa/base')
  const globalAfter = await restarted.git(
    f.repo,
    ['config', '--global', '--null', '--get-all', 'safe.directory'],
    { allowedCodes: [0, 1] },
  )
  assert.equal(globalAfter, globalBefore)
  await restarted.git(f.repo, ['config', 'core.editor', 'false'])
  await assert.rejects(restarted.snapshot(f.repo), /配置已变化/)
  assert.equal((await restarted.trust.inspect(f.repo)).trusted, false)
})

test('pre-existing trust remains valid with ownership mismatch, and the exception excludes other repositories', async (t) => {
  const f = await setup(t),
    second = path.join(f.root, 'app-other')
  await fs.mkdir(second)
  await f.setupGit.git(second, ['init', '-b', 'qa/base'])
  // Create a saved grant using the previous release's unscoped config read.
  const command = f.git.git.bind(f.git)
  f.git.git = (repo, args, options) =>
    options?.[TRUST_READ]
      ? f.setupGit.git(repo, args, { signal: options.signal })
      : command(repo, args, options)
  await f.approve()
  f.git.git = command
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous
  })
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, true)
  await fs.mkdir(path.join(f.repo, 'nested'))
  assert.equal(await f.git.git(path.join(f.repo, 'nested'), ['status', '--porcelain']), '')
  await assert.rejects(f.git.snapshot(second), /信任/)
  const safe = process.platform === 'win32' ? f.repo.replaceAll('\\', '/') : f.repo
  const probe = await execute(f.setupGit.gitPath, [
    '-c',
    'safe.directory=',
    '-c',
    `safe.directory=${safe}`,
    '-C',
    second,
    'status',
    '--porcelain',
  ])
  assert.notEqual(probe.code, 0)
  assert.match(probe.stderr, /dubious ownership/)
})

test(
  'literal wildcard directory names cannot expand ownership consent',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await setup(t),
      wildcard = path.join(f.root, '*')
    await fs.rename(f.repo, wildcard)
    const info = await f.git.trust.inspect(wildcard)
    await assert.rejects(f.git.trust.approve(wildcard, info.token), /精确的安全例外/)
    assert.equal((await f.git.trust.inspect(wildcard)).trusted, false)
  },
)

test('included filter stays blocked; trusted conversion remains functional', async (t) => {
  const f = await setup(t),
    { marker, file } = await filter(f, true)
  await assert.rejects(f.git.status(f.repo), /信任/)
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  await f.approve()
  await f.git.status(f.repo)
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes')
  await fs.rm(marker)
  await f.setupGit.git(f.repo, ['config', '--file', file, 'filter.qa.clean', 'cat'])
  await assert.rejects(f.git.status(f.repo), /配置已变化/)
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, false)
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
})
test('trust challenges cannot approve another repository or changed configuration', async (t) => {
  const f = await setup(t),
    info = await f.git.trust.inspect(f.repo)
  await f.setupGit.git(f.repo, ['config', 'core.editor', 'false'])
  await assert.rejects(f.git.trust.approve(f.repo, info.token), /配置已变化/)
  await assert.rejects(f.git.status(f.repo), /信任/)
  const second = path.join(f.root, 'app-other')
  await fs.mkdir(second)
  await f.setupGit.git(second, ['init', '-b', 'qa/base'])
  const fresh = await f.git.trust.inspect(f.repo)
  await assert.rejects(f.git.trust.approve(second, fresh.token), /位置或配置/)
})
test('exact repository identity supports nested paths, and excludes siblings and other worktrees', async (t) => {
  const f = await setup(t)
  await f.approve()
  const nested = path.join(f.repo, 'nested')
  await fs.mkdir(nested)
  assert.equal((await f.git.trust.inspect(nested)).trusted, true)
  const sibling = path.join(f.root, 'app2')
  await fs.mkdir(sibling)
  await f.setupGit.git(sibling, ['init', '-b', 'qa/base'])
  assert.equal((await f.git.trust.inspect(sibling)).trusted, false)
  const worktree = path.join(f.root, 'worktree')
  await f.setupGit.git(f.repo, ['worktree', 'add', '-b', 'qa/other', worktree])
  assert.equal((await f.git.trust.inspect(worktree)).trusted, false)
  await f.approve(worktree)
  assert.equal((await f.git.trust.inspect(worktree)).trusted, true)
})
test('ordinary branch metadata does not interrupt trust, which is scoped to the application profile', async (t) => {
  const f = await setup(t)
  await f.approve()
  await f.git.git(f.repo, ['config', 'branch.qa/base.remote', 'origin'])
  await f.git.git(f.repo, ['config', 'gitflow.prefix.feature', 'feature/'])
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, true)
  const fresh = new GitService({
    enforceRepositoryTrust: true,
    dataDirectory: path.join(f.root, 'fresh'),
  })
  try {
    await assert.rejects(fresh.status(f.repo), /信任/)
  } finally {
    await fresh.shutdown()
  }
})
test('trust survives service restart and is shared with already-open browser sessions', async (t) => {
  const f = await setup(t)
  const options = { enforceRepositoryTrust: true, dataDirectory: path.join(f.root, 'log') }
  const alreadyOpen = new GitService(options)
  const nested = path.join(f.repo, 'nested')
  await fs.mkdir(nested)
  assert.equal((await alreadyOpen.trust.inspect(f.repo)).trusted, false)
  await f.approve()
  await f.git.git(f.repo, ['config', 'branch.qa/base.remote', 'origin'])
  await f.git.git(f.repo, ['config', 'gitflow.prefix.feature', 'feature/'])
  assert.equal((await alreadyOpen.trust.inspect(nested)).trusted, true)
  await f.git.shutdown()
  const restarted = new GitService(options)
  try {
    assert.equal((await restarted.trust.inspect(f.repo)).trusted, true)
    assert.equal((await restarted.snapshot(f.repo)).path, f.repo)
    const record = JSON.parse(
      await fs.readFile(path.join(options.dataDirectory, 'repository-trust.json'), 'utf8'),
    )
    assert.equal(record.version, 1)
    assert.equal(record.grants.length, 1)
    assert.match(record.grants[0][0], /^[a-f0-9]{64}$/)
    assert.ok(
      !JSON.stringify(record).includes(f.repo),
      'only fingerprints, not paths or config secrets, are stored',
    )
  } finally {
    await restarted.shutdown()
    await alreadyOpen.shutdown()
  }
})
test('changed effective config invalidates persistent trust across restarts without running filters', async (t) => {
  const f = await setup(t)
  const { marker, file } = await filter(f, true)
  await f.approve()
  await f.setupGit.git(f.repo, ['config', '--file', file, 'filter.qa.clean', 'cat'])
  const options = { enforceRepositoryTrust: true, dataDirectory: path.join(f.root, 'log') }
  const restarted = new GitService(options)
  try {
    assert.equal((await restarted.trust.inspect(f.repo)).trusted, false)
    await assert.rejects(restarted.status(f.repo), /信任/)
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
    assert.equal((await f.git.trust.inspect(f.repo)).trusted, false)
    const next = await restarted.trust.inspect(f.repo)
    await restarted.trust.approve(f.repo, next.token)
    assert.equal((await f.git.trust.inspect(f.repo)).trusted, true)
  } finally {
    await restarted.shutdown()
  }
})
test('concurrent repository approvals preserve both records; replaced metadata is not restored as trusted', async (t) => {
  const f = await setup(t)
  const second = path.join(f.root, 'second')
  await fs.mkdir(second)
  await f.setupGit.git(second, ['init', '-b', 'qa/base'])
  const options = { enforceRepositoryTrust: true, dataDirectory: path.join(f.root, 'log') }
  const other = new GitService(options)
  try {
    const [a, b] = await Promise.all([f.git.trust.inspect(f.repo), other.trust.inspect(second)])
    await Promise.all([f.git.trust.approve(f.repo, a.token), other.trust.approve(second, b.token)])
    assert.equal((await other.trust.inspect(f.repo)).trusted, true)
    assert.equal((await f.git.trust.inspect(second)).trusted, true)
    await fs.rename(path.join(f.repo, '.git'), path.join(f.repo, '.git-old'))
    await f.setupGit.git(f.repo, ['init', '-b', 'qa/base'])
    assert.equal((await other.trust.inspect(f.repo)).trusted, false)
  } finally {
    await other.shutdown()
  }
})
test('corrupt records never grant trust, and failed persistence never reports a successful approval', async (t) => {
  const f = await setup(t)
  const file = path.join(f.root, 'log', 'repository-trust.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{broken')
  const info = await f.git.trust.inspect(f.repo)
  assert.equal(info.trusted, false)
  await fs.rm(file)
  await fs.mkdir(file)
  await assert.rejects(f.git.trust.approve(f.repo, info.token), /无法保存仓库信任记录/)
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, false)
  await fs.rm(file, { recursive: true })
  await f.approve()
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, true)
})
test('repository replacement invalidates consent and tokens are single use', async (t) => {
  const f = await setup(t),
    info = await f.approve()
  await assert.rejects(f.git.trust.approve(f.repo, info.token), /位置或配置/)
  await fs.rename(path.join(f.repo, '.git'), path.join(f.repo, '.git-old'))
  await f.setupGit.git(f.repo, ['init', '-b', 'qa/base'])
  assert.equal((await f.git.trust.inspect(f.repo)).trusted, false)
  await assert.rejects(f.git.status(f.repo), /信任/)
})

test('creating a repository requires consent before the first snapshot', async (t) => {
  const f = await setup(t),
    target = path.join(f.root, 'created')
  const result = await f.git.create({ kind: 'init', path: target, url: '' })
  assert.equal(result.requiresTrust, true)
  assert.equal(result.snapshot, null)
  await assert.rejects(f.git.snapshot(target), /信任/)
  await f.approve(target)
  assert.equal((await f.git.snapshot(target)).path, target)
})
test('branch merge options are executable configuration, not benign tracking metadata', async (t) => {
  const f = await setup(t)
  await f.approve()
  await f.setupGit.git(f.repo, ['config', 'branch.qa/base.mergeOptions', '--no-commit'])
  await assert.rejects(f.git.status(f.repo), /配置已变化/)
})

test('untrusted gitdir and commondir cannot trigger a UNC metadata probe', async (t) => {
  const f = await setup(t)
  const fake = path.join(f.root, 'untrusted')
  await fs.mkdir(fake)
  await fs.writeFile(path.join(fake, '.git'), 'gitdir: \\\\gitcode-no-network.invalid\\share\n')
  await assert.rejects(f.git.trust.inspect(fake), /网络路径/)
  await fs.writeFile(path.join(f.repo, '.git', 'commondir'), '//gitcode-no-network.invalid/share\n')
  await assert.rejects(f.git.trust.inspect(f.repo), /网络路径/)
})

test('GIT_CONFIG cannot hide executable repository settings from the trust check', async (t) => {
  const f = await setup(t),
    { marker } = await filter(f)
  const original = process.env.GIT_CONFIG
  const decoy = path.join(f.root, 'decoy-config')
  await fs.writeFile(decoy, '')
  process.env.GIT_CONFIG = decoy
  try {
    await f.approve()
    await f.setupGit.git(f.repo, ['config', 'filter.qa.clean', 'cat'])
    await assert.rejects(f.git.status(f.repo), /配置已变化/)
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  } finally {
    if (original === undefined) delete process.env.GIT_CONFIG
    else process.env.GIT_CONFIG = original
  }
})
