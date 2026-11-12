const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const {
  candidates,
  discover,
  preference,
  readPreference,
  environmentForGit,
} = require('../electron/git-runtime.cjs')
const { GitService } = require('../electron/git.cjs')

test('bundled Windows Git takes priority over outdated system Git without requiring PATH', async () => {
  const calls = []
  const found = await discover(
    async (file) => {
      calls.push(file)
      return {
        code: 0,
        stdout: file.startsWith('C:\\App\\resources')
          ? 'git version 2.56.0.windows.4'
          : 'git version 2.45.2.windows.1',
      }
    },
    { platform: 'win32', resourcesPath: 'C:\\App\\resources', env: {} },
  )
  assert.equal(found.source, 'bundled')
  assert.equal(found.path, 'C:\\App\\resources\\git\\cmd\\git.exe')
  assert.equal(calls.length, 1)
})

test('missing bundle falls back to a suitable system installation, rejecting old versions', async () => {
  const found = await discover(
    async (file) => {
      if (file.includes('resources')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return {
        code: 0,
        stdout: file === 'git.exe' ? 'git version 2.45.2' : 'git version 2.54.0.windows.1',
      }
    },
    {
      platform: 'win32',
      resourcesPath: 'C:\\App\\resources',
      env: { ProgramFiles: 'C:\\Program Files' },
    },
  )
  assert.equal(found.source, 'system')
  assert.equal(found.path, 'C:\\Program Files\\Git\\cmd\\git.exe')
})

test('explicit custom Git and environment overrides never silently switch to another executable', async () => {
  for (const options of [
    { selection: { mode: 'custom', path: '/custom/git' } },
    { env: { GITCODE_GIT_PATH: '/override/git' } },
  ]) {
    const calls = []
    const found = await discover(
      async (file) => {
        calls.push(file)
        return { code: 0, stdout: 'git version 2.45.2' }
      },
      { env: {}, resourcesPath: '/resources', ...options },
    )
    assert.equal(calls.length, 1)
    assert.equal(found.path, undefined)
    assert.match(found.error, /2\.45\.2/)
  }
})

test('system mode bypasses bundled Git while environment override remains explicit', () => {
  const options = {
    platform: 'win32',
    resourcesPath: 'C:\\App\\resources',
    selection: { mode: 'system' },
    env: {},
  }
  assert.equal(
    candidates(options).some((x) => x.source === 'bundled'),
    false,
  )
  assert.deepEqual(candidates({ ...options, env: { GITCODE_GIT_PATH: 'C:\\Special\\git.exe' } }), [
    { path: 'C:\\Special\\git.exe', source: 'environment' },
  ])
})

test('bundled Git helpers and hook subprocesses use its runtime without replacing user configuration', () => {
  const original = {
    PATH: 'C:\\OldGit;C:\\Node',
    GIT_EXEC_PATH: 'C:\\OldGit\\libexec',
    HOME: 'C:\\Users\\User',
    GIT_SSH_COMMAND: 'custom-ssh',
  }
  const env = environmentForGit(
    original,
    'C:\\App\\resources\\git\\cmd\\git.exe',
    'bundled',
    'win32',
  )
  assert.equal(env.PATH, undefined)
  assert.equal(env.GIT_EXEC_PATH, undefined)
  assert.match(env.Path, /^C:\\App\\resources\\git\\cmd;/)
  assert.ok(env.Path.endsWith(original.PATH))
  assert.equal(env.HOME, original.HOME)
  assert.equal(env.GIT_SSH_COMMAND, original.GIT_SSH_COMMAND)
  assert.equal(original.GIT_EXEC_PATH, 'C:\\OldGit\\libexec')
})

test('Git runtime preferences validate custom paths and recover absent or corrupt settings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'runtime.json')
  assert.deepEqual(readPreference(file), { mode: 'auto' })
  await fs.writeFile(file, '{broken')
  assert.deepEqual(readPreference(file), { mode: 'auto' })
  assert.throws(() => preference({ mode: 'custom', path: 'git' }))
  assert.throws(() => preference({ mode: 'download' }))
  const selected = { mode: 'custom', path: path.join(root, 'git') }
  await fs.writeFile(file, JSON.stringify(selected))
  assert.deepEqual(readPreference(file), selected)
})

test('GitService reports the selected runtime source and actual executable version', async () => {
  const baseline = new GitService()
  const current = await baseline.runtime()
  assert.equal(current.gitAvailable, true, current.gitError)
  const git = new GitService({ env: {}, selection: { mode: 'custom', path: baseline.gitPath } })
  const runtime = await git.runtime()
  assert.equal(runtime.gitSource, 'custom')
  assert.equal(runtime.gitVersion, current.gitVersion)
  assert.equal(runtime.gitError, '')
})

test('Apple Git 2.54 is accepted with BOM and whitespace, using the supplied environment', async () => {
  const env = { PATH: '/usr/bin:/bin' }
  const found = await discover(
    async (_file, args, options) => {
      assert.deepEqual(args, ['--version'])
      assert.equal(options.env, env)
      assert.equal(options.cwd, os.homedir())
      return { code: 0, stdout: '\uFEFF  git version 2.54.0 (Apple Git-157)\r\n', stderr: '' }
    },
    { platform: 'darwin', env },
  )
  assert.equal(found.version, 'git version 2.54.0 (Apple Git-157)')
})

test('Finder environment can discover the direct Command Line Tools Git despite a failing system shim', async () => {
  const calls = []
  const found = await discover(
    async (file) => {
      calls.push(file)
      return file === '/Library/Developer/CommandLineTools/usr/bin/git'
        ? { code: 0, stdout: 'git version 2.54.0 (Apple Git-157)', stderr: '' }
        : { code: 1, stdout: '', stderr: 'xcrun: invalid active developer path' }
    },
    { platform: 'darwin', env: { PATH: '/usr/bin:/bin' } },
  )
  assert.equal(found.path, '/Library/Developer/CommandLineTools/usr/bin/git')
  assert.equal(found.source, 'system')
  assert.ok(!calls.includes('git'))
  assert.ok(!calls.includes('/usr/bin/git'))
})

test('macOS automatic detection finds MacPorts and standalone installations without PATH', async () => {
  for (const target of ['/opt/local/bin/git', '/usr/local/git/bin/git']) {
    const found = await discover(
      async (file) => {
        if (file !== target) throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
        return { code: 0, stdout: 'git version 2.54.0', stderr: '' }
      },
      { platform: 'darwin', env: { PATH: '/usr/bin:/bin' } },
    )
    assert.equal(found.path, target)
  }
})

test('Apple resolver runs before PATH/system shim, while explicit overrides never scan alternatives', async () => {
  const calls = []
  await discover(
    async (file) => {
      calls.push(file)
      return { code: 1, stdout: '', stderr: 'not available' }
    },
    { platform: 'darwin', env: {} },
  )
  assert.ok(calls.indexOf('/usr/bin/xcrun') < calls.indexOf('git'))
  assert.ok(calls.indexOf('/usr/bin/xcrun') < calls.indexOf('/usr/bin/git'))
  const override = candidates({ platform: 'darwin', env: { GITCODE_GIT_PATH: '/custom/git' } })
  assert.deepEqual(override, [{ path: '/custom/git', source: 'environment' }])
})

test('macOS resolver locates Git inside a nonstandard selected Xcode without invoking a shell', async () => {
  const target = '/Applications/Xcode 26.app/Contents/Developer/usr/bin/git'
  const found = await discover(
    async (file, args) => {
      if (file === '/usr/bin/xcrun') {
        assert.deepEqual(args, ['--find', 'git'])
        return { code: 0, stdout: target + '\n', stderr: '' }
      }
      return file === target
        ? { code: 0, stdout: 'git version 2.54.0 (Apple Git-157)', stderr: '' }
        : { code: 1, stdout: '', stderr: 'developer tool unavailable' }
    },
    { platform: 'darwin', env: {} },
  )
  assert.equal(found.path, target)
})

test('macOS explicit custom selection never invokes developer-tool fallback and reports actual stderr', async () => {
  const calls = []
  const found = await discover(
    async (file) => {
      calls.push(file)
      return {
        code: 1,
        stdout: '',
        stderr: 'xcrun: error: invalid active developer path /missing/developer',
      }
    },
    { platform: 'darwin', env: {}, selection: { mode: 'custom', path: '/custom/git' } },
  )
  assert.deepEqual(calls, ['/custom/git'])
  assert.match(found.error, /xcrun: error: invalid active developer path/)
  assert.doesNotMatch(found.error, /无法读取版本/)
  assert.ok(
    candidates({
      platform: 'darwin',
      env: { DEVELOPER_DIR: '/Custom/Xcode.app/Contents/Developer' },
    }).some((candidate) => candidate.path === '/Custom/Xcode.app/Contents/Developer/usr/bin/git'),
  )
})

test('failed Git discovery can be retried after installation, without switching a valid active Git', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-retry-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const executable = path.join(root, 'git')
  const git = new GitService({
    selection: { mode: 'custom', path: executable },
    dataDirectory: path.join(root, 'data'),
  })
  t.after(() => git.shutdown())
  assert.equal((await git.runtime()).gitAvailable, false)
  await fs.writeFile(executable, '#!/bin/sh\nprintf "git version 2.54.0 (Apple Git-157)\\n"\n', {
    mode: 0o755,
  })
  git.pendingJobs = 1
  await assert.rejects(git.retryRuntime(), /等待当前 Git 操作/)
  git.pendingJobs = 0
  assert.equal((await git.retryRuntime()).gitAvailable, true)
  await fs.rm(executable)
  assert.equal(
    (await git.retryRuntime()).gitAvailable,
    true,
    'valid active runtime is not silently switched',
  )
  git.closing = true
  await assert.rejects(git.retryRuntime(), /应用正在退出/)
})
