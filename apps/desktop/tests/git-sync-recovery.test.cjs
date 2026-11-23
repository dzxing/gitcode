const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { GitService } = require('../electron/git.cjs')
async function fixture(t, conflict = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-sync-recovery-'))
  const local = path.join(root, 'local'),
    peer = path.join(root, 'peer'),
    bare = path.join(root, 'remote.git')
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(local)
  await git.git(local, ['init', '-b', 'qa/recovery'])
  const configure = async (repo) => {
    for (const [key, value] of [
      ['user.name', 'Recovery QA'],
      ['user.email', 'qa@local.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
      ['core.autocrlf', 'false'],
    ])
      await git.git(repo, ['config', key, value])
  }
  const commit = async (repo, file, text) => {
    await fs.writeFile(path.join(repo, file), text)
    await git.git(repo, ['add', file])
    await git.git(repo, ['commit', '-m', file])
    return git.head(repo)
  }
  await configure(local)
  const base = await commit(local, 'shared.txt', 'base\n')
  await git.git(root, ['init', '--bare', bare])
  await git.git(local, ['remote', 'add', 'origin', bare])
  await git.git(local, ['push', '-u', 'origin', 'qa/recovery'])
  await git.git(root, ['clone', '-b', 'qa/recovery', bare, peer])
  await configure(peer)
  const localHead = await commit(local, conflict ? 'shared.txt' : 'local.txt', 'local\n')
  const remoteHead = await commit(peer, conflict ? 'shared.txt' : 'remote.txt', 'remote\n')
  await git.git(peer, ['push', 'origin', 'qa/recovery'])
  const context = async () => ({
    expectedHead: await git.head(local),
    expectedBranch: 'qa/recovery',
  })
  const plan = async () => git.syncPlan(local, 'push', await context())
  const run = async (p = null, signal) =>
    git.action(local, { action: 'pull-and-push', planId: (p || (await plan())).id }, signal)
  const remote = async (repo = bare) =>
    (await git.git(repo, ['rev-parse', 'refs/heads/qa/recovery'])).trim()
  return {
    root,
    local,
    peer,
    bare,
    git,
    commit,
    base,
    localHead,
    remoteHead,
    context,
    plan,
    run,
    remote,
  }
}
test('explicit pull-and-push merges once and publishes the exact merge after fresh checks', async (t) => {
  const f = await fixture(t),
    p = await f.plan()
  assert.equal(p.remoteCheck.state, 'diverged')
  const r = await f.run(p)
  assert.equal(r.outcome, 'succeeded', JSON.stringify(r))
  assert.equal(r.snapshot.merge, null)
  assert.equal(await f.remote(), r.snapshot.head)
  assert.deepEqual(
    (await f.git.git(f.local, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '),
    [f.localHead, f.remoteHead],
  )
  const duplicate = await f.run(p)
  assert.equal(duplicate.outcome, 'failed')
  assert.match(duplicate.error, /失效/)
})
test('conflicting recovery ends the chain; manual completion never resumes the old push', async (t) => {
  const f = await fixture(t, true),
    r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.equal(r.snapshot.merge.files.length, 1)
  assert.match(r.warning, /推送已停止/)
  assert.equal(await f.remote(), f.remoteHead)
  await f.git.git(f.local, ['checkout', '--ours', 'shared.txt'])
  await f.git.git(f.local, ['add', 'shared.txt'])
  const state = await f.git.merge.state(f.local)
  const done = await f.git.action(f.local, {
    action: 'merge-finish',
    ...(await f.context()),
    mergeSignature: state.signature,
    message: 'manual resolution',
  })
  assert.equal(done.outcome, 'succeeded', JSON.stringify(done))
  assert.equal(await f.remote(), f.remoteHead)
})
test('another remote update during integration stops continuation without another merge or force push', async (t) => {
  const f = await fixture(t),
    integrate = f.git.merge.integrate.bind(f.git.merge)
  let advanced
  f.git.merge.integrate = async (...args) => {
    const result = await integrate(...args)
    advanced = await f.commit(f.peer, 'later.txt', 'later\n')
    await f.git.git(f.peer, ['push', 'origin', 'qa/recovery'])
    return result
  }
  const r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.match(r.error, /再次变化/)
  assert.equal(await f.remote(), advanced)
  assert.deepEqual(
    (await f.git.git(f.local, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '),
    [f.localHead, f.remoteHead],
  )
})
test('cancellation after integration never proceeds to push', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    integrate = f.git.merge.integrate.bind(f.git.merge)
  f.git.merge.integrate = async (...args) => {
    const r = await integrate(...args)
    controller.abort()
    return r
  }
  const r = await f.run(null, controller.signal)
  assert.equal(r.outcome, 'cancelled', JSON.stringify(r))
  assert.equal(await f.remote(), f.remoteHead)
  assert.notEqual(await f.git.head(f.local), f.localHead)
})
test('push configuration changes during integration cannot retarget the continuation', async (t) => {
  const f = await fixture(t),
    other = path.join(f.root, 'other.git'),
    integrate = f.git.merge.integrate.bind(f.git.merge)
  await f.git.git(f.root, ['clone', '--bare', f.bare, other])
  f.git.merge.integrate = async (...args) => {
    const r = await integrate(...args)
    await f.git.git(f.local, ['config', 'remote.origin.pushurl', other])
    return r
  }
  const r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.match(r.error, /目标.*变化/)
  assert.equal(await f.remote(), f.remoteHead)
  assert.equal(await f.remote(other), f.remoteHead)
})
test('different pull and push destinations are rejected before local integration', async (t) => {
  const f = await fixture(t),
    fork = path.join(f.root, 'fork.git')
  await f.git.git(f.root, ['clone', '--bare', f.bare, fork])
  await f.git.git(f.local, ['remote', 'add', 'fork', fork])
  await f.git.git(f.local, ['config', 'branch.qa/recovery.pushRemote', 'fork'])
  const r = await f.run()
  assert.equal(r.outcome, 'failed', JSON.stringify(r))
  assert.match(r.error, /目标不同/)
  assert.equal(await f.git.head(f.local), f.localHead)
  assert.equal(await f.remote(fork), f.remoteHead)
})
test('non-current selected branch cannot pull into the current worktree', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.local, ['switch', '-c', 'qa/other'])
  const p = await f.git.syncPlan(f.local, 'push', {
    expectedHead: f.localHead,
    expectedBranch: 'qa/other',
    sourceRef: 'refs/heads/qa/recovery',
    sourceOid: f.localHead,
  })
  const r = await f.run(p)
  assert.equal(r.outcome, 'failed', JSON.stringify(r))
  assert.match(r.error, /先切换/)
  assert.equal(await f.remote(), f.remoteHead)
})
test('an extra external commit after merge is never included in automatic publication', async (t) => {
  const f = await fixture(t),
    integrate = f.git.merge.integrate.bind(f.git.merge)
  f.git.merge.integrate = async (...args) => {
    const r = await integrate(...args)
    await f.commit(f.local, 'external.txt', 'not reviewed\n')
    return r
  }
  const r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.match(r.error, /额外变化/)
  assert.equal(await f.remote(), f.remoteHead)
})
test('server hook refusal after successful pull reports partial completion without losing the merge', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(
    path.join(f.bare, 'hooks', 'pre-receive'),
    '#!/bin/sh\necho QA_REJECT >&2\nexit 1\n',
    { mode: 0o755 },
  )
  const r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.match(r.error, /QA_REJECT|declined/)
  assert.match(r.warning, /拉取已完成/)
  assert.equal(r.snapshot.merge, null)
  assert.notEqual(r.snapshot.head, f.localHead)
  assert.equal(await f.remote(), f.remoteHead)
})

test('recovery also supports a pure fast-forward without inventing a merge commit', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.local, ['reset', '--hard', f.base])
  const p = await f.plan()
  assert.equal(p.remoteCheck.state, 'behind')
  const r = await f.run(p)
  assert.equal(r.outcome, 'succeeded', JSON.stringify(r))
  assert.equal(r.snapshot.head, f.remoteHead)
  assert.equal(await f.remote(), f.remoteHead)
})

test('automatic stash restoration conflicts stop continuation and retain the exact stash', async (t) => {
  const f = await fixture(t)
  const remote = await f.commit(f.peer, 'shared.txt', 'remote changed shared file\n')
  await f.git.git(f.peer, ['push', 'origin', 'qa/recovery'])
  await fs.writeFile(path.join(f.local, 'shared.txt'), 'uncommitted local draft\n')
  const r = await f.run()
  assert.equal(r.outcome, 'partial', JSON.stringify(r))
  assert.equal(r.snapshot.merge.active, false)
  assert.equal(r.snapshot.merge.files.length, 1)
  assert.equal(r.snapshot.stashes.length, 1)
  assert.match(r.warning, /恢复/)
  assert.match(r.warning, /推送已停止/)
  assert.equal(await f.remote(), remote)
})
