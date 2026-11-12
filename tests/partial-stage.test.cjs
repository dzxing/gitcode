const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, base = 'one\ntwo\nthree\n', file = '中文 file.txt', unborn = false) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-partial-中文-')),
    git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
  })
  await git.git(repo, ['init', '-b', 'qa/partial'])
  for (const [k, v] of [
    ['user.name', 'Partial QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', k, v])
  if (!unborn) {
    await fs.writeFile(path.join(repo, file), base)
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'base'])
  }
  const expected = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: await git.currentBranch(repo),
  })
  const read = async (source = 'unstaged', name = file) =>
    git.partialStage.read(repo, { ...(await expected()), file: name, source })
  const act = async (plan, lines, signal) =>
    git.action(
      repo,
      { ...(await expected()), action: 'partial-stage', planId: plan.id, lines },
      signal,
    )
  const blob = async (name = file) => {
    const raw = await git.git(repo, ['cat-file', '--batch'], { input: `:${name}\n` })
    return raw.slice(raw.indexOf('\n') + 1, -1)
  }
  const line = (plan, text) => {
    const id = plan.diff.split('\n').findIndex((l) => l === text)
    assert.ok(id >= 0, plan.diff)
    return id
  }
  return {
    repo,
    git,
    file,
    expected,
    read,
    act,
    blob,
    line,
    write: (text) => fs.writeFile(path.join(repo, file), text),
  }
}
function success(value) {
  assert.equal(value.outcome, 'succeeded', JSON.stringify(value))
}
test('selected addition and deletion only change the requested index lines and preserve the worktree', async (t) => {
  const f = await fixture(t)
  await f.write('one\nTWO\nthree\nextra\n')
  let p = await f.read()
  success(await f.act(p, [f.line(p, '+TWO')]))
  assert.equal(await f.blob(), 'one\ntwo\nTWO\nthree\n')
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'one\nTWO\nthree\nextra\n')
  p = await f.read()
  success(await f.act(p, [f.line(p, '-two')]))
  assert.equal(await f.blob(), 'one\nTWO\nthree\n')
})
test('hunks can be staged independently and partial unstage keeps other staged and unstaged edits', async (t) => {
  const base = Array.from({ length: 24 }, (_, i) => `line ${i}\n`),
    f = await fixture(t, base.join(''))
  const work = [...base]
  work[1] = 'first change\n'
  work[20] = 'second change\n'
  await f.write(work.join(''))
  let p = await f.read()
  assert.equal(p.hunks.length, 2)
  success(await f.act(p, p.hunks[1].lines))
  const wanted = [...base]
  wanted[20] = 'second change\n'
  assert.equal(await f.blob(), wanted.join(''))
  p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  p = await f.read('staged')
  success(await f.act(p, [f.line(p, '+second change')]))
  const partial = [...work]
  partial.splice(20, 1)
  assert.equal(await f.blob(), partial.join(''))
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), work.join(''))
})
test('new files in unborn repositories can be partially staged and unstaged without creating HEAD', async (t) => {
  const f = await fixture(t, '', 'new.txt', true)
  await f.write('alpha\nbeta\ngamma\n')
  let p = await f.read()
  success(await f.act(p, [f.line(p, '+alpha'), f.line(p, '+gamma')]))
  assert.equal(await f.blob(), 'alpha\ngamma\n')
  assert.equal(await f.git.head(f.repo), '')
  p = await f.read('staged')
  success(await f.act(p, [f.line(p, '+alpha')]))
  assert.equal(await f.blob(), 'gamma\n')
  p = await f.read('staged')
  success(
    await f.act(
      p,
      p.hunks.flatMap((h) => h.lines),
    ),
  )
  assert.equal((await f.git.git(f.repo, ['ls-files', '--stage', '--', f.file])).trim(), '')
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'alpha\nbeta\ngamma\n')
})
test('deleted files support partial removal and staged deletion supports partial restoration', async (t) => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.repo, f.file))
  let p = await f.read()
  success(await f.act(p, [f.line(p, '-two')]))
  assert.equal(await f.blob(), 'one\nthree\n')
  p = await f.read()
  success(
    await f.act(
      p,
      p.hunks.flatMap((h) => h.lines),
    ),
  )
  assert.equal((await f.git.git(f.repo, ['ls-files', '--', f.file])).trim(), '')
  p = await f.read('staged')
  success(await f.act(p, [f.line(p, '-two')]))
  assert.equal(await f.blob(), 'two\n')
  await assert.rejects(fs.stat(path.join(f.repo, f.file)), /ENOENT/)
})
test('UTF-8 BOM and literal CRLF bytes survive line selection without modifying the working file', async (t) => {
  const f = await fixture(t, '\ufeffone\r\ntwo\r\nthree\r\n')
  await f.write('\ufeffone\r\nTWO\r\nthree\r\n')
  const p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  assert.equal(await f.blob(), '\ufeffone\r\nTWO\r\nthree\r\n')
  assert.equal(
    (await fs.readFile(path.join(f.repo, f.file))).subarray(0, 3).toString('hex'),
    'efbbbf',
  )
})
test('core.autocrlf normalizes only index content and keeps physical CRLF working bytes', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['config', 'core.autocrlf', 'true'])
  await f.write('one\r\nTWO\r\nthree\r\n')
  const p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  assert.equal(await f.blob(), 'one\nTWO\nthree\n')
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'one\r\nTWO\r\nthree\r\n')
})
test('missing EOF newline requires a whole hunk and preserves the exact EOF when staged or unstaged', async (t) => {
  const f = await fixture(t, 'old')
  await f.write('new')
  let p = await f.read()
  assert.equal(p.hunks[0].hunkOnly, true)
  assert.equal((await f.act(p, [f.line(p, '+new')])).outcome, 'failed')
  p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  assert.equal(await f.blob(), 'new')
  p = await f.read('staged')
  success(await f.act(p, p.hunks[0].lines))
  assert.equal(await f.blob(), 'old')
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'new')
})
test('names with spaces, Unicode and patch-like lines are literal paths and selectable content', async (t) => {
  const file = process.platform === 'win32' ? '中文 - name.txt' : '中文\t"name.txt',
    f = await fixture(t, '---header\n+++content\n', file)
  await f.write('---header\n+++CHANGED\n')
  const p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  assert.equal(await f.blob(), '---header\n+++CHANGED\n')
})
test('file/index/HEAD changes, duplicate lines and replayed plans cannot write a stale selection', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  let p = await f.read()
  await f.write('external\n')
  assert.equal((await f.act(p, p.hunks[0].lines)).outcome, 'failed')
  p = await f.read()
  await fs.writeFile(path.join(f.repo, 'other.txt'), 'other\n')
  await f.git.git(f.repo, ['add', 'other.txt'])
  const index = await f.git.indexFingerprint(f.repo)
  assert.equal((await f.act(p, p.hunks[0].lines)).outcome, 'failed')
  assert.equal(await f.git.indexFingerprint(f.repo), index)
  p = await f.read()
  assert.equal((await f.act(p, [p.hunks[0].lines[0], p.hunks[0].lines[0]])).outcome, 'failed')
  assert.equal((await f.act(p, p.hunks[0].lines)).outcome, 'failed')
})
test('an external index lock stays untouched and unsupported binary/conflict/rename modes have clear failures', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  const p = await f.read(),
    lock = path.join(f.repo, '.git', 'index.lock')
  await fs.writeFile(lock, 'external owner')
  assert.equal((await f.act(p, p.hunks[0].lines)).outcome, 'failed')
  assert.equal(await fs.readFile(lock, 'utf8'), 'external owner')
  await fs.unlink(lock)
  await fs.writeFile(path.join(f.repo, f.file), Buffer.from([0, 1, 2]))
  await assert.rejects(f.read(), /二进制|文本修改/)
})
test('switching to another branch at the same SHA before prepare aborts rather than staging in that branch', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  await f.git.git(f.repo, ['branch', 'qa/other'])
  const p = await f.read(),
    before = await f.git.indexFingerprint(f.repo),
    original = f.git.git.bind(f.git)
  f.git.git = async (repo, args, options) => {
    if (args[0] === 'update-ref' && options?.onPrepared) {
      await original(repo, ['switch', 'qa/other'])
      f.git.git = original
    }
    return original(repo, args, options)
  }
  assert.notEqual((await f.act(p, p.hunks[0].lines)).outcome, 'succeeded')
  assert.equal(await f.git.indexFingerprint(f.repo), before)
})
test('cancelling after temporary index preparation waits for cleanup and leaves real index/worktree untouched', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  const p = await f.read(),
    before = await f.git.indexFingerprint(f.repo),
    original = f.git.git.bind(f.git),
    controller = new AbortController()
  f.git.git = async (repo, args, options) => {
    const result = await original(repo, args, options)
    if (args[0] === 'update-index' && options?.indexFile) controller.abort()
    return result
  }
  assert.notEqual((await f.act(p, p.hunks[0].lines, controller.signal)).outcome, 'succeeded')
  f.git.git = original
  assert.equal(await f.git.indexFingerprint(f.repo), before)
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'changed\n')
  for (const name of ['HEAD.lock', 'index.lock'])
    await assert.rejects(fs.stat(path.join(f.repo, '.git', name)), /ENOENT/)
})

test('successful partial staging preserves unrelated cached blobs and never invokes reference hooks', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.repo, 'other.txt'), 'staged other\n')
  await f.git.git(f.repo, ['add', 'other.txt'])
  const before = (await f.git.git(f.repo, ['ls-files', '--stage', '--', 'other.txt'])).trim()
  await fs.mkdir(path.join(f.repo, '.no-hooks'))
  await fs.writeFile(
    path.join(f.repo, '.no-hooks', 'reference-transaction'),
    '#!/bin/sh\necho invoked > hook-ran\nexit 1\n',
    { mode: 0o755 },
  )
  await f.write('changed\n')
  const p = await f.read()
  success(await f.act(p, p.hunks[0].lines))
  assert.equal((await f.git.git(f.repo, ['ls-files', '--stage', '--', 'other.txt'])).trim(), before)
  await assert.rejects(fs.stat(path.join(f.repo, 'hook-ran')), /ENOENT/)
})
test('special index configurations and index hooks fail before creating an actionable selection', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  await fs.mkdir(path.join(f.repo, '.no-hooks'))
  await fs.writeFile(path.join(f.repo, '.no-hooks', 'post-index-change'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  })
  await assert.rejects(f.read(), /索引 Hook/)
  await fs.unlink(path.join(f.repo, '.no-hooks', 'post-index-change'))
  await f.git.git(f.repo, ['config', 'core.sparseCheckout', 'true'])
  await assert.rejects(f.read(), /稀疏/)
  await f.git.git(f.repo, ['config', 'core.sparseCheckout', 'false'])
  await f.git.git(f.repo, ['config', 'hook.partial.event', 'post-index-change'])
  await assert.rejects(f.read(), /索引 Hook/)
})
test('linked worktrees write their own index and shared SHA-256 repositories use the correct object format', async (t) => {
  const f = await fixture(t),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-partial-linked-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }))
  const linked = path.join(directory, 'linked')
  await f.git.git(f.repo, ['worktree', 'add', '-b', 'qa/linked', linked])
  const originalIndex = await f.git.indexFingerprint(f.repo)
  await fs.writeFile(path.join(linked, f.file), 'linked edit\n')
  const request = {
    expectedHead: await f.git.head(linked),
    expectedBranch: await f.git.currentBranch(linked),
    file: f.file,
    source: 'unstaged',
  }
  const p = await f.git.partialStage.read(linked, request)
  success(
    await f.git.action(linked, {
      ...request,
      action: 'partial-stage',
      planId: p.id,
      lines: p.hunks[0].lines,
    }),
  )
  assert.equal(await f.git.indexFingerprint(f.repo), originalIndex)
  const sha = path.join(directory, 'sha256')
  await fs.mkdir(sha)
  await f.git.git(sha, ['init', '--object-format=sha256', '-b', 'qa/hash'])
  for (const [k, v] of [
    ['user.name', 'Partial QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await f.git.git(sha, ['config', k, v])
  await fs.writeFile(path.join(sha, 'file.txt'), 'first\nsecond\n')
  const first = await f.git.partialStage.read(sha, {
    expectedHead: '',
    expectedBranch: 'qa/hash',
    file: 'file.txt',
    source: 'unstaged',
  })
  success(
    await f.git.action(sha, {
      expectedHead: '',
      expectedBranch: 'qa/hash',
      action: 'partial-stage',
      planId: first.id,
      lines: [first.hunks[0].lines[0]],
    }),
  )
  const entry = (await f.git.git(sha, ['ls-files', '--stage'])).trim()
  assert.match(entry, /100644 [a-f0-9]{64} 0\tfile.txt/)
})

test('cancellation waits for the prepared callback to settle before reporting completion', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  const p = await f.read(),
    before = await f.git.indexFingerprint(f.repo),
    original = f.git.git.bind(f.git),
    controller = new AbortController()
  let release,
    prepared,
    settled = false
  const barrier = new Promise((resolve) => {
      release = resolve
    }),
    reached = new Promise((resolve) => {
      prepared = resolve
    })
  f.git.git = async (repo, args, options) => {
    const value = await original(repo, args, options)
    if (args[0] === 'update-index' && options?.indexFile) {
      controller.abort()
      prepared()
      await barrier
    }
    return value
  }
  const running = f.act(p, p.hunks[0].lines, controller.signal).then((value) => {
    settled = true
    return value
  })
  await reached
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(settled, false)
  } finally {
    release()
  }
  assert.notEqual((await running).outcome, 'succeeded')
  f.git.git = original
  assert.equal(await f.git.indexFingerprint(f.repo), before)
  for (const name of ['HEAD.lock', 'index.lock'])
    await assert.rejects(fs.stat(path.join(f.repo, '.git', name)), /ENOENT/)
})

test('very high line-count files fail clearly before making a plan or changing the index', async (t) => {
  const base = 'x\n'.repeat(200001),
    f = await fixture(t, base)
  await f.write('changed\n' + base.slice(2))
  const index = await f.git.indexFingerprint(f.repo)
  await assert.rejects(f.read(), /文件行数较多/)
  assert.equal(await f.git.indexFingerprint(f.repo), index)
})

test('untracked CRLF files obey core.autocrlf when staging selected lines', async (t) => {
  const f = await fixture(t, '', 'new.txt', true)
  await f.git.git(f.repo, ['config', 'core.autocrlf', 'true'])
  await f.write('alpha\r\nbeta\r\n')
  const p = await f.read()
  success(await f.act(p, [p.hunks[0].lines[0]]))
  assert.equal(await f.blob(), 'alpha\n')
  assert.equal(await fs.readFile(path.join(f.repo, f.file), 'utf8'), 'alpha\r\nbeta\r\n')
})

test('LFS, content filters and conversion-setting changes cannot silently stage malformed or stale content', async (t) => {
  const f = await fixture(t)
  await f.write('changed\n')
  const p = await f.read(),
    before = await f.git.indexFingerprint(f.repo)
  await f.git.git(f.repo, ['config', 'core.autocrlf', 'true'])
  assert.equal((await f.act(p, p.hunks[0].lines)).outcome, 'failed')
  assert.equal(await f.git.indexFingerprint(f.repo), before)
  await fs.writeFile(
    path.join(f.repo, '.gitattributes'),
    `${f.file.replace('中文 file.txt', '"中文 file.txt"')} filter=lfs\n`,
  )
  await assert.rejects(f.read(), /LFS|过滤器/)
  await fs.writeFile(
    path.join(f.repo, '.gitattributes'),
    '"中文 file.txt" working-tree-encoding=UTF-16\n',
  )
  await assert.rejects(f.read(), /编码转换/)
  assert.equal(await f.git.indexFingerprint(f.repo), before)
})

test('a timed out prepared Git process aborts the callback and waits for it before returning', async (t) => {
  const f = await fixture(t),
    head = await f.git.head(f.repo)
  let entered = false,
    cleaned = false
  await assert.rejects(
    f.git.git(f.repo, ['update-ref', '--stdin'], {
      timeout: 2000,
      input: `start\nverify HEAD ${head}\nprepare\n`,
      onPrepared: async (signal) => {
        entered = true
        if (!signal.aborted)
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        assert.equal(signal.aborted, true)
        await new Promise((resolve) => setTimeout(resolve, 30))
        cleaned = true
      },
    }),
    /超时/,
  )
  assert.equal(entered, true)
  assert.equal(cleaned, true)
  for (const name of ['HEAD.lock', 'index.lock'])
    await assert.rejects(fs.stat(path.join(f.repo, '.git', name)), /ENOENT/)
})
