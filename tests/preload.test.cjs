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
  assert.equal(exposed.gitkWindow.require, undefined)
  await exposed.gitk.snapshot('/repo')
  await exposed.gitk.action('/repo', { action: 'stage', paths: ['a'] })
  await exposed.gitk.listDirectory('/home')
  assert.deepEqual(calls, [
    ['gitk:snapshot', '/repo'],
    ['gitk:action', '/repo', { action: 'stage', paths: ['a'] }],
    ['gitk:directory', '/home'],
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
