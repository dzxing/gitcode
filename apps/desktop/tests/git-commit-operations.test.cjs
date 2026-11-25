'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-commit-menu-'))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true })
  })
  const cmd = (...args) => git.git(repo, args)
  await cmd('init', '-b', 'feature/test')
  for (const [key, value] of Object.entries({
    'user.name': 'Test',
    'user.email': 'test@invalid.test',
    'commit.gpgsign': 'false',
    'core.autocrlf': 'false',
  }))
    await cmd('config', key, value)
  const write = (file, content) => fs.writeFile(path.join(repo, file), content)
  const commit = async (file, text, message = file) => {
    await write(file, text)
    await cmd('add', '--', file)
    await cmd('commit', '-m', message)
    return git.head(repo)
  }
  const root = await commit('base.txt', 'base\n', 'root')
  const a = await commit('a.txt', 'a\n', 'first')
  const b = await commit('b.txt', 'b\n', 'second')
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
  })
  const read = async (kind, oids = [a], extra = {}) =>
    git.commitOperations.read(repo, { kind, oids, ...(await context()), ...extra })
  const plan = (operation, oids = [a]) => read('plan', oids, { operation })
  const execute = async (p, extra = {}) =>
    git.action(repo, {
      action: 'commit-operation',
      planId: p.id,
      confirm: true,
      ...(await context()),
      ...extra,
    })
  return { git, repo, cmd, write, commit, root, a, b, context, read, plan, execute }
}
const success = (result) => assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
test('历史树、文本和补丁只读；非连续补丁保持提交顺序并可 git am', async (t) => {
  const f = await fixture(t)
  const before = await f.cmd('status', '--porcelain')
  assert.ok((await f.read('browse')).entries.some((e) => e.path === 'a.txt'))
  assert.equal((await f.read('blob', [f.a], { file: 'a.txt' })).content, 'a\n')
  const patch = (await f.read('patch', [f.b, f.a])).content
  assert.ok(patch.includes('Subject: [PATCH 1/2] first'), patch)
  await f.cmd('switch', '-c', 'apply-test', f.root)
  await f.git.git(f.repo, ['am'], { input: patch })
  assert.equal((await f.cmd('log', '-2', '--format=%s')).trim(), 'second\nfirst')
  assert.equal(await f.cmd('status', '--porcelain'), before)
})
test('编辑旧消息包含选中提交；后继内容不变，原 HEAD 有恢复点', async (t) => {
  const f = await fixture(t),
    p = await f.plan('reword')
  assert.deepEqual(
    p.rebase.steps.map((s) => s.sha),
    [f.a, f.b],
  )
  success(await f.execute(p, { message: 'edited first' }))
  assert.equal((await f.cmd('log', '-2', '--format=%s')).trim(), 'second\nedited first')
  assert.equal(await f.cmd('diff', f.b, 'HEAD', '--'), '')
  assert.ok(
    (await f.cmd('for-each-ref', '--format=%(objectname)', 'refs/gitcode/recovery')).includes(f.b),
  )
})
test('根提交支持从此开始交互式变基；fixup 保留目标消息', async (t) => {
  const f = await fixture(t),
    p = await f.plan('interactive', [f.root])
  assert.equal(p.rebase.root, true)
  const steps = p.rebase.steps.map((s, i) => ({ ...s, type: i === 1 ? 'fixup' : 'pick' }))
  success(await f.execute(p, { steps }))
  assert.equal((await f.cmd('rev-list', '--count', 'HEAD')).trim(), '2')
  assert.equal((await f.cmd('log', '--format=%s')).trim(), 'second\nroot')
  assert.equal(await f.cmd('diff', f.b, 'HEAD'), '')
})
test('删除与连续压缩重写历史，非连续压缩明确拦截', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.plan('squash', [f.root, f.b]), /连续/)
  const p = await f.plan('squash', [f.b, f.a])
  success(await f.execute(p, { message: 'combined' }))
  assert.equal((await f.cmd('log', '--format=%s')).trim(), 'combined\nroot')
  const head = await f.git.head(f.repo)
  success(await f.execute(await f.plan('drop', [head])))
  assert.equal(await f.git.head(f.repo), f.root)
  assert.equal(await fs.stat(path.join(f.repo, 'a.txt')).catch(() => null), null)
})
test('HEAD reword 不混入暂存更改；撤销为 soft reset；过期计划拒绝', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'staged change\n')
  await f.cmd('add', 'a.txt')
  success(await f.execute(await f.plan('reword', [f.b]), { message: 'new head message' }))
  assert.equal((await f.cmd('diff', '--cached', '--name-only')).trim(), 'a.txt')
  assert.equal(await f.cmd('show', 'HEAD:a.txt'), 'a\n')
  const head = await f.git.head(f.repo),
    p = await f.plan('undo', [head])
  success(await f.execute(p))
  assert.equal(await f.git.head(f.repo), f.a)
  assert.ok((await f.cmd('diff', '--cached', '--name-only')).includes('b.txt'))
  const stale = await f.plan('reset', [f.root])
  await f.write('a.txt', 'changed again\n')
  const rejected = await f.execute(stale, { mode: 'mixed' })
  assert.equal(rejected.outcome, 'failed')
  assert.match(rejected.error, /变化/)
})
test('四种 reset 模式有正确暂存和工作区语义，Hard 必须确认', async (t) => {
  for (const mode of ['soft', 'mixed', 'hard', 'keep'])
    await t.test(mode, async (st) => {
      const f = await fixture(st),
        p = await f.plan('reset', [f.a])
      if (mode === 'hard') {
        const denied = await f.execute(p, { mode })
        assert.equal(denied.outcome, 'failed')
      }
      success(await f.execute(p, { mode, confirmHard: true }))
      assert.equal(await f.git.head(f.repo), f.a)
      const stat = await fs.stat(path.join(f.repo, 'b.txt')).catch(() => null)
      assert.equal(!!stat, ['soft', 'mixed'].includes(mode))
      assert.equal(
        (await f.cmd('diff', '--cached', '--name-only')).includes('b.txt'),
        mode === 'soft',
      )
    })
})
test('Fixup 创建选中文件提交，保留未选择文件和已有暂存状态', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'a changed\n')
  await f.write('b.txt', 'b changed\n')
  await f.cmd('add', 'b.txt')
  const p = await f.plan('fixup', [f.a])
  success(await f.execute(p, { message: 'fixup! first', paths: ['a.txt'] }))
  assert.equal((await f.cmd('log', '-1', '--format=%s')).trim(), 'fixup! first')
  assert.equal(await f.cmd('show', 'HEAD:b.txt'), 'b\n')
  assert.equal((await f.cmd('diff', '--cached', '--name-only')).trim(), 'b.txt')
})
test('保护分支包含提交时禁止历史编辑；普通已发布分支仍可编辑', async (t) => {
  const f = await fixture(t)
  await f.cmd('remote', 'add', 'origin', 'https://example.invalid/repo.git')
  await f.cmd('update-ref', 'refs/remotes/origin/topic', f.b)
  assert.ok((await f.plan('reword')).id)
  await f.cmd('update-ref', 'refs/remotes/origin/main', f.b)
  await assert.rejects(f.plan('reword'), /保护/)
  assert.ok((await f.plan('reset')).id)
})
test('优选和还原发生冲突后可经同一三方编辑器解决、继续、跨实例读取和中止', async (t) => {
  for (const operation of ['cherry', 'revert'])
    await t.test(operation, async (st) => {
      const f = await fixture(st)
      const changed = await f.commit('a.txt', 'incoming\n', 'incoming')
      if (operation === 'cherry') await f.cmd('switch', '-c', 'other', f.b)
      await f.commit('a.txt', 'local\n', 'local')
      const result = await f.execute(await f.plan(operation, [changed]))
      assert.equal(result.outcome, 'partial', JSON.stringify(result))
      let state = await f.git.merge.state(f.repo)
      assert.equal(state.sequence, operation === 'cherry' ? 'cherry-pick' : 'revert')
      assert.equal(state.unsupported, false)
      const restarted = new GitService()
      st.after(() => restarted.shutdown())
      assert.equal((await restarted.merge.state(f.repo)).sequence, state.sequence)
      const read = await f.git.merge.read(f.repo, 'a.txt')
      success(
        await f.git.action(f.repo, {
          action: 'merge-resolve',
          file: 'a.txt',
          token: read.file.token,
          choice: 'theirs',
          mergeSignature: state.signature,
          ...(await f.context()),
        }),
      )
      state = await f.git.merge.state(f.repo)
      success(
        await f.git.action(f.repo, {
          action: 'commit-sequence',
          command: 'continue',
          mergeSignature: state.signature,
          ...(await f.context()),
        }),
      )
      assert.equal(await f.git.merge.state(f.repo), null)
      assert.equal(
        await fs.readFile(path.join(f.repo, 'a.txt'), 'utf8'),
        operation === 'cherry' ? 'incoming\n' : 'a\n',
      )
    })
})
test('按所选 SHA 推送，不误推后续 HEAD；无源分支提交也可发布', async (t) => {
  const f = await fixture(t)
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-menu-remote-'))
  t.after(() => fs.rm(remote, { recursive: true, force: true }))
  await f.git.git(remote, ['init', '--bare'])
  await f.cmd('remote', 'add', 'origin', remote)
  const ctx = await f.context()
  const p = await f.git.sync.plan(f.repo, 'push', {
    ...ctx,
    commitOid: f.a,
    publish: { remote: 'origin', branch: 'published' },
  })
  assert.equal(p.head, f.a)
  success(await f.git.action(f.repo, { action: 'push', planId: p.id }))
  assert.equal((await f.git.git(remote, ['rev-parse', 'refs/heads/published'])).trim(), f.a)
  assert.equal(await f.git.head(f.repo), f.b)
  const detached = await f.git.sync.plan(f.repo, 'push', {
    ...ctx,
    commitOid: f.b,
    detachedSource: true,
    publish: { remote: 'origin', branch: 'detached-source' },
  })
  success(await f.git.action(f.repo, { action: 'push', planId: detached.id }))
  assert.equal((await f.git.git(remote, ['rev-parse', 'refs/heads/detached-source'])).trim(), f.b)
})

test('优选空提交可跳过；冲突可中止并保留操作前 HEAD 和工作区', async (t) => {
  const f = await fixture(t)
  const before = await f.git.head(f.repo)
  const empty = await f.execute(await f.plan('cherry', [f.a]))
  assert.equal(empty.outcome, 'partial')
  let state = await f.git.merge.state(f.repo)
  success(
    await f.git.action(f.repo, {
      action: 'commit-sequence',
      command: 'skip',
      mergeSignature: state.signature,
      confirm: true,
      ...(await f.context()),
    }),
  )
  assert.equal(await f.git.head(f.repo), before)
  assert.equal(await f.git.merge.state(f.repo), null)
  const incoming = await f.commit('a.txt', 'incoming\n', 'incoming')
  await f.cmd('switch', '-c', 'conflict-abort', before)
  const original = await f.commit('a.txt', 'local\n', 'local')
  assert.equal((await f.execute(await f.plan('cherry', [incoming]))).outcome, 'partial')
  state = await f.git.merge.state(f.repo)
  const refused = await f.git.action(f.repo, {
    action: 'commit-sequence',
    command: 'abort',
    mergeSignature: state.signature,
    ...(await f.context()),
  })
  assert.equal(refused.outcome, 'failed')
  success(
    await f.git.action(f.repo, {
      action: 'commit-sequence',
      command: 'abort',
      mergeSignature: state.signature,
      confirm: true,
      ...(await f.context()),
    }),
  )
  assert.equal(await f.git.head(f.repo), original)
  assert.equal(await fs.readFile(path.join(f.repo, 'a.txt'), 'utf8'), 'local\n')
})
test('检出修订保护未提交更改并恢复原暂存状态；历史读取保留 BOM 和特殊文件名', async (t) => {
  const f = await fixture(t)
  await f.write('a.txt', 'dirty\n')
  await f.cmd('add', 'a.txt')
  success(
    await f.git.action(f.repo, { action: 'checkout-revision', oid: f.a, ...(await f.context()) }),
  )
  assert.equal(await f.git.currentBranch(f.repo), '')
  assert.equal(await f.git.head(f.repo), f.a)
  assert.equal(await fs.readFile(path.join(f.repo, 'a.txt'), 'utf8'), 'dirty\n')
  assert.equal((await f.cmd('diff', '--cached', '--name-only')).trim(), 'a.txt')
  await f.cmd('reset', '--hard', f.b)
  // Square brackets still exercise literal Git paths on Windows, which forbids '*'.
  const file = process.platform === 'win32' ? 'file[abc].txt' : 'file[*].txt'
  const sha = await f.commit(file, '\uFEFFexact\n', 'special file')
  assert.equal((await f.read('blob', [sha], { file })).content, '\uFEFFexact\n')
})
test('Hard 重置显示可能覆盖的忽略文件；确认后内容变化使计划失效', async (t) => {
  const f = await fixture(t)
  const target = await f.commit('ignored.txt', 'tracked\n', 'tracked ignored target')
  await f.cmd('reset', '--hard', f.b)
  await f.write('.gitignore', 'ignored.txt\n')
  await f.cmd('add', '.gitignore')
  await f.cmd('commit', '-m', 'ignore')
  await f.write('ignored.txt', 'valuable local content\n')
  const p = await f.plan('reset', [target])
  assert.ok(p.files.some((f) => f.path === 'ignored.txt' && f.status === '!'))
  await f.write('ignored.txt', 'changed after confirmation\n')
  const result = await f.execute(p, { mode: 'hard', confirmHard: true })
  assert.equal(result.outcome, 'failed')
  assert.equal(
    await fs.readFile(path.join(f.repo, 'ignored.txt'), 'utf8'),
    'changed after confirmation\n',
  )
})
test('HEAD 为 merge 时编辑消息保留双亲及原暂存内容', async (t) => {
  const f = await fixture(t)
  await f.cmd('switch', '-c', 'side', f.root)
  await f.commit('side.txt', 'side\n', 'side')
  await f.cmd('switch', 'feature/test')
  await f.cmd('merge', '--no-ff', '-m', 'merge side', 'side')
  const head = await f.git.head(f.repo),
    parents = await f.cmd('show', '-s', '--format=%P', head)
  await f.write('a.txt', 'staged\n')
  await f.cmd('add', 'a.txt')
  success(await f.execute(await f.plan('reword', [head]), { message: 'edited merge' }))
  assert.equal(await f.cmd('show', '-s', '--format=%P', 'HEAD'), parents)
  assert.equal(await f.cmd('show', 'HEAD:a.txt'), 'a\n')
  assert.equal((await f.cmd('diff', '--cached', '--name-only')).trim(), 'a.txt')
})
test('托管 URL 去除凭据，不猜未知主机；过期上下文不能检出', async (t) => {
  const f = await fixture(t)
  await f.cmd('remote', 'add', 'origin', 'https://user:secret@gitlab.example.test/group/repo.git')
  const result = await f.read('hosting')
  assert.equal(result.urls[0].url, `https://gitlab.example.test/group/repo/-/commit/${f.a}`)
  await f.cmd('remote', 'set-url', 'origin', 'https://unknown.invalid/group/repo.git')
  assert.deepEqual((await f.read('hosting')).urls, [])
  const ctx = await f.context()
  await f.commit('new.txt', 'new\n', 'moved')
  const rejected = await f.git.action(f.repo, { action: 'checkout-revision', oid: f.a, ...ctx })
  assert.equal(rejected.outcome, 'failed')
  assert.equal(await f.git.currentBranch(f.repo), 'feature/test')
})
test('指定 SHA 推送在确认后遇到远端变化必须拒绝，不改远端或推送后继', async (t) => {
  const f = await fixture(t)
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-menu-race-'))
  t.after(() => fs.rm(remote, { recursive: true, force: true }))
  await f.git.git(remote, ['init', '--bare'])
  await f.cmd('remote', 'add', 'origin', remote)
  const p = await f.git.sync.plan(f.repo, 'push', {
    ...(await f.context()),
    commitOid: f.a,
    publish: { remote: 'origin', branch: 'race' },
  })
  await f.cmd('push', 'origin', `${f.b}:refs/heads/race`)
  const refused = await f.git.action(f.repo, { action: 'push', planId: p.id })
  assert.equal(refused.outcome, 'failed')
  assert.equal((await f.git.git(remote, ['rev-parse', 'refs/heads/race'])).trim(), f.b)
  assert.equal(await f.git.head(f.repo), f.b)
})
