'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name, ...args) => ipcRenderer.invoke(`gitcode:${name}`, ...args)
const observeWindow = (callback) => {
  const listener = (_event, state) => callback(state)
  ipcRenderer.on('gitcode:window-state', listener)
  return () => ipcRenderer.removeListener('gitcode:window-state', listener)
}

// Only named, narrow operations cross the isolated renderer boundary.
// Neither ipcRenderer nor Node's require / filesystem are exposed.
contextBridge.exposeInMainWorld('gitcode', {
  gitConsole: (repo, request) => invoke('git-console', repo, request),
  terminal: (repo, request) => invoke('terminal', repo, request),
  historyMetadata: (repo, sha) => invoke('history-metadata', repo, sha),
  historyTools: (repo, request) => invoke('history-tools', repo, request),
  historyRead: (repo, request) => invoke('history-read', repo, request),
  repositoryTrust: (repo) => invoke('repository-trust', repo),
  approveRepositoryTrust: (repo, token) => invoke('repository-trust-approve', repo, token),
  partialStageRead: (repo, request) => invoke('partial-stage-read', repo, request),
  recoveryRead: (repo) => invoke('recovery-read', repo),
  repositoryChanges: (repo) => invoke('repository-changes', repo),
  backgroundSnapshot: (repo, request) => invoke('background-snapshot', repo, request),
  rebaseMenuRead: (repo, request) => invoke('rebase-menu-read', repo, request),
  navigationRead: (repo, request) => invoke('navigation-read', repo, request),
  commitOperationRead: (repo, request) => invoke('commit-operation-read', repo, request),
  openCommit: (repo, request, remote) => invoke('open-commit', repo, request, remote),
  mergeRead: (repo, file) => invoke('merge-read', repo, file),
  stashRead: (repo, oid, file) => invoke('stash-read', repo, oid, file),
  selectedCommitPlan: (repo, request) => invoke('selected-commit-plan', repo, request),
  activity: () => invoke('activity'),
  operationLog: (request) => invoke('operation-log', request),
  clearOperationLog: (request) => invoke('operation-log-clear', request),
  activitySettings: (value) => invoke('activity-settings', value),
  automaticFetch: (repo) => invoke('auto-fetch', repo),
  fetchStatus: (repo) => invoke('fetch-status', repo),
  runtime: () => invoke('runtime'),
  gitSettings: (value) => invoke('git-settings', value),
  refreshGitRuntime: () => invoke('git-runtime-refresh'),
  chooseGit: () => invoke('choose-git'),
  gitflowPlan: (repo, request) => invoke('gitflow-plan', repo, request),
  fetchSettingsRead: (repo) => invoke('fetch-settings-read', repo),
  syncPlan: (repo, kind, expected) => invoke('sync-plan', repo, kind, expected),
  snapshot: (repo) => invoke('snapshot', repo),
  refreshReferences: (repo, signature) => invoke('refresh-references', repo, signature),
  commit: (repo, commit) => invoke('commit', repo, commit),
  diff: (repo, file, staged, commit) => invoke('diff', repo, file, staged, commit),
  action: (repo, request) => invoke('action', repo, request),
  create: (kind, target, url) => invoke('create', { kind, path: target, url }),
  chooseDirectory: (initial, purpose) => invoke('choose-directory', initial, purpose),
  listDirectory: (initial) => invoke('directory', initial),
  cancel: () => invoke('cancel'),
  openResource: (resource) => invoke('resource', resource),
})
contextBridge.exposeInMainWorld('gitcodeContextMenu', {
  popup: (request) => invoke('context-menu:popup', request),
  close: (requestId) => invoke('context-menu:close', requestId),
})
contextBridge.exposeInMainWorld('gitcodeWindow', {
  platform: process.platform,
  nativeControls: process.platform === 'win32',
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
contextBridge.exposeInMainWorld('gitcodeApp', {
  installedFonts: () => invoke('app:fonts'),
  repositoryLocation: (repo, action) => invoke('app:repository-location', repo, action),
  startupPhase: (phase) => invoke('app:startup-phase', phase),
  flushDraftStorage: () => invoke('app:flush-draft-storage'),
  setMenuState: (state) => invoke('app:menu-state', state),
  edit: (command) => invoke('app:edit', command),
  requestQuit: () => invoke('app:quit'),
  acknowledgeClose: (id) => invoke('app:close-ack', id),
  approveClose: (id) => invoke('app:close-approve', id),
  cancelClose: (id) => invoke('app:close-cancel', id),
  info: () => invoke('app:info'),
  onCommand: (handler) =>
    observeApplication('gitcode:app-command', handler, (value) => typeof value === 'string'),
  onCloseRequested: (handler) =>
    observeApplication(
      'gitcode:close-request',
      handler,
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
})
