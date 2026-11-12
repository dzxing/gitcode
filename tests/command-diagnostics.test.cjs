const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { GitService } = require('../electron/git.cjs')
const { parseHookTrace } = require('../electron/command-diagnostics.cjs')

async function fixture(t, unborn = false) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-hook-中文-'))
  const git = new GitService()
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await git.git(repo, ['init', '-b', 'qa/hooks'])
  for (const [k, v] of [
    ['user.name', 'Hook QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.git/QA hooks'],
  ])
    await git.git(repo, ['config', k, v])
  await fs.mkdir(path.join(repo, '.git', 'QA hooks'))
  const write = (text) => fs.writeFile(path.join(repo, 'file.txt'), text)
  if (!unborn) {
    await write('base\n')
    await git.git(repo, ['add', 'file.txt'])
    await git.git(repo, ['commit', '-m', 'baseline'])
  }
  const head = await git.head(repo)
  await write('staged edit\n')
  await git.git(repo, ['add', 'file.txt'])
  return {
    repo,
    git,
    head,
    write,
    hook: (name, script) =>
      fs.writeFile(path.join(repo, '.git', 'QA hooks', name), '#!/bin/sh\n' + script + '\n', {
        mode: 0o755,
      }),
    act: async (action = 'commit', extra = {}, signal) =>
      git.action(
        repo,
        {
          expectedHead: await git.head(repo),
          expectedBranch: await git.currentBranch(repo),
          action,
          message: 'QA attempted commit',
          ...extra,
        },
        signal,
      ),
    log: (id) =>
      git.journal.read({ scope: 'repository', repo, id }).records.find((r) => r.id === id),
  }
}

test('Trace2 correlates hooks by session and child id, ignores nested Git and malformed records', () => {
  const record = (event) => JSON.stringify(event)
  assert.deepEqual(
    parseHookTrace(
      [
        record({ sid: 'root', event: 'version' }),
        record({
          sid: 'root',
          event: 'child_start',
          child_class: 'hook',
          hook_name: 'pre-commit',
          child_id: 0,
        }),
        record({
          sid: 'nested',
          event: 'child_start',
          child_class: 'hook',
          hook_name: 'post-commit',
          child_id: 0,
        }),
        record({ sid: 'nested', event: 'child_exit', child_id: 0, code: 99 }),
        'not json',
        record({ sid: 'root', event: 'child_exit', child_id: 0, code: 7 }),
        record({
          sid: 'root',
          event: 'child_start',
          child_class: 'hook',
          hook_name: 'commit-msg',
          child_id: 1,
        }),
      ].join('\n'),
    ),
    [
      { name: 'pre-commit', code: 7 },
      { name: 'commit-msg', code: null },
    ],
  )
})

test('silent pre-commit rejection identifies the actual hook without relying on stderr wording', async (t) => {
  const f = await fixture(t)
  await f.hook('pre-commit', 'exit 7')
  const result = await f.act()
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /pre-commit Hook/)
  assert.equal(result.snapshot.head, f.head)
  assert.equal(await f.git.git(f.repo, ['show', ':file.txt']), 'staged edit\n')
  assert.match(f.log(result.logId).output, /pre-commit：退出码 7/)
  assert.equal(f.log(result.logId).commands, '')
})

test('formatter edits survive a failed pre-commit, diff refreshes, and no auto-restage occurs', async (t) => {
  const f = await fixture(t)
  await f.hook(
    'pre-commit',
    "printf 'formatter edit\\n' > file.txt\nprintf 'QA_FORMATTER_OUTPUT\\n' >&2\nexit 1",
  )
  const result = await f.act()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.snapshot.head, f.head)
  assert.equal(await f.git.git(f.repo, ['show', ':file.txt']), 'staged edit\n')
  assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'formatter edit\n')
  assert.equal(result.snapshot.staged.length, 1)
  assert.equal(result.snapshot.unstaged.length, 1)
  assert.match(f.log(result.logId).output, /QA_FORMATTER_OUTPUT/)
  assert.equal(f.log(result.logId).output.split('QA_FORMATTER_OUTPUT').length - 1, 1)
})

test('hook changes to the real index are reported as side effects without rolling back', async (t) => {
  const f = await fixture(t)
  await f.hook('pre-commit', "printf 'hook staged\\n' > file.txt\ngit add file.txt\nexit 1")
  const result = await f.act()
  assert.equal(result.outcome, 'partial')
  assert.equal(result.snapshot.head, f.head)
  assert.match(result.warning, /提交未生成.*暂存内容已变化/)
  assert.equal(await f.git.git(f.repo, ['show', ':file.txt']), 'hook staged\n')
})

test('prepare-commit-msg and commit-msg rejections preserve staged content and actual hook output', async (t) => {
  for (const name of ['prepare-commit-msg', 'commit-msg']) {
    const f = await fixture(t)
    await f.hook(name, "printf 'QA_MESSAGE_REJECTED\\n'\nexit 2")
    const result = await f.act()
    assert.equal(result.outcome, 'failed')
    assert.ok(result.error.includes(name))
    assert.equal(result.snapshot.head, f.head)
    assert.equal(await f.git.git(f.repo, ['show', ':file.txt']), 'staged edit\n')
    assert.match(f.log(result.logId).output, /QA_MESSAGE_REJECTED/)
  }
})

test('post-commit failure is successful commit with a warning and diagnostic output, including silent hooks', async (t) => {
  for (const script of ['exit 9', "printf 'QA_POST_COMMIT_FAILED\\n' >&2\nexit 9"]) {
    const f = await fixture(t)
    await f.hook('post-commit', script)
    const result = await f.act()
    assert.equal(result.outcome, 'succeeded')
    assert.equal(result.error, undefined)
    assert.match(result.warning, /提交已创建.*post-commit.*无需重复提交/)
    assert.notEqual(result.snapshot.head, f.head)
    assert.equal(result.snapshot.staged.length, 0)
    assert.equal(f.log(result.logId).state, 'succeeded')
    assert.match(f.log(result.logId).output, /post-commit：退出码 9/)
  }
})

test('successful message-normalizing hook runs once, keeps Git semantics and logs output', async (t) => {
  const f = await fixture(t)
  await f.hook('commit-msg', "printf 'normalized message\\n' > \"$1\"\nprintf 'QA_HOOK_SUCCESS\\n'")
  const result = await f.act()
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.warning, undefined)
  assert.equal(result.snapshot.commits[0].subject, 'normalized message')
  assert.match(f.log(result.logId).output, /QA_HOOK_SUCCESS/)
})

test('unborn repository hook rejection does not create a commit', async (t) => {
  const f = await fixture(t, true)
  await f.hook('pre-commit', 'exit 1')
  const result = await f.act()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.snapshot.head, '')
  assert.equal(result.snapshot.staged.length, 1)
})

test('signing program failure preserves index and HEAD and links real diagnostics', async (t) => {
  const f = await fixture(t)
  await f.git.git(f.repo, ['config', 'commit.gpgsign', 'true'])
  await f.git.git(f.repo, ['config', 'gpg.format', 'openpgp'])
  await f.git.git(f.repo, ['config', 'gpg.program', path.join(f.repo, 'missing-signing-program')])
  const result = await f.act()
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /提交签名未完成/)
  assert.equal(result.snapshot.head, f.head)
  assert.equal(result.snapshot.staged.length, 1)
  assert.match(f.log(result.logId).output, /missing-signing-program|gpg failed/i)
})

test('pre-push rejection preserves local and remote commits, with hook output available without extended logging', async (t) => {
  const f = await fixture(t)
  const remote = path.join(f.repo, '.git', 'qa-remote.git')
  await f.git.git(f.repo, ['init', '--bare', remote])
  await f.git.git(f.repo, ['remote', 'add', 'origin', remote])
  await f.git.git(f.repo, ['push', '-u', 'origin', 'qa/hooks'])
  await f.git.git(f.repo, ['commit', '-m', 'local unpublished'])
  const head = await f.git.head(f.repo)
  await f.hook('pre-push', "printf 'QA_PRE_PUSH_REJECTED\\n' >&2\nexit 3")
  const plan = await f.git.syncPlan(f.repo, 'push', {
    expectedHead: head,
    expectedBranch: 'qa/hooks',
  })
  const result = await f.act('push', { planId: plan.id })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /pre-push Hook.*本地提交保留/)
  assert.equal(result.warning, undefined)
  assert.equal(result.snapshot.head, head)
  assert.equal(
    (await f.git.git(f.repo, ['--git-dir=' + remote, 'rev-parse', 'refs/heads/qa/hooks'])).trim(),
    f.head,
  )
  assert.match(f.log(result.logId).output, /QA_PRE_PUSH_REJECTED/)
})

test('cancelling during post-commit reports possible new commit and never says commit was blocked', async (t) => {
  const f = await fixture(t)
  await f.hook('post-commit', "printf 'started' > .git/post-started\nsleep 30")
  const controller = new AbortController()
  const pending = f.act('commit', {}, controller.signal)
  const deadline = Date.now() + 15000
  while (!(await fs.stat(path.join(f.repo, '.git', 'post-started')).catch(() => null))) {
    assert.ok(Date.now() < deadline, 'post-commit did not start')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  controller.abort()
  const result = await pending
  assert.equal(result.outcome, 'partial')
  assert.match(result.error, /提交后的 post-commit/)
  assert.doesNotMatch(result.error, /被.*阻止/)
  assert.notEqual(result.snapshot.head, f.head)
  assert.match(f.log(result.logId).output, /post-commit：未记录完成结果/)
})

test('hook environment failure provides PATH guidance and redacts secrets from normal logs', async (t) => {
  const f = await fixture(t)
  await f.hook(
    'pre-commit',
    "printf 'node: command not found\\ntoken=glpat-should-never-appear\\n' >&2\nexit 127",
  )
  const result = await f.act()
  assert.match(result.error, /PATH/)
  assert.doesNotMatch(JSON.stringify(f.log(result.logId)), /glpat-should-never-appear/)
})
