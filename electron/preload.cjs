'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, ...args) => ipcRenderer.invoke(`gitk:${name}`, ...args)
const observeWindow = (callback) => {
  const listener = (_event, state) => callback(state)
  ipcRenderer.on('gitk:window-state', listener)
  return () => ipcRenderer.removeListener('gitk:window-state', listener)
}

// Only named, narrow operations cross the isolated renderer boundary.
// Neither ipcRenderer nor Node's require / filesystem are exposed.
contextBridge.exposeInMainWorld('gitk', {
  navigationRead: (repo, request) => invoke('navigation-read', repo, request),
  mergeRead: (repo, file) => invoke('merge-read', repo, file),
  stashRead: (repo, oid, file) => invoke('stash-read', repo, oid, file),
  selectedCommitPlan: (repo, request) => invoke('selected-commit-plan', repo, request),
  runtime: () => invoke('runtime'),
  gitflowPlan: (repo, request) => invoke('gitflow-plan', repo, request),
  syncPlan: (repo, kind, expected) => invoke('sync-plan', repo, kind, expected),
  snapshot: (repo) => invoke('snapshot', repo),
  commit: (repo, commit) => invoke('commit', repo, commit),
  diff: (repo, file, staged, commit) => invoke('diff', repo, file, staged, commit),
  action: (repo, request) => invoke('action', repo, request),
  create: (kind, target, url) => invoke('create', { kind, path: target, url }),
  chooseDirectory: (initial) => invoke('choose-directory', initial),
  listDirectory: (initial) => invoke('directory', initial),
  cancel: () => invoke('cancel'),
  openResource: (resource) => invoke('resource', resource),
})
contextBridge.exposeInMainWorld('gitkContextMenu', {
  popup: (request) => invoke('context-menu:popup', request),
  close: (requestId) => invoke('context-menu:close', requestId),
})
contextBridge.exposeInMainWorld('gitkWindow', {
  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:maximize'),
  close: () => invoke('window:close'),
  isMaximized: async () => (await invoke('window:state')).maximized,
  isFullscreen: async () => (await invoke('window:state')).fullscreen,
  isFocused: async () => (await invoke('window:state')).focused,
  onResized: async (callback) => observeWindow(() => callback()),
  onFocusChanged: async (callback) =>
    observeWindow((state) => callback({ payload: state.focused })),
})

const observeApplication = (channel, handler, valid) => {
  const listener = (_event, value) => {
    if (valid(value)) handler(value)
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
contextBridge.exposeInMainWorld('gitkApp', {
  setMenuState: (state) => invoke('app:menu-state', state),
  edit: (command) => invoke('app:edit', command),
  requestQuit: () => invoke('app:quit'),
  acknowledgeClose: (id) => invoke('app:close-ack', id),
  approveClose: (id) => invoke('app:close-approve', id),
  cancelClose: (id) => invoke('app:close-cancel', id),
  info: () => invoke('app:info'),
  onCommand: (handler) =>
    observeApplication('gitk:app-command', handler, (value) => typeof value === 'string'),
  onCloseRequested: (handler) =>
    observeApplication(
      'gitk:close-request',
      handler,
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
})
