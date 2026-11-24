'use strict'
const appStartedAt = Date.now()

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeTheme,
  screen,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { GitService } = require('./git.cjs')
const gitRuntime = require('./git-runtime.cjs')
const { isCommand, editCommands, sanitizeState, buildMenuTemplate } = require('./menus.cjs')
const { ContextMenus } = require('./context-menu.cjs')
const { CloseCoordinator } = require('./close-coordinator.cjs')
const { ApplicationLifecycle } = require('./lifecycle.cjs')
const { allowedNavigation, assertSender } = require('./security.cjs')
const { WindowState } = require('./window-state.cjs')
const { WindowAppearance, windowColors } = require('./window-appearance.cjs')
const { WindowRecovery } = require('./window-recovery.cjs')
const { repositoryLocation } = require('./repository-location.cjs')
const { installedFonts } = require('./fonts.cjs')
const { TerminalService } = require('./terminal.cjs')

const root = fs.realpathSync(path.resolve(__dirname, '..'))
const development =
  !app.isPackaged &&
  (process.env.GITCODE_DEV_URL || process.env.GITK_DEV_URL) === 'http://localhost:43187'
const indexUrl = pathToFileURL(path.join(root, 'dist', 'index.html')).href
const contextMenus = new ContextMenus(Menu)
let mainWindow = null
let windowAppearance = null
let quitting = false
const closing = new CloseCoordinator({
  send: (id) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('gitcode:close-request', id)
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
    const record = git.journal.start('application-exit', '')
    await git.shutdown()
    git.journal.finish(record, { output: '已完成 Git 任务收尾并等待活动日志写入。' })
    await git.journal.writes
    app.quit()
  },
})
function sendCommand(id) {
  if (!isCommand(id)) return
  if (id === 'file.quit') closing.request()
  else if (mainWindow && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send('gitcode:app-command', id)
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
const gitSettingsFile = path.join(app.getPath('userData'), 'git-runtime.json')
const git = new GitService({
  enforceRepositoryTrust: true,
  dataDirectory: app.getPath('userData'),
  resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  selection: gitRuntime.readPreference(gitSettingsFile),
})
let selectingGit = false
const lifecycle = new ApplicationLifecycle(git.journal, Date.now, appStartedAt)

if (process.platform === 'win32') app.setAppUserModelId('dev.gitcode.workbench')
if ((process.env.GITCODE_SOFTWARE_RENDERING || process.env.GITK_SOFTWARE_RENDERING) === '1') {
  app.disableHardwareAcceleration()
  if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11')
}

function authorized(event) {
  assertSender(event, mainWindow, { development, indexUrl })
}

function handle(name, work) {
  ipcMain.handle(`gitcode:${name}`, async (event, ...args) => {
    authorized(event)
    return git.wsl ? git.wsl.route(name, args, () => work(...args)) : work(...args)
  })
}

function registerHandlers() {
  handle('git-console', (repo, request) => git.console.read(repo, request))
  handle('terminal', (repo, request) => git.terminal.request(repo, request))
  handle('app:fonts', () => installedFonts())
  handle('partial-stage-read', (repo, request) =>
    git.job(async (signal) =>
      git.partialStage.read(await git.repository(repo, signal), request, signal),
    ),
  )
  handle('recovery-read', (repo) =>
    git.job(async (signal) => git.recovery.read(await git.repository(repo, signal), signal)),
  )
  handle('repository-changes', (repo) => git.repositoryWatch.status(repo))
  handle('background-snapshot', (repo, request) => git.repositoryWatch.read(repo, request))
  handle('app:startup-phase', (phase) => lifecycle.stage(phase))
  handle('context-menu:popup', (request) => contextMenus.popup(mainWindow, request))
  handle('context-menu:close', (requestId) => {
    if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error('无效的菜单请求。')
    contextMenus.close(requestId)
  })
  handle('app:menu-state', (value) => {
    const state = sanitizeState(value)
    if (nativeTheme.themeSource !== state.theme) nativeTheme.themeSource = state.theme
    windowAppearance?.apply(state.palette)
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
  handle('app:flush-draft-storage', () => mainWindow.webContents.session.flushStorageData())
  handle('app:info', () => ({
    name: 'GitCode',
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  }))
  handle('operation-log', (request) => git.journal.read(request))
  handle('operation-log-clear', (request) => git.journal.clear(request))
  handle('repository-trust', (repo) => git.job((signal) => git.trust.inspect(repo, signal)))
  handle('repository-trust-approve', (repo, token) =>
    git.job((signal) => git.trust.approve(repo, token, signal)),
  )
  handle('activity-settings', (value) => git.journal.preferences(value))
  handle('auto-fetch', (repo) => git.automaticFetch(repo))
  handle('fetch-status', (repo) => {
    if (typeof repo !== 'string' || repo.length > 32768) throw new Error('无效的仓库路径。')
    return git.journal.status(repo)
  })
  handle('activity', () => git.activity)
  handle('runtime', () => git.runtime())
  handle('git-runtime-refresh', async () => {
    await git.retryRuntime()
    return git.runtimeSettings()
  })
  handle('git-settings', async (value) => {
    if (value === undefined) return git.runtimeSettings()
    return git.configureRuntime(value, (selection) =>
      gitRuntime.writePreference(gitSettingsFile, selection),
    )
  })
  handle('choose-git', async () => {
    if (selectingGit) return null
    selectingGit = true
    try {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Git 可执行文件',
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? { filters: [{ name: 'Git', extensions: ['exe'] }] }
          : {}),
      })
      return selected.canceled ? null : selected.filePaths[0] || null
    } finally {
      selectingGit = false
    }
  })
  handle('gitflow-plan', (repo, request) =>
    git.job(async (signal) => git.flow.plan(await git.repository(repo, signal), request, signal)),
  )
  handle('selected-commit-plan', (repo, request) =>
    git.job(async (signal) =>
      git.selectedCommitPlan(await git.repository(repo, signal), request, signal),
    ),
  )
  handle('fetch-settings-read', (repo) =>
    git.job(async (signal) => git.fetchSettings.read(await git.repository(repo, signal), signal)),
  )
  handle('sync-plan', (repo, kind, expected) =>
    git.job(async (signal) =>
      git.syncPlan(await git.repository(repo, signal), kind, expected, signal),
    ),
  )
  handle('rebase-menu-read', (repo, request) =>
    git.job(
      async (signal) => git.rebase.menu(await git.repository(repo, signal), request, signal),
      { background: true },
    ),
  )
  handle('navigation-read', (repo, request) =>
    git.job(async (signal) =>
      git.navigation.read(await git.repository(repo, signal), request, signal),
    ),
  )
  handle('commit-operation-read', (repo, request) =>
    git.job(async (signal) =>
      git.commitOperations.read(await git.repository(repo, signal), request, signal),
    ),
  )
  handle('open-commit', async (repo, request, remote) => {
    const result = git.wsl?.isRepository(repo)
      ? await git.wsl.route(
          'commit-operation-read',
          [repo, { ...request, kind: 'hosting' }],
          () => {},
        )
      : await git.job(async (signal) =>
          git.commitOperations.read(
            await git.repository(repo, signal),
            { ...request, kind: 'hosting' },
            signal,
          ),
        )
    const entry = result.urls?.find((link) => link.name === remote)
    if (!entry) throw Error('托管地址已变化，请重新读取。')
    await shell.openExternal(entry.url)
  })
  handle('merge-read', (repo, file) =>
    git.job(async (signal) => git.merge.read(await git.repository(repo, signal), file, signal)),
  )
  handle('stash-read', (repo, oid, file) =>
    git.job(async (signal) =>
      git.stash.read(await git.repository(repo, signal), oid, file, signal),
    ),
  )
  handle('history-metadata', (repo, sha) =>
    git.job(
      async (signal) => git.history.metadata(await git.repository(repo, signal), sha, signal),
      { background: true },
    ),
  )
  handle('history-tools', (repo, request) => git.historyTools.request(repo, request))
  handle('history-read', (repo, request) =>
    git.job(
      async (signal) => git.history.read(await git.repository(repo, signal), request, signal),
      { background: true },
    ),
  )
  handle('snapshot', (repo) =>
    git.job(async (signal) => git.snapshot(await git.repository(repo, signal), signal)),
  )
  handle('refresh-references', (repo, signature) =>
    git.job(async (signal) =>
      git.refreshReferences(await git.repository(repo, signal), signature, signal),
    ),
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
  handle('choose-directory', async (initialPath, purpose = 'repository') => {
    if (!['repository', 'parent'].includes(purpose)) throw Error('无效的目录选择用途。')
    const options = {
      title: purpose === 'parent' ? '选择仓库位置' : '打开 Git 仓库',
      buttonLabel: purpose === 'parent' ? '选择文件夹' : '打开',
      properties: ['openDirectory'],
    }
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
          : resource === 'git-install'
            ? `https://git-scm.com/install/${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'}`
            : null
    if (!url) throw new Error('未知的帮助资源。')
    await shell.openExternal(url)
  })
  handle('window:minimize', () => mainWindow.minimize())
  handle('app:repository-location', async (repo, action) => {
    if (!git.wsl?.isRepository(repo)) return repositoryLocation(git, shell, clipboard, repo, action)
    if (!['copy-path', 'show-folder'].includes(action)) throw Error('不支持的仓库位置操作。')
    const { parseWslPath, toUnc } = require('./wsl-path.cjs')
    const { distribution, linuxPath } = parseWslPath(repo)
    const root = toUnc(
      distribution,
      await git.wsl.invoke(distribution, 'canonical-repository', [linuxPath]),
    )
    if (action === 'copy-path') clipboard.writeText(root)
    else shell.showItemInFolder(root)
  })
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
  const initialColors = windowColors('dark')
  const windowState = new WindowState(
    path.join(app.getPath('userData'), 'window-state.json'),
    screen,
  )
  const restoreMaximized = windowState.saved?.maximized === true
  const initialWindowBounds = windowState.options()
  mainWindow = new BrowserWindow({
    title: 'GitCode',
    ...initialWindowBounds,
    backgroundColor: initialColors.background,
    show: false,
    frame: process.platform !== 'linux',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: initialColors.color,
            symbolColor: initialColors.symbolColor,
            // Keep the titlebar's bottom 1px border below the native caption overlay.
            height: 37,
          },
        }
      : {}),
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
  windowAppearance = new WindowAppearance(mainWindow)
  const loadRenderer = () =>
    development
      ? mainWindow.loadURL('http://localhost:43187')
      : mainWindow.loadFile(path.join(root, 'dist', 'index.html'))
  const recovery = new WindowRecovery({
    window: mainWindow,
    dialog,
    reload: loadRenderer,
    openLogs: () => shell.openPath(app.getPath('userData')),
    isClosing: () => quitting,
    record: (kind, detail) => {
      const entry = git.journal.start('application-interface', '')
      git.journal.finish(entry, { outcome: 'failed', error: `界面异常：${kind}`, output: detail })
    },
  })
  const windowLayout = windowState.track(mainWindow)
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
    windowAppearance.apply()
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('gitcode:window-state', {
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
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const previous = git.terminal
    git.terminal = new TerminalService(git)
    void previous.shutdown()
    contextMenus.close()
    closing.rendererGone()
    void recovery.recover('crash', `原因：${details.reason}；退出码：${details.exitCode}`)
  })
  mainWindow.on('unresponsive', () => {
    void recovery.recover('unresponsive')
  })
  mainWindow.webContents.on('did-start-loading', () => contextMenus.close())
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return
    const previous = git.terminal
    git.terminal = new TerminalService(git)
    void previous.shutdown()
  })
  mainWindow.on('closed', () => contextMenus.close())
  mainWindow.once('ready-to-show', () => {
    if (restoreMaximized) {
      windowLayout.restore(initialWindowBounds)
      mainWindow.maximize()
    }
    mainWindow.show()
    if (!restoreMaximized) windowLayout.restore(initialWindowBounds)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      console.error(`[GitCode] 页面加载失败 (${code}): ${description} ${url}`)
      void recovery.recover('load', `错误代码：${code}；${description}`)
    }
  })
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    closing.request()
  })
  loadRenderer().catch((error) => {
    console.error(error.message)
    if (error.code !== 'ERR_ABORTED') void recovery.recover('load', error.message)
  })
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
      // Read the OS preference before the renderer restores its saved theme.
      nativeTheme.themeSource = 'system'
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
      lifecycle.mark('主窗口已创建')
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
