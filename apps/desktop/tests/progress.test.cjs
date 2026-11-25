const test = require('node:test')
const assert = require('node:assert/strict')
const { progressParser } = require('../electron/progress.cjs')
const { GitService } = require('../electron/git.cjs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

test('Git progress handles split chunks and independent phase percentages without leaking output', () => {
  const events = []
  const read = progressParser((value) => events.push(value))
  read(Buffer.from('secret credential URL\nReceiving obj'))
  read(Buffer.from('ects:  48% (48/100)\rReceiving objects: 100% (100/100)\n'))
  read(Buffer.from('Resolving deltas:  20% (2/10)\r'))
  assert.deepEqual(events, [
    { phase: '接收对象', percent: 48 },
    { phase: '接收对象', percent: 100 },
    { phase: '解析增量', percent: 20 },
  ])
  assert.ok(!JSON.stringify(events).includes('secret'))
})

test('unknown output and invalid percentages remain indeterminate', () => {
  const events = []
  const read = progressParser((value) => events.push(value))
  read(Buffer.from('Updating files: 101%\nrandom output 55%\n'))
  assert.deepEqual(events, [])
  read(Buffer.from('remote: Compressing objects: 30%\n'))
  assert.deepEqual(events, [{ phase: '压缩对象', percent: 30 }])
})

test('activity is readable while the serialized Git job is blocked and settles only when it ends', async () => {
  const git = new GitService()
  let release
  const wait = new Promise((resolve) => {
    release = resolve
  })
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const job = git.job(async () => {
    git.startActivity('clone', '/temporary-target')
    started()
    await wait
  })
  await ready
  assert.equal(git.activity.operation, 'clone')
  assert.equal(git.activity.state, 'running')
  const id = git.activity.id
  release()
  await job
  assert.equal(git.activity.id, id)
  assert.equal(git.activity.state, 'finished')
  await git.shutdown()
})

test('a real non-local clone reports Git phases and finishes only after the new snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-clone-progress-'))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'source')
  const target = path.join(root, 'clone')
  await fs.mkdir(source)
  await git.git(source, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Progress QA'],
    ['user.email', 'progress@test.local'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(source, ['config', key, value])
  for (let index = 0; index < 8; index++)
    await fs.writeFile(path.join(source, `file-${index}.bin`), randomBytes(65536))
  await git.git(source, ['add', '.'])
  await git.git(source, ['commit', '-m', 'clone fixture'])
  let activity
  const events = []
  Object.defineProperty(git, 'activity', {
    get: () => activity,
    set: (value) => {
      activity = value
      if (value) events.push({ ...value })
    },
  })
  const result = await git.job((signal) =>
    git.create({ kind: 'clone', path: target, url: source }, signal),
  )
  assert.equal(result.snapshot.path, await fs.realpath(target))
  assert.equal(result.snapshot.branch, 'main')
  assert.ok(
    events.some((event) => typeof event.percent === 'number'),
    'Git emitted a real phase percentage',
  )
  assert.ok(events.some((event) => event.phase === '读取新仓库状态' && event.percent === null))
  assert.equal(activity.state, 'finished')
  assert.ok(events.every((event) => event.operation === 'clone'))
})
