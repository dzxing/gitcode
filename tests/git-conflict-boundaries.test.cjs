const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, { attrs = '', bom = false } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-conflict-boundary-中文-')),
    git = new GitService(),
    file = 'nested/file.txt'
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5 })
  })
  const cmd = (...args) => git.git(repo, args)
  await cmd('init', '-b', 'qa/local')
  for (const [k, v] of [
    ['user.name', 'Conflict QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.git/no-hooks'],
    ['filter.lfs.process', ''],
    ['filter.lfs.required', 'false'],
    ['filter.lfs.clean', 'cat'],
    ['filter.lfs.smudge', 'cat'],
  ])
    await cmd('config', k, v)
  await fs.mkdir(path.join(repo, 'nested'))
  if (attrs) await fs.writeFile(path.join(repo, 'nested', '.gitattributes'), attrs)
  const write = (side) => fs.writeFile(path.join(repo, file), (bom ? '\ufeff' : '') + side + '\n')
  const commit = async (message) => {
    await cmd('add', '.')
    await cmd('commit', '-m', message)
    return git.head(repo)
  }
  await write('base')
  await commit('baseline')
  await cmd('switch', '-c', 'qa/incoming')
  await write('incoming')
  const incoming = await commit('incoming')
  await cmd('switch', 'qa/local')
  await write('local')
  await commit('local')
  await git.git(repo, ['merge', '--no-commit', incoming], { allowedCodes: [0, 1] })
  const read = () => git.merge.read(repo, file)
  const resolve = async (value, content, choice = 'manual') =>
    git.action(repo, {
      action: 'merge-resolve',
      expectedHead: await git.head(repo),
      expectedBranch: await git.currentBranch(repo),
      mergeSignature: value.state.signature,
      token: value.file.token,
      file,
      choice,
      content,
    })
  return { repo, git, file, cmd, read, resolve }
}
test('custom three-character markers cannot be saved as a resolved file', async (t) => {
  const f = await fixture(t, { attrs: '*.txt conflict-marker-size=3\n' }),
    read = await f.read()
  assert.match(read.file.working, /^<<< /m)
  const index = await f.git.indexFingerprint(f.repo)
  const result = await f.resolve(read, read.file.working)
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /冲突标记/)
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  assert.equal((await f.git.merge.state(f.repo)).files.length, 1)
})
test('a valid Markdown underline is not mistaken for an unresolved conflict', async (t) => {
  const f = await fixture(t),
    read = await f.read(),
    content = 'Heading\n=======\nresolved\n'
  const result = await f.resolve(read, content)
  assert.equal(result.outcome, 'succeeded', result.error)
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), content)
})
test('three-way blob versions retain their UTF-8 BOM', async (t) => {
  const f = await fixture(t, { bom: true }),
    read = await f.read()
  assert.equal(read.file.base.text, '\ufeffbase\n')
  assert.equal(read.file.ours.text, '\ufefflocal\n')
  assert.equal(read.file.theirs.text, '\ufeffincoming\n')
})
test('nested filter attributes prevent manual pointer editing but retain whole-version recovery', async (t) => {
  const f = await fixture(t, { attrs: '*.txt filter=lfs merge=text\n' }),
    read = await f.read()
  assert.equal(read.file.editable, false)
  const index = await f.git.indexFingerprint(f.repo)
  const result = await f.resolve(read, 'edited pointer\n')
  assert.equal(result.outcome, 'failed')
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  const next = await f.read()
  assert.equal((await f.resolve(next, '', 'ours')).outcome, 'succeeded')
})
test('changing global attributes invalidates an existing conflict read before writing', async (t) => {
  const f = await fixture(t),
    read = await f.read()
  const original = await fs.readFile(path.join(f.repo, f.file))
  await fs.writeFile(
    path.join(f.repo, '.git', 'info', 'attributes'),
    'nested/file.txt filter=lfs\n',
  )
  const result = await f.resolve(read, 'must not write\n')
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /状态已变化|失效/)
  assert.deepEqual(await fs.readFile(path.join(f.repo, f.file)), original)
})

test('re-reading an existing small marker block remains safe after marker attributes change', async (t) => {
  const f = await fixture(t, { attrs: '*.txt conflict-marker-size=3\n' })
  await fs.writeFile(
    path.join(f.repo, '.git', 'info', 'attributes'),
    'nested/file.txt conflict-marker-size=32\n',
  )
  const read = await f.read()
  assert.equal(read.file.markerSize, 3)
  const result = await f.resolve(read, read.file.working)
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /冲突标记/)
})
