const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { assertSender, allowedNavigation } = require('../electron/security.cjs')

test('preload exposes named operations, never raw IPC or Node capabilities', async () => {
  const exposed = {},
    calls = [],
    listeners = new Map()
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8'), {
    process: { platform: 'win32' },
    require: (name) => {
      assert.equal(name, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (name, value) => {
            exposed[name] = value
          },
        },
        ipcRenderer: {
          invoke: async (...args) => {
            calls.push(args)
            return { maximized: true, fullscreen: false, focused: true }
          },
          on: (name, handler) => listeners.set(name, handler),
          removeListener: (name, handler) => {
            if (listeners.get(name) === handler) listeners.delete(name)
          },
        },
      }
    },
  })
  assert.equal(exposed.gitk.invoke, undefined)
  assert.equal(exposed.gitk.require, undefined)
  await exposed.gitk.gitConsole('/repo', { action: 'read', cursor: 0 })
  assert.deepEqual(calls.pop(), ['gitk:git-console', '/repo', { action: 'read', cursor: 0 }])
  await exposed.gitk.terminal('/repo', { action: 'shells' })
  assert.deepEqual(calls.pop(), ['gitk:terminal', '/repo', { action: 'shells' }])
  assert.equal(exposed.gitkWindow.require, undefined)
  assert.equal(exposed.gitkWindow.platform, 'win32')
  await exposed.gitk.chooseDirectory('/projects', 'parent')
  assert.deepEqual(calls.pop(), ['gitk:choose-directory', '/projects', 'parent'])
  await exposed.gitkApp.installedFonts()
  assert.deepEqual(calls.pop(), ['gitk:app:fonts'])
  assert.equal(exposed.gitkWindow.nativeControls, true)
  await exposed.gitkApp.repositoryLocation('/repo', 'show-folder')
  assert.deepEqual(calls.pop(), ['gitk:app:repository-location', '/repo', 'show-folder'])
  await exposed.gitk.historyMetadata('/repo', 'a'.repeat(40))
  assert.deepEqual(calls.pop(), ['gitk:history-metadata', '/repo', 'a'.repeat(40)])
  await exposed.gitk.historyRead('/repo', { token: 'history', offset: 250 })
  assert.deepEqual(calls.pop(), ['gitk:history-read', '/repo', { token: 'history', offset: 250 }])
  await exposed.gitk.repositoryTrust('/repo')
  assert.deepEqual(calls.pop(), ['gitk:repository-trust', '/repo'])
  await exposed.gitk.approveRepositoryTrust('/repo', 'token')
  assert.deepEqual(calls.pop(), ['gitk:repository-trust-approve', '/repo', 'token'])
  await exposed.gitk.partialStageRead('/repo', { file: 'file.txt', source: 'unstaged' })
  assert.deepEqual(calls.pop(), [
    'gitk:partial-stage-read',
    '/repo',
    { file: 'file.txt', source: 'unstaged' },
  ])
  await exposed.gitk.fetchSettingsRead('/repo')
  assert.deepEqual(calls.pop(), ['gitk:fetch-settings-read', '/repo'])
  await exposed.gitk.recoveryRead('/repo')
  assert.deepEqual(calls.pop(), ['gitk:recovery-read', '/repo'])
  await exposed.gitk.repositoryChanges('/repo')
  assert.deepEqual(calls.pop(), ['gitk:repository-changes', '/repo'])
  await exposed.gitk.refreshReferences('/repo', 'a'.repeat(64))
  assert.deepEqual(calls.pop(), ['gitk:refresh-references', '/repo', 'a'.repeat(64)])
  await exposed.gitk.backgroundSnapshot('/repo', null)
  assert.deepEqual(calls.pop(), ['gitk:background-snapshot', '/repo', null])
  await exposed.gitkApp.startupPhase('ready')
  assert.deepEqual(calls.pop(), ['gitk:app:startup-phase', 'ready'])
  await exposed.gitkApp.flushDraftStorage()
  assert.deepEqual(calls.pop(), ['gitk:app:flush-draft-storage'])
  await exposed.gitk.activity()
  assert.deepEqual(calls.pop(), ['gitk:activity'])
  await exposed.gitk.activitySettings({ autoFetchInterval: 0, extended: false })
  assert.deepEqual(calls.pop(), [
    'gitk:activity-settings',
    { autoFetchInterval: 0, extended: false },
  ])
  await exposed.gitk.operationLog({ scope: 'repository', repo: '/qa' })
  assert.deepEqual(calls.pop(), ['gitk:operation-log', { scope: 'repository', repo: '/qa' }])
  await exposed.gitk.clearOperationLog({ scope: 'application' })
  assert.deepEqual(calls.pop(), ['gitk:operation-log-clear', { scope: 'application' }])
  await exposed.gitk.automaticFetch('/qa')
  assert.deepEqual(calls.pop(), ['gitk:auto-fetch', '/qa'])
  await exposed.gitk.fetchStatus('/qa')
  assert.deepEqual(calls.pop(), ['gitk:fetch-status', '/qa'])
  await exposed.gitk.gitSettings({ mode: 'system' })
  assert.deepEqual(calls.pop(), ['gitk:git-settings', { mode: 'system' }])
  await exposed.gitk.refreshGitRuntime()
  assert.deepEqual(calls.pop(), ['gitk:git-runtime-refresh'])
  await exposed.gitk.chooseGit()
  assert.deepEqual(calls.pop(), ['gitk:choose-git'])
  await exposed.gitk.openResource('git-install')
  assert.deepEqual(calls.pop(), ['gitk:resource', 'git-install'])
  await exposed.gitk.snapshot('/repo')
  await exposed.gitk.action('/repo', { action: 'stage', paths: ['a'] })
  await exposed.gitk.listDirectory('/home')
  assert.deepEqual(calls, [
    ['gitk:snapshot', '/repo'],
    ['gitk:action', '/repo', { action: 'stage', paths: ['a'] }],
    ['gitk:directory', '/home'],
  ])
  await exposed.gitk.rebaseMenuRead('/repo', { head: 'a'.repeat(40), oid: 'b'.repeat(40) })
  assert.deepEqual(calls.at(-1), [
    'gitk:rebase-menu-read',
    '/repo',
    { head: 'a'.repeat(40), oid: 'b'.repeat(40) },
  ])
  await exposed.gitk.navigationRead('/repo', {
    kind: 'info',
    fullRef: 'refs/heads/main',
    expectedOid: 'abc',
  })
  assert.deepEqual(calls.at(-1), [
    'gitk:navigation-read',
    '/repo',
    { kind: 'info', fullRef: 'refs/heads/main', expectedOid: 'abc' },
  ])
  await exposed.gitk.stashRead('/repo', 'abc', 'src/a.txt')
  assert.deepEqual(calls.at(-1), ['gitk:stash-read', '/repo', 'abc', 'src/a.txt'])
  await exposed.gitk.syncPlan('/repo', 'push', { expectedHead: 'abc', expectedBranch: 'main' })
  assert.deepEqual(calls.at(-1), [
    'gitk:sync-plan',
    '/repo',
    'push',
    { expectedHead: 'abc', expectedBranch: 'main' },
  ])
  await exposed.gitk.gitflowPlan('/repo', { config: { production: 'main' }, sources: {} })
  assert.deepEqual(calls.at(-1), [
    'gitk:gitflow-plan',
    '/repo',
    { config: { production: 'main' }, sources: {} },
  ])
  await exposed.gitk.selectedCommitPlan('/repo', {
    expectedHead: 'abc',
    expectedBranch: 'main',
    paths: ['src/a.txt'],
  })
  assert.deepEqual(calls.at(-1), [
    'gitk:selected-commit-plan',
    '/repo',
    { expectedHead: 'abc', expectedBranch: 'main', paths: ['src/a.txt'] },
  ])
  assert.equal(exposed.gitkContextMenu.invoke, undefined)
  const contextRequest = {
    requestId: 1,
    items: [{ id: 'copy-name', label: '复制分支名', enabled: true }],
  }
  await exposed.gitkContextMenu.popup(contextRequest)
  assert.deepEqual(calls.at(-1), ['gitk:context-menu:popup', contextRequest])
  await exposed.gitkContextMenu.close(1)
  assert.deepEqual(calls.at(-1), ['gitk:context-menu:close', 1])
  assert.equal(exposed.gitkApp.invoke, undefined)
  await exposed.gitkApp.edit('copy')
  assert.deepEqual(calls.at(-1), ['gitk:app:edit', 'copy'])
  let command, closeRequest
  const stopCommands = exposed.gitkApp.onCommand((value) => {
    command = value
  })
  const stopClose = exposed.gitkApp.onCloseRequested((value) => {
    closeRequest = value
  })
  listeners.get('gitk:app-command')({ secret: true }, 'file.open')
  listeners.get('gitk:close-request')({ secret: true }, -1)
  assert.equal(closeRequest, undefined)
  listeners.get('gitk:close-request')({ secret: true }, 3)
  assert.equal(command, 'file.open')
  assert.equal(closeRequest, 3)
  stopCommands()
  stopClose()
  assert.equal(await exposed.gitkWindow.isMaximized(), true)
  let event
  const unsubscribe = await exposed.gitkWindow.onFocusChanged((value) => {
    event = value
  })
  listeners.get('gitk:window-state')({ secretElectronEvent: true }, { focused: false })
  assert.equal(event.payload, false)
  assert.equal(event.secretElectronEvent, undefined)
  unsubscribe()
  assert.equal(listeners.size, 0)
})

test('IPC rejects foreign windows, subframes and untrusted origins', () => {
  const frame = { url: 'http://localhost:43187/' },
    contents = { mainFrame: frame }
  const window = { isDestroyed: () => false, webContents: contents }
  const options = { development: true, indexUrl: 'file:///app/dist/index.html' }
  assert.doesNotThrow(() => assertSender({ sender: contents, senderFrame: frame }, window, options))
  assert.throws(() => assertSender({ sender: {}, senderFrame: frame }, window, options))
  assert.throws(() =>
    assertSender({ sender: contents, senderFrame: { url: frame.url } }, window, options),
  )
  frame.url = 'https://attacker.example/'
  assert.throws(() => assertSender({ sender: contents, senderFrame: frame }, window, options))
  assert.equal(allowedNavigation('http://localhost:43187.attacker.example/', options), false)
  assert.equal(
    allowedNavigation('file:///app/dist/index.html', { ...options, development: false }),
    true,
  )
  assert.equal(allowedNavigation('file:///etc/passwd', { ...options, development: false }), false)
})

test('production file aliases resolve to the trusted entry without allowing other files or UNC hosts', (t) => {
  const os = require('node:os'),
    path = require('node:path'),
    { pathToFileURL } = require('node:url')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-trusted-entry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const real = path.join(directory, 'real'),
    alias = path.join(directory, 'alias')
  fs.mkdirSync(real)
  fs.writeFileSync(path.join(real, 'index.html'), 'trusted')
  fs.writeFileSync(path.join(real, 'other.html'), 'untrusted')
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const options = {
    development: false,
    indexUrl: pathToFileURL(path.join(real, 'index.html')).href,
  }
  assert.equal(
    allowedNavigation(pathToFileURL(path.join(alias, 'index.html')).href + '#route', options),
    true,
  )
  assert.equal(allowedNavigation(pathToFileURL(path.join(real, 'other.html')).href, options), false)
  assert.equal(allowedNavigation(options.indexUrl + '?page=other', options), false)
  assert.equal(allowedNavigation('file://untrusted.example/share/index.html', options), false)
  assert.equal(allowedNavigation('https://untrusted.example/index.html', options), false)
})
