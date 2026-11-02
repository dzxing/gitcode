'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { GitService } = require('./git.cjs')
const { isCommand, editCommands, sanitizeState, buildMenuTemplate } = require('./menus.cjs')
const { CloseCoordinator } = require('./close-coordinator.cjs')
const { allowedNavigation, assertSender } = require('./security.cjs')

const root = path.resolve(__dirname, '..')
const development =
  !app.isPackaged &&
  (process.env.GITCODE_DEV_URL || process.env.GITK_DEV_URL) === 'http://localhost:43187'
const indexUrl = pathToFileURL(path.join(root, 'dist', 'index.html')).href
const git = new GitService()
let mainWindow = null
let quitting = false
const closing = new CloseCoordinator({
  send: (id) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('gitk:close-request', id)
  },
  fallback: async () => {
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '退出 GitCode',
      message: '界面未响应，无法确认说明草稿和任务状态。',
      detail: '退出可能丢失尚未保存的说明草稿，并中止正在运行的 Git 操作；取消不等于回滚。',
      buttons: ['留在应用', '退出 GitCode'],
      defaultId: 0,
      cancelId: 0,
    })
    return response.response === 1
  },
  finish: async () => {
    quitting = true
    await git.shutdown()
    app.quit()
  },
})
function sendCommand(id) {
  if (!isCommand(id)) return
  if (id === 'file.quit') closing.request()
  else if (mainWindow && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('gitk:app-command', id)
}

app.setName('GitCode')
// Reuse an existing pre-rename profile rather than copying a live Chromium profile.
const appData = app.getPath('appData')
if (!fs.existsSync(path.join(appData, 'GitCode'))) {
  const previousProfile = ['GitK', 'gitk-workbench']
    .map((name) => path.join(appData, name))
    .find((location) => {
      try {
        return fs.statSync(location).isDirectory()
      } catch {
        return false
      }
    })
  if (previousProfile) {
    app.setPath('userData', previousProfile)
    app.setPath('sessionData', previousProfile)
  }
}
if (process.platform === 'win32') app.setAppUserModelId('dev.gitcode.workbench')
if ((process.env.GITCODE_SOFTWARE_RENDERING || process.env.GITK_SOFTWARE_RENDERING) === '1') {
  app.disableHardwareAcceleration()
  if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11')
}

function authorized(event) {
  assertSender(event, mainWindow, { development, indexUrl })
}

function handle(name, work) {
  ipcMain.handle(`gitk:${name}`, async (event, ...args) => {
    authorized(event)
    return work(...args)
  })
}

function registerHandlers() {
  handle('app:menu-state', (value) => {
    const state = sanitizeState(value)
    if (process.platform === 'darwin')
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(buildMenuTemplate(state, sendCommand, 'darwin')),
      )
  })
  handle('app:edit', (command) => {
    if (!editCommands.has(command)) throw new Error('不支持的文本编辑操作。')
    mainWindow.webContents[command]()
  })
  handle('app:quit', () => closing.request())
  handle('app:close-ack', (id) => closing.acknowledge(id))
  handle('app:close-approve', (id) => closing.approve(id))
  handle('app:close-cancel', (id) => closing.cancel(id))
  handle('app:info', () => ({
    name: 'GitCode',
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  }))
  handle('runtime', () => git.runtime())
  handle('gitflow-plan', (repo, request) =>
    git.job(async (signal) => git.flow.plan(await git.repository(repo, signal), request, signal)),
  )
  handle('selected-commit-plan', (repo, request) =>
    git.job(async (signal) =>
      git.selectedCommitPlan(await git.repository(repo, signal), request, signal),
    ),
  )
  handle('sync-plan', (repo, kind, expected) =>
    git.job(async (signal) =>
      git.syncPlan(await git.repository(repo, signal), kind, expected, signal),
    ),
  )
  handle('merge-read', (repo, file) =>
    git.job(async (signal) => git.merge.read(await git.repository(repo, signal), file, signal)),
  )
  handle('stash-read', (repo, oid, file) =>
    git.job(async (signal) =>
      git.stash.read(await git.repository(repo, signal), oid, file, signal),
    ),
  )
  handle('snapshot', (repo) =>
    git.job(async (signal) => git.snapshot(await git.repository(repo, signal), signal)),
  )
  handle('commit', (repo, commit) =>
    git.job(async (signal) =>
      git.commitDetails(await git.repository(repo, signal), commit, signal),
    ),
  )
  handle('diff', (repo, file, staged, commit) =>
    git.job(async (signal) =>
      git.diff(await git.repository(repo, signal), file, staged, commit, signal),
    ),
  )
  handle('action', (repo, request) =>
    git.job(async (signal) => git.action(await git.repository(repo, signal), request, signal)),
  )
  handle('create', (request) => git.job((signal) => git.create(request, signal)))
  handle('cancel', () => git.cancel())
  handle('directory', (value) => git.listDirectory(value))
  handle('choose-directory', async (initialPath) => {
    const options = { title: '选择仓库或父目录', properties: ['openDirectory'] }
    if (typeof initialPath === 'string' && path.isAbsolute(initialPath))
      options.defaultPath = initialPath
    else if (git.lastDirectory) options.defaultPath = git.lastDirectory
    const result = await dialog.showOpenDialog(mainWindow, options)
    if (result.canceled || !result.filePaths[0]) return null
    git.lastDirectory = result.filePaths[0]
    return result.filePaths[0]
  })
  handle('resource', async (resource) => {
    const url =
      resource === 'git-docs'
        ? 'https://git-scm.com/docs'
        : resource === 'git-book'
          ? 'https://git-scm.com/book/zh/v2'
          : null
    if (!url) throw new Error('未知的帮助资源。')
    await shell.openExternal(url)
  })
  handle('window:minimize', () => mainWindow.minimize())
  handle('window:maximize', () =>
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(),
  )
  handle('window:close', () => closing.request())
  handle('window:state', () => ({
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
    focused: mainWindow.isFocused(),
  }))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'GitCode',
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#1e2025',
    show: false,
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 12 } }
      : {}),
    resizable: true,
    roundedCorners: true,
    hasShadow: true,
    icon: path.join(root, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, value) => {
    if (!allowedNavigation(value, { development, indexUrl })) event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${development ? ' ws://localhost:43187 http://localhost:43187' : ''}; object-src 'none'; base-uri 'self'; frame-src 'none'`
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  const state = () => {
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('gitk:window-state', {
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen(),
        focused: mainWindow.isFocused(),
      })
  }
  for (const event of [
    'resize',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
    'focus',
    'blur',
  ])
    mainWindow.on(event, state)
  mainWindow.webContents.on('render-process-gone', () => closing.rendererGone())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) {
      console.error(`[GitCode] 页面加载失败 (${code}): ${description} ${url}`)
      mainWindow.show()
    }
  })
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    closing.request()
  })
  if (development)
    mainWindow.loadURL('http://localhost:43187').catch((error) => console.error(error.message))
  else
    mainWindow
      .loadFile(path.join(root, 'dist', 'index.html'))
      .catch((error) => console.error(error.message))
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    closing.request()
  })
  app.on('window-all-closed', () => app.quit())
  app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(
        process.platform === 'darwin'
          ? Menu.buildFromTemplate(
              buildMenuTemplate(
                sanitizeState({ enabled: ['help.about', 'file.quit'], recent: [] }),
                sendCommand,
                'darwin',
              ),
            )
          : null,
      )
      registerHandlers()
      createWindow()
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
