const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { dispatch } = require('../electron/local-core.cjs')
const { ROOT, toUnc } = require('../electron/wsl-path.cjs')

// Explicit opt-in: runs Windows -> installed WSL against disposable repositories,
// never against an existing user checkout. Example: node tests/wsl-windows.test.cjs Ubuntu-26.04
const distribution = process.env.GITCODE_TEST_WSL || process.argv[2]
const fixtureExecute = promisify(execFile)
test(
  'Windows uses the selected WSL core for GitFlow, push, stash, conflict resolution, worktrees and watches',
  {
    skip: process.platform !== 'win32' || !distribution,
    timeout: 120000,
  },
  async (t) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-wsl-test-'))
    let git, root, run
    t.after(async () => {
      try {
        await git?.shutdown()
        if (root && run)
          await run(
            `require('node:fs').rmSync(${JSON.stringify(root)}, {recursive:true,force:true})`,
          )
      } finally {
        await fs.rm(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      }
    })
    const binary = path.resolve(
      __dirname,
      '../.gitcode-local/wsl-runtime',
      process.arch,
      'bin/node',
    )
    // Exercise the actual packaged layout on a Windows drive, including ELF
    // execution from resources and code loaded outside the ASAR container.
    const resources = path.join(state, 'resources')
    const core = path.join(resources, 'app.asar.unpacked/electron')
    await fs.mkdir(core, { recursive: true })
    for (const file of await fs.readdir(path.join(__dirname, '../electron')))
      if (/\.(?:cjs|json)$/.test(file))
        await fs.copyFile(path.join(__dirname, '../electron', file), path.join(core, file))
    const pty = path.dirname(require.resolve('node-pty/package.json'))
    const vendor = path.join(core, 'vendor/node-pty')
    await fs.mkdir(vendor, { recursive: true })
    for (const entry of ['package.json', 'lib', 'prebuilds'])
      await fs.cp(path.join(pty, entry), path.join(vendor, entry), { recursive: true })
    await fs.mkdir(path.join(resources, 'wsl/bin'), { recursive: true })
    await fs.copyFile(binary, path.join(resources, 'wsl/bin/node'))
    const { GitService } = require(path.join(core, 'git.cjs'))
    git = new GitService({
      dataDirectory: state,
      resourcesPath: resources,
      enforceRepositoryTrust: true,
    })
    const manager = git.wsl
    const node = await manager.hostPath(distribution, binary)
    run = async (code) => {
      // Fixture setup/cleanup must outlive the application's aborted probes.
      const result = await fixtureExecute(
        manager.wslExe,
        ['--distribution', distribution, '--cd', '/', '--exec', node, '-e', code],
        {
          encoding: 'buffer',
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          cwd: process.env.SystemRoot || 'C:\\Windows',
        },
      )
      return result.stdout.toString('utf8').trim()
    }
    root = await run(`
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'gitcode-windows-wsl-中文 ')),repo=path.join(root,'repo');
    fs.mkdirSync(repo);
    const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:['ignore','pipe','pipe']});
    git('init','-b','test/base');
    for(const [key,value] of [['user.name','WSL Windows Test'],['user.email','wsl@example.test'],['commit.gpgsign','false'],['tag.gpgsign','false'],['core.hooksPath','.git/test-hooks']])git('config',key,value);
    fs.writeFileSync(path.join(repo,'文件.txt'),'base\\n');git('add','.');git('commit','-m','initial');
    git('init','--bare',path.join(root,'origin.git'));git('remote','add','origin',path.join(root,'origin.git'));git('push','-u','origin','test/base');
    fs.mkdirSync(path.join(repo,'.git/test-hooks'));
    fs.writeFileSync(path.join(repo,'.git/test-hooks/post-commit'),'#!/bin/sh\\nuname -s > .git/wsl-hook-proof\\n',{mode:0o755});
    console.log(root);
  `)
    const linux = root + '/repo',
      repo = toUnc(distribution, linux)
    const call = (method, ...args) => dispatch(git, method, args)
    const write = (file, content) =>
      run(
        `require('node:fs').writeFileSync(${JSON.stringify(linux + '/' + file)},${JSON.stringify(content)})`,
      )
    const command = (...args) =>
      run(
        `process.stdout.write(require('node:child_process').execFileSync('git',${JSON.stringify(args)},{cwd:${JSON.stringify(linux)}}))`,
      )
    const roots = await call('directory', ROOT)
    assert.ok(
      roots.folders.some((folder) => folder.name.toLowerCase() === distribution.toLowerCase()),
    )
    await assert.rejects(call('snapshot', repo), /信任/)
    await assert.rejects(
      call('terminal', repo, { action: 'create', tabId: 1, cols: 80, rows: 24 }),
      /信任/,
    )
    const challenge = await call('repository-trust', repo)
    assert.equal(challenge.path, repo)
    await call('repository-trust-approve', repo, challenge.token)
    let snapshot = await call('snapshot', repo)
    assert.equal(snapshot.path, repo)
    assert.equal(snapshot.execution.distribution, distribution)
    assert.match(snapshot.execution.gitVersion, /^git version /)
    assert.equal(git.gitPath, null, 'WSL operations must not discover or use Windows Git')
    const terminal = await call('terminal', repo, {
      action: 'create',
      tabId: 1,
      cols: 80,
      rows: 24,
    })
    let terminalOutput = '',
      terminalCursor = 0
    await call('terminal', repo, {
      action: 'write',
      id: terminal.id,
      data: "printf '__WSL%s__\\n' 'TERMINAL'; pwd; test -t 0 && printf '__TTY%s__\\n' 'READY'\r",
    })
    for (let i = 0; i < 150 && !terminalOutput.includes('__TTYREADY__'); i++) {
      const result = await call('terminal', repo, {
        action: 'read',
        id: terminal.id,
        cursor: terminalCursor,
      })
      terminalCursor = result.cursor
      terminalOutput += result.data
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.ok(terminalOutput.includes('__WSLTERMINAL__'), terminalOutput)
    assert.ok(terminalOutput.includes('__TTYREADY__'), terminalOutput)
    assert.ok(terminalOutput.includes(linux), terminalOutput)
    await call('terminal', repo, { action: 'resize', id: terminal.id, cols: 100, rows: 30 })
    await call('terminal', repo, { action: 'close', id: terminal.id })
    assert.equal(git.gitPath, null, 'A WSL terminal must not discover or use Windows Git')
    const context = () => ({ expectedHead: snapshot.head, expectedBranch: snapshot.branch })
    const act = async (request) => {
      const result = await call('action', repo, { ...context(), ...request })
      if (result.snapshot) snapshot = result.snapshot
      return result
    }
    const config = {
      production: 'test/base',
      develop: 'develop',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    }
    const plan = await call('gitflow-plan', repo, {
      ...context(),
      config,
      sources: { develop: 'refs/heads/test/base' },
      signature: snapshot.gitflow.signature,
    })
    assert.equal((await act({ action: 'gitflow-init', planId: plan.id })).outcome, 'succeeded')
    assert.equal(snapshot.gitflow.ready, true)
    const console = await call('git-console', repo, { action: 'read' })
    assert.ok(console.entries.some((entry) => entry.kind === 'start'))
    assert.ok(
      console.entries.some((entry) => entry.kind === 'finish' && entry.state === 'succeeded'),
    )
    assert.ok(
      console.entries.every((entry) => entry.repo === repo && entry.operationId && entry.commandId),
    )
    assert.equal(console.running.length, 0)
    assert.equal(
      (await call('git-console', toUnc(distribution, root + '/other'), { action: 'read' })).entries
        .length,
      0,
    )
    assert.equal(
      (
        await act({
          action: 'gitflow-start',
          type: 'feature',
          name: 'wsl',
          switchAfter: true,
          signature: snapshot.gitflow.signature,
          sourceOid: snapshot.head,
        })
      ).outcome,
      'succeeded',
    )
    assert.equal(snapshot.branch, 'feature/wsl')
    await write('文件.txt', 'feature\n')
    assert.equal((await act({ action: 'stage', paths: ['文件.txt'] })).outcome, 'succeeded')
    assert.equal(
      (await act({ action: 'commit', message: '/home/commit-content-is-not-a-path' })).outcome,
      'succeeded',
    )
    assert.equal(snapshot.commits[0].subject, '/home/commit-content-is-not-a-path')
    assert.equal(
      await run(
        `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(linux + '/.git/wsl-hook-proof')},'utf8'))`,
      ),
      'Linux',
    )
    const pushedHead = snapshot.head
    const push = await call('sync-plan', repo, 'push', {
      ...context(),
      sourceRef: 'refs/heads/feature/wsl',
      sourceOid: snapshot.head,
    })
    assert.equal((await act({ action: 'push', planId: push.id })).outcome, 'succeeded')
    assert.equal(
      snapshot.branches.find((branch) => branch.name === 'feature/wsl').upstream,
      'origin/feature/wsl',
    )
    await write('文件.txt', 'working\n')
    snapshot = await call('snapshot', repo)
    const saved = await act({
      action: 'stash-create',
      stashSignature: snapshot.stashSignature,
      includeUntracked: true,
      message: '',
    })
    assert.equal(saved.outcome, 'succeeded')
    const entry = snapshot.stashes[0]
    assert.equal(
      (
        await act({
          action: 'stash-pop',
          stashSignature: snapshot.stashSignature,
          stashOid: entry.oid,
          stashRef: entry.ref,
          restoreIndex: true,
        })
      ).outcome,
      'succeeded',
    )
    assert.equal(snapshot.unstaged.length, 1)
    await write('文件.txt', 'feature\n')
    snapshot = await call('snapshot', repo)
    const finished = await act({
      action: 'gitflow-finish',
      signature: snapshot.gitflow.signature,
      branch: 'feature/wsl',
      sourceOid: pushedHead,
      targetOids: Object.fromEntries(
        snapshot.branches
          .filter((branch) => branch.kind === 'local')
          .map((branch) => [branch.name, branch.hash]),
      ),
      deleteBranch: true,
      createTag: false,
    })
    assert.equal(finished.outcome, 'succeeded', JSON.stringify(finished))
    assert.equal(snapshot.branch, 'develop')
    const watch = await call('repository-changes', repo)
    await write('文件.txt', 'external\n')
    let observed = false
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if ((await call('repository-changes', repo)).revision !== watch.revision) {
        observed = true
        break
      }
    }
    assert.ok(observed, 'Linux filesystem watcher must observe WSL edits')
    const background = await call('background-snapshot', repo, null)
    assert.equal(background.snapshot.path, repo)
    assert.equal(background.snapshot.unstaged.length, 1)
    await write('文件.txt', 'feature\n')
    // A worktree .git file contains Linux absolute paths. It must be inspected in Linux.
    const worktree = root + '/worktree'
    await command('worktree', 'add', '-b', 'test/worktree', worktree, 'develop')
    const worktreeUnc = toUnc(distribution, worktree)
    const trustWorktree = await call('repository-trust', worktreeUnc)
    await call('repository-trust-approve', worktreeUnc, trustWorktree.token)
    assert.equal((await call('snapshot', worktreeUnc)).branch, 'test/worktree')
    // Introduce a real merge conflict through the disposable fixture only.
    await command('switch', '-c', 'test/incoming')
    await write('文件.txt', 'incoming\n')
    await command('commit', '-am', 'incoming')
    const incoming = await command('rev-parse', 'HEAD')
    await command('switch', 'develop')
    await write('文件.txt', 'local\n')
    await command('commit', '-am', 'local')
    snapshot = await call('snapshot', repo)
    const merge = await act({
      action: 'merge-branch',
      fullRef: 'refs/heads/test/incoming',
      expectedOid: incoming,
      confirm: true,
    })
    assert.equal(merge.outcome, 'partial', JSON.stringify(merge))
    assert.ok(snapshot.merge)
    const versions = await call('merge-read', repo, '文件.txt')
    assert.equal(versions.file.ours.text, 'local\n')
    assert.equal(versions.file.theirs.text, 'incoming\n')
    const resolved = await act({
      action: 'merge-resolve',
      mergeSignature: snapshot.merge.signature,
      token: versions.file.token,
      file: '文件.txt',
      choice: 'manual',
      content: 'combined\n',
    })
    assert.equal(resolved.outcome, 'succeeded', JSON.stringify(resolved))
    assert.equal(
      (
        await act({
          action: 'merge-finish',
          mergeSignature: snapshot.merge.signature,
          message: 'Merge WSL conflict',
        })
      ).outcome,
      'succeeded',
    )
    assert.equal(snapshot.merge, null)
    // Cancellation must stop the Linux Git/hook process tree and its queued writes.
    await write('文件.txt', 'cancel this commit\n')
    assert.equal((await act({ action: 'stage', paths: ['文件.txt'] })).outcome, 'succeeded')
    const beforeCancel = snapshot.head
    await run(
      `require('node:fs').writeFileSync(${JSON.stringify(linux + '/.git/test-hooks/pre-commit')}, ${JSON.stringify('#!/bin/sh\necho started > .git/slow-hook-started\nexec sleep 20\n')}, {mode:0o755})`,
    )
    const interrupted = call('action', repo, {
      ...context(),
      action: 'commit',
      message: 'must be cancelled',
    })
    void interrupted.catch(() => {})
    let entered = false
    for (let attempt = 0; attempt < 15; attempt++) {
      if (
        (await run(
          `process.stdout.write(String(require('node:fs').existsSync(${JSON.stringify(linux + '/.git/slow-hook-started')})))`,
        )) === 'true'
      ) {
        entered = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(entered, 'test hook must start before cancellation')
    const queued = call('action', repo, {
      ...context(),
      action: 'branch',
      name: 'test/must-not-replay',
    })
    void queued.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    git.cancel()
    await Promise.allSettled([interrupted, queued])
    snapshot = await call('snapshot', repo)
    assert.equal(snapshot.head, beforeCancel)
    assert.ok(!snapshot.branches.some((branch) => branch.name === 'test/must-not-replay'))
    await run(
      `require('node:fs').unlinkSync(${JSON.stringify(linux + '/.git/test-hooks/pre-commit')})`,
    )
    await command('restore', '--staged', '--worktree', '--', '文件.txt')
    snapshot = await call('snapshot', repo)
    const cloneTarget = toUnc(distribution, root + '/clone')
    const clone = await call(
      'create',
      'clone',
      cloneTarget,
      toUnc(distribution, root + '/origin.git'),
    )
    assert.equal(clone.path, cloneTarget)
    assert.equal(clone.requiresTrust, true)
    const logs = await call('operation-log', { scope: 'repository', repo })
    assert.ok(logs.records.some((record) => record.operation === 'push'))
    assert.ok(logs.records.every((record) => record.repo === repo))
    assert.ok(
      git.journal.records.some((record) => record.repo === repo && record.operation === 'push'),
      'WSL logs must reach the shared Windows journal',
    )
    await git.wsl.shutdown()
    const reopened = new GitService({
      dataDirectory: state,
      resourcesPath: resources,
      enforceRepositoryTrust: true,
    })
    try {
      assert.equal((await dispatch(reopened, 'repository-trust', [repo])).trusted, true)
      assert.equal((await dispatch(reopened, 'snapshot', [repo])).head, snapshot.head)
      assert.ok(
        (await dispatch(reopened, 'operation-log', [{ scope: 'repository', repo }])).records.some(
          (record) => record.operation === 'push',
        ),
      )
    } finally {
      await reopened.shutdown()
    }
  },
)
