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
  assert.equal(exposed.gitcode.invoke, undefined)
  assert.equal(exposed.gitcode.require, undefined)
  await exposed.gitcode.gitConsole('/repo', { action: 'read', cursor: 0 })
  assert.deepEqual(calls.pop(), ['gitcode:git-console', '/repo', { action: 'read', cursor: 0 }])
  await exposed.gitcode.terminal('/repo', { action: 'shells' })
  assert.deepEqual(calls.pop(), ['gitcode:terminal', '/repo', { action: 'shells' }])
  assert.equal(exposed.gitcodeWindow.require, undefined)
  assert.equal(exposed.gitcodeWindow.platform, 'win32')
  await exposed.gitcode.chooseDirectory('/projects', 'parent')
  assert.deepEqual(calls.pop(), ['gitcode:choose-directory', '/projects', 'parent'])
  await exposed.gitcodeApp.installedFonts()
  assert.deepEqual(calls.pop(), ['gitcode:app:fonts'])
  assert.equal(exposed.gitcodeWindow.nativeControls, true)
  await exposed.gitcodeApp.repositoryLocation('/repo', 'show-folder')
  assert.deepEqual(calls.pop(), ['gitcode:app:repository-location', '/repo', 'show-folder'])
  await exposed.gitcode.historyMetadata('/repo', 'a'.repeat(40))
  assert.deepEqual(calls.pop(), ['gitcode:history-metadata', '/repo', 'a'.repeat(40)])
  await exposed.gitcode.historyRead('/repo', { token: 'history', offset: 250 })
  assert.deepEqual(calls.pop(), [
    'gitcode:history-read',
    '/repo',
    { token: 'history', offset: 250 },
  ])
  await exposed.gitcode.repositoryTrust('/repo')
  assert.deepEqual(calls.pop(), ['gitcode:repository-trust', '/repo'])
  await exposed.gitcode.approveRepositoryTrust('/repo', 'token')
  assert.deepEqual(calls.pop(), ['gitcode:repository-trust-approve', '/repo', 'token'])
  await exposed.gitcode.partialStageRead('/repo', { file: 'file.txt', source: 'unstaged' })
  assert.deepEqual(calls.pop(), [
    'gitcode:partial-stage-read',
    '/repo',
    { file: 'file.txt', source: 'unstaged' },
  ])
  await exposed.gitcode.fetchSettingsRead('/repo')
  assert.deepEqual(calls.pop(), ['gitcode:fetch-settings-read', '/repo'])
  await exposed.gitcode.recoveryRead('/repo')
  assert.deepEqual(calls.pop(), ['gitcode:recovery-read', '/repo'])
  await exposed.gitcode.repositoryChanges('/repo')
  assert.deepEqual(calls.pop(), ['gitcode:repository-changes', '/repo'])
  await exposed.gitcode.refreshReferences('/repo', 'a'.repeat(64))
  assert.deepEqual(calls.pop(), ['gitcode:refresh-references', '/repo', 'a'.repeat(64)])
  await exposed.gitcode.backgroundSnapshot('/repo', null)
  assert.deepEqual(calls.pop(), ['gitcode:background-snapshot', '/repo', null])
  await exposed.gitcodeApp.startupPhase('ready')
  assert.deepEqual(calls.pop(), ['gitcode:app:startup-phase', 'ready'])
  await exposed.gitcodeApp.flushDraftStorage()
  assert.deepEqual(calls.pop(), ['gitcode:app:flush-draft-storage'])
  await exposed.gitcode.activity()
  assert.deepEqual(calls.pop(), ['gitcode:activity'])
  await exposed.gitcode.activitySettings({ autoFetchInterval: 0, extended: false })
  assert.deepEqual(calls.pop(), [
    'gitcode:activity-settings',
    { autoFetchInterval: 0, extended: false },
  ])
  await exposed.gitcode.operationLog({ scope: 'repository', repo: '/qa' })
  assert.deepEqual(calls.pop(), ['gitcode:operation-log', { scope: 'repository', repo: '/qa' }])
  await exposed.gitcode.clearOperationLog({ scope: 'application' })
  assert.deepEqual(calls.pop(), ['gitcode:operation-log-clear', { scope: 'application' }])
  await exposed.gitcode.automaticFetch('/qa')
  assert.deepEqual(calls.pop(), ['gitcode:auto-fetch', '/qa'])
  await exposed.gitcode.fetchStatus('/qa')
  assert.deepEqual(calls.pop(), ['gitcode:fetch-status', '/qa'])
  await exposed.gitcode.gitSettings({ mode: 'system' })
  assert.deepEqual(calls.pop(), ['gitcode:git-settings', { mode: 'system' }])
  await exposed.gitcode.refreshGitRuntime()
  assert.deepEqual(calls.pop(), ['gitcode:git-runtime-refresh'])
  await exposed.gitcode.chooseGit()
  assert.deepEqual(calls.pop(), ['gitcode:choose-git'])
  await exposed.gitcode.openResource('git-install')
  assert.deepEqual(calls.pop(), ['gitcode:resource', 'git-install'])
  await exposed.gitcode.snapshot('/repo')
  await exposed.gitcode.action('/repo', { action: 'stage', paths: ['a'] })
  await exposed.gitcode.listDirectory('/home')
  assert.deepEqual(calls, [
    ['gitcode:snapshot', '/repo'],
    ['gitcode:action', '/repo', { action: 'stage', paths: ['a'] }],
    ['gitcode:directory', '/home'],
  ])
  await exposed.gitcode.rebaseMenuRead('/repo', { head: 'a'.repeat(40), oid: 'b'.repeat(40) })
  assert.deepEqual(calls.at(-1), [
    'gitcode:rebase-menu-read',
    '/repo',
    { head: 'a'.repeat(40), oid: 'b'.repeat(40) },
  ])
  await exposed.gitcode.navigationRead('/repo', {
    kind: 'info',
    fullRef: 'refs/heads/main',
    expectedOid: 'abc',
  })
  assert.deepEqual(calls.at(-1), [
    'gitcode:navigation-read',
    '/repo',
    { kind: 'info', fullRef: 'refs/heads/main', expectedOid: 'abc' },
  ])
  await exposed.gitcode.stashRead('/repo', 'abc', 'src/a.txt')
  assert.deepEqual(calls.at(-1), ['gitcode:stash-read', '/repo', 'abc', 'src/a.txt'])
  await exposed.gitcode.syncPlan('/repo', 'push', { expectedHead: 'abc', expectedBranch: 'main' })
  assert.deepEqual(calls.at(-1), [
    'gitcode:sync-plan',
    '/repo',
    'push',
    { expectedHead: 'abc', expectedBranch: 'main' },
  ])
  await exposed.gitcode.gitflowPlan('/repo', { config: { production: 'main' }, sources: {} })
  assert.deepEqual(calls.at(-1), [
    'gitcode:gitflow-plan',
    '/repo',
    { config: { production: 'main' }, sources: {} },
  ])
  await exposed.gitcode.selectedCommitPlan('/repo', {
    expectedHead: 'abc',
    expectedBranch: 'main',
    paths: ['src/a.txt'],
  })
  assert.deepEqual(calls.at(-1), [
    'gitcode:selected-commit-plan',
    '/repo',
    { expectedHead: 'abc', expectedBranch: 'main', paths: ['src/a.txt'] },
  ])
  assert.equal(exposed.gitcodeContextMenu.invoke, undefined)
  const contextRequest = {
    requestId: 1,
    items: [{ id: 'copy-name', label: '复制分支名', enabled: true }],
  }
  await exposed.gitcodeContextMenu.popup(contextRequest)
  assert.deepEqual(calls.at(-1), ['gitcode:context-menu:popup', contextRequest])
  await exposed.gitcodeContextMenu.close(1)
  assert.deepEqual(calls.at(-1), ['gitcode:context-menu:close', 1])
  assert.equal(exposed.gitcodeApp.invoke, undefined)
  await exposed.gitcodeApp.edit('copy')
  assert.deepEqual(calls.at(-1), ['gitcode:app:edit', 'copy'])
  let command, closeRequest
  const stopCommands = exposed.gitcodeApp.onCommand((value) => {
    command = value
  })
  const stopClose = exposed.gitcodeApp.onCloseRequested((value) => {
    closeRequest = value
  })
  listeners.get('gitcode:app-command')({ secret: true }, 'file.open')
  listeners.get('gitcode:close-request')({ secret: true }, -1)
  assert.equal(closeRequest, undefined)
  listeners.get('gitcode:close-request')({ secret: true }, 3)
  assert.equal(command, 'file.open')
  assert.equal(closeRequest, 3)
  stopCommands()
  stopClose()
  assert.equal(await exposed.gitcodeWindow.isMaximized(), true)
  let event
  const unsubscribe = await exposed.gitcodeWindow.onFocusChanged((value) => {
    event = value
  })
  listeners.get('gitcode:window-state')({ secretElectronEvent: true }, { focused: false })
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
