const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { GitService } = require('../electron/git.cjs')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-fetch-settings-'))
  const source = path.join(root, 'source'),
    repo = path.join(root, '中文 clone')
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(source)
  await git.git(source, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Settings QA'],
    ['user.email', 'settings@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(source, ['config', key, value])
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(source, 'a.txt'), `commit ${i}\n`)
    await git.git(source, ['add', 'a.txt'])
    await git.git(source, ['commit', '-m', `commit ${i}`])
  }
  await git.git(source, ['branch', 'develop'])
  await git.git(root, [
    'clone',
    '--depth=1',
    '--single-branch',
    '--branch=main',
    '--',
    pathToFileURL(source).href,
    repo,
  ])
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
  })
  const read = () => git.fetchSettings.read(repo)
  const action = async (request) =>
    git.action(repo, {
      ...(await context()),
      signature: (await read()).signature,
      remote: 'origin',
      ...request,
    })
  return { root, source, repo, git, context, read, action }
}

test('single-branch shallow clone reports its actual fetch scope without network access', async (t) => {
  const { read } = await fixture(t)
  const settings = await read()
  assert.equal(settings.shallow, true)
  assert.equal(settings.remotes[0].mode, 'selected')
  assert.deepEqual(settings.remotes[0].branches, ['main'])
  assert.equal(settings.remotes[0].editable, true)
  assert.match(settings.signature, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(settings).includes('file://'), false)
})

test('boolean skip-fetch settings are reported using Git semantics, including valueless true', async (t) => {
  const { git, repo, read } = await fixture(t)
  await fs.appendFile(path.join(repo, '.git', 'config'), '\n[remote "origin"]\n skipFetchAll\n')
  assert.equal((await read()).remotes[0].skipped, true)
  await git.git(repo, ['config', 'remote.origin.skipFetchAll', 'false'])
  assert.equal((await read()).remotes[0].skipped, false)
})

test('expanding fetch scope preserves shallow history and local changes; explicit fetch discovers other branches', async (t) => {
  const { git, repo, action, read, context } = await fixture(t)
  await fs.writeFile(path.join(repo, 'a.txt'), 'staged\n')
  await git.git(repo, ['add', 'a.txt'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'working\n')
  await git.git(repo, ['tag', 'local-only'])
  const before = await context(),
    index = await git.indexFingerprint(repo)
  const result = await action({ action: 'set-fetch-scope', mode: 'all' })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await read()).shallow, true)
  assert.equal((await read()).remotes[0].mode, 'all')
  assert.equal((await git.git(repo, ['rev-list', '--count', 'HEAD'])).trim(), '1')
  assert.ok(!result.snapshot.branches.some((branch) => branch.name === 'origin/develop'))
  const plan = await git.syncPlan(repo, 'fetch', await context())
  const fetched = await git.action(repo, { action: 'fetch', planId: plan.id })
  assert.equal(fetched.outcome, 'succeeded', fetched.error)
  assert.ok(fetched.snapshot.branches.some((branch) => branch.name === 'origin/develop'))
  assert.deepEqual(await context(), before)
  assert.equal(await git.indexFingerprint(repo), index)
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'working\n')
  assert.equal((await git.git(repo, ['tag', '--list'])).trim(), 'local-only')
})

test('selected branches save atomically without deleting existing remote caches or unrelated configuration', async (t) => {
  const { git, repo, action, read } = await fixture(t)
  await git.git(repo, ['config', 'user.email', 'keep@example.test'])
  const result = await action({
    action: 'set-fetch-scope',
    mode: 'selected',
    branches: ['main', 'develop', 'main'],
  })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.deepEqual((await read()).remotes[0].branches, ['main', 'develop'])
  assert.equal((await git.git(repo, ['config', 'user.email'])).trim(), 'keep@example.test')
  assert.ok(result.snapshot.branches.some((branch) => branch.name === 'origin/main'))
  assert.ok(!result.snapshot.branches.some((branch) => branch.name === 'origin/develop'))
  assert.equal((await read()).shallow, true)
})

test('stale configuration and invalid branch inputs never overwrite repository config', async (t) => {
  const { git, repo, read, action, context } = await fixture(t)
  const signature = (await read()).signature
  await git.git(repo, ['config', 'core.abbrev', '12'])
  const file = path.join(repo, '.git', 'config'),
    original = await fs.readFile(file)
  const stale = await git.action(repo, {
    ...(await context()),
    signature,
    remote: 'origin',
    action: 'set-fetch-scope',
    mode: 'all',
  })
  assert.equal(stale.outcome, 'failed')
  assert.match(stale.error, /已变化/)
  for (const branches of [
    [],
    ['main', '--delete'],
    ['main:refs/heads/other'],
    ['bad name'],
    ['a*'],
  ]) {
    assert.equal(
      (await action({ action: 'set-fetch-scope', mode: 'selected', branches })).outcome,
      'failed',
    )
    assert.deepEqual(await fs.readFile(file), original)
  }
  const invalidRemote = await action({ action: 'set-fetch-scope', mode: 'all', remote: 'missing' })
  assert.equal(invalidRemote.outcome, 'failed')
  assert.deepEqual(await fs.readFile(file), original)
})

test('existing Git config lock is respected and never deleted', async (t) => {
  const { repo, action } = await fixture(t)
  const file = path.join(repo, '.git', 'config'),
    lock = file + '.lock'
  const original = await fs.readFile(file)
  await fs.writeFile(lock, 'another tool')
  const result = await action({ action: 'set-fetch-scope', mode: 'all' })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /占用/)
  assert.deepEqual(await fs.readFile(file), original)
  assert.equal(await fs.readFile(lock, 'utf8'), 'another tool')
})

test('custom and inherited fetch mappings are displayed but cannot be overwritten', async (t) => {
  const { git, repo, action, read, root } = await fixture(t)
  await git.git(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'])
  assert.equal((await read()).remotes[0].editable, false)
  assert.equal((await action({ action: 'set-fetch-scope', mode: 'all' })).outcome, 'failed')
  await git.git(repo, ['config', '--unset-all', 'remote.origin.fetch'])
  const included = path.join(root, 'included-config')
  await fs.writeFile(
    included,
    '[remote "origin"]\nfetch = +refs/heads/main:refs/remotes/origin/main\n',
  )
  await git.git(repo, ['config', 'include.path', included])
  const original = await fs.readFile(path.join(repo, '.git', 'config'))
  assert.equal((await read()).remotes[0].editable, false)
  assert.equal((await action({ action: 'set-fetch-scope', mode: 'all' })).outcome, 'failed')
  assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'config')), original)
})

test('unshallow downloads missing history while preserving the single-branch fetch strategy', async (t) => {
  const { git, repo, action, read, context } = await fixture(t)
  const before = await context(),
    mappings = (await read()).remotes[0].mappings
  const result = await action({ action: 'unshallow' })
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal((await read()).shallow, false)
  assert.deepEqual((await read()).remotes[0].mappings, mappings)
  assert.equal((await git.git(repo, ['rev-list', '--count', 'HEAD'])).trim(), '3')
  assert.ok(!result.snapshot.branches.some((branch) => branch.name === 'origin/develop'))
  assert.deepEqual(await context(), before)
  assert.equal((await action({ action: 'unshallow' })).outcome, 'failed')
})

test('cancelled scope changes and stale branch context preserve configuration', async (t) => {
  const { git, repo, read, context } = await fixture(t)
  const file = path.join(repo, '.git', 'config'),
    original = await fs.readFile(file)
  const request = {
    ...(await context()),
    signature: (await read()).signature,
    remote: 'origin',
    action: 'set-fetch-scope',
    mode: 'all',
  }
  const controller = new AbortController()
  controller.abort()
  assert.equal((await git.action(repo, request, controller.signal)).outcome, 'cancelled')
  await git.git(repo, ['switch', '-c', 'other'])
  assert.equal((await git.action(repo, request)).outcome, 'failed')
  assert.deepEqual(await fs.readFile(file), original)
})

test('explicit safe scope changes retain trust, but later external fetch changes still require consent', async (t) => {
  const { git, repo, action } = await fixture(t)
  git.runtimeOptions.enforceRepositoryTrust = true
  const challenge = await git.trust.inspect(repo)
  await git.trust.approve(repo, challenge.token)
  const result = await action({ action: 'set-fetch-scope', mode: 'all' })
  assert.equal(result.outcome, 'succeeded', result.error || result.refreshError)
  assert.ok(result.snapshot)
  assert.equal((await git.trust.inspect(repo)).trusted, true)
  await git.git(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'])
  assert.equal((await git.trust.inspect(repo)).trusted, false)
})

test('trust transition rejects unrelated concurrent execution changes and unconfirmed mapping values', async (t) => {
  for (const tamper of ['execution', 'mapping']) {
    const { git, repo } = await fixture(t)
    git.runtimeOptions.enforceRepositoryTrust = true
    const challenge = await git.trust.inspect(repo)
    await git.trust.approve(repo, challenge.token)
    const mappings = ['+refs/heads/*:refs/remotes/origin/*']
    const confirm = await git.trust.approvedFetchChange(repo, 'origin', mappings)
    await git.git(repo, [
      'config',
      'remote.origin.fetch',
      tamper === 'mapping' ? '+refs/heads/develop:refs/remotes/origin/develop' : mappings[0],
    ])
    if (tamper === 'execution') {
      const file = path.join(repo, '.git', 'config')
      await fs.appendFile(file, '\n[core]\n hooksPath = /tmp/unapproved-hooks\n')
    }
    await assert.rejects(confirm(), /其他仓库配置也发生变化/)
    assert.equal((await git.trust.inspect(repo)).trusted, false)
  }
})
