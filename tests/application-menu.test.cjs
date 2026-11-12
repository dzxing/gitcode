const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isCommand,
  editCommands,
  sanitizeState,
  buildMenuTemplate,
} = require('../electron/menus.cjs')
const { CloseCoordinator } = require('../electron/close-coordinator.cjs')

test('application menu accepts only named commands and uses text editing roles', () => {
  assert.equal(isCommand('file.closeTab'), true)
  assert.equal(isCommand('file.recent.5'), true)
  assert.equal(isCommand('file.recent.6'), false)
  assert.equal(isCommand('git.reset'), false)
  assert.equal(isCommand('view.resetLayout'), true)
  assert.equal(isCommand('repository.recovery'), true)
  assert.equal(editCommands.has('reset'), false)
  assert.throws(() => sanitizeState({ enabled: ['shell.execute'], recent: [] }))
  const state = sanitizeState({
    enabled: ['file.closeTab', 'edit.undo', 'repository.recovery', 'view.sha', 'view.resetLayout'],
    recent: ['repo'],
    sha: true,
  })
  const calls = []
  const template = buildMenuTemplate(state, (id) => calls.push(id), 'darwin')
  const flat = template.flatMap((group) => group.submenu)
  const recovery = flat.find((item) => item.id === 'repository.recovery')
  assert.equal(recovery.role, undefined)
  assert.equal(recovery.enabled, true)
  assert.equal(typeof recovery.click, 'function')
  const close = flat.find((item) => item.id === 'file.closeTab')
  assert.equal(close.role, undefined)
  assert.equal(close.accelerator, 'CmdOrCtrl+W')
  close.click()
  assert.deepEqual(calls, ['file.closeTab'])
  const resetLayout = flat.find((item) => item.id === 'view.resetLayout')
  assert.equal(resetLayout.enabled, true)
  assert.equal(resetLayout.label, '恢复默认面板宽度')
  resetLayout.click()
  assert.deepEqual(calls, ['file.closeTab', 'view.resetLayout'])
  assert.equal(flat.find((item) => item.id === 'edit.undo').role, 'undo')
  assert.equal(flat.find((item) => item.id === 'view.sha').checked, true)
  assert.equal(
    flat.some((item) =>
      ['reload', 'forceReload', 'toggleDevTools', 'viewMenu', 'quit'].includes(item.role),
    ),
    false,
  )
})

test('close requests are coalesced, token checked and finish exactly once', async () => {
  const sent = []
  let finished = 0
  const coordinator = new CloseCoordinator({
    send: (id) => sent.push(id),
    fallback: async () => false,
    finish: async () => {
      finished++
    },
    timeout: 100,
  })
  coordinator.request()
  coordinator.request()
  assert.deepEqual(sent, [1])
  coordinator.acknowledge(1)
  assert.equal(coordinator.approve(99), false)
  coordinator.cancel(99)
  assert.equal(coordinator.pending.id, 1)
  coordinator.cancel(1)
  coordinator.request()
  coordinator.acknowledge(2)
  assert.deepEqual(sent, [1, 2])
  assert.equal(coordinator.approve(1), false)
  assert.equal(coordinator.approve(2), true)
  assert.equal(coordinator.approve(2), false)
  coordinator.request()
  await Promise.resolve()
  assert.equal(finished, 1)
  assert.deepEqual(sent, [1, 2])
})

test('acknowledged renderer owns close confirmation; unavailable renderer uses bounded fallback', async () => {
  let fallback = 0,
    finished = 0
  const coordinator = new CloseCoordinator({
    send: () => {},
    fallback: async () => {
      fallback++
      return true
    },
    finish: async () => {
      finished++
    },
    timeout: 15,
  })
  coordinator.request()
  coordinator.acknowledge(1)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(fallback, 0)
  assert.equal(finished, 0)
  coordinator.cancel(1)
  coordinator.request()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(fallback, 1)
  assert.equal(finished, 1)
})

test('renderer crash clears stale close tokens without silently quitting', async () => {
  let finished = 0
  const coordinator = new CloseCoordinator({
    send: () => {},
    fallback: async () => false,
    finish: async () => {
      finished++
    },
    timeout: 100,
  })
  coordinator.request()
  coordinator.acknowledge(1)
  coordinator.rendererGone()
  assert.equal(coordinator.approve(1), false)
  coordinator.request()
  coordinator.acknowledge(2)
  coordinator.cancel(2)
  assert.equal(finished, 0)
})

test('long-edge presentation setting is a shared named checkbox, never a Git operation', () => {
  const state = sanitizeState({ enabled: ['view.longEdges'], recent: [], longEdges: true })
  const calls = []
  const item = buildMenuTemplate(state, (id) => calls.push(id), 'darwin')
    .flatMap((group) => group.submenu)
    .find((item) => item.id === 'view.longEdges')
  assert.equal(item.type, 'checkbox')
  assert.equal(item.checked, true)
  item.click()
  assert.deepEqual(calls, ['view.longEdges'])
})

test('label styles are exclusive native radio choices and only named commands are accepted', () => {
  const defaults = sanitizeState({ enabled: [], recent: [] })
  assert.equal(defaults.labelStyle, 'gitkraken')
  assert.equal(defaults.labelsAfterMessage, true)
  assert.equal(
    sanitizeState({ enabled: [], recent: [], labelsAfterMessage: false }).labelsAfterMessage,
    false,
  )
  const children = ['current', 'gitkraken', 'idea'].map((style) => `view.labelStyle.${style}`)
  for (const selected of ['current', 'gitkraken', 'idea']) {
    const state = sanitizeState({
      enabled: ['view.labelStyle', ...children],
      recent: [],
      labelStyle: selected,
    })
    const dispatched = []
    const menu = buildMenuTemplate(state, (id) => dispatched.push(id), 'win32')
      .flatMap((g) => g.submenu)
      .find((item) => item.id === 'view.labelStyle')
    assert.equal(menu.submenu.length, 3)
    assert.deepEqual(
      menu.submenu.filter((item) => item.checked).map((item) => item.id),
      [`view.labelStyle.${selected}`],
    )
    for (const item of menu.submenu) {
      assert.equal(item.type, 'radio')
      assert.equal(item.enabled, true)
      item.click()
    }
    assert.deepEqual(dispatched, children)
  }
  assert.equal(isCommand('view.labelStyle.idea'), true)
  assert.equal(isCommand('view.labelStyle.execute'), false)
  assert.equal(
    sanitizeState({ enabled: [], recent: [], labelStyle: 'invalid' }).labelStyle,
    'gitkraken',
  )
})

test('settings command has platform appropriate entry and shortcut', () => {
  assert.equal(isCommand('file.settings'), true)
  const state = sanitizeState({ enabled: ['file.settings'], recent: [] })
  for (const platform of ['win32', 'darwin']) {
    const calls = []
    const template = buildMenuTemplate(state, (id) => calls.push(id), platform)
    const entries = template.flatMap((group) => group.submenu)
    const settings = entries.filter((item) => item.label === '设置…')
    assert.equal(settings.length, 1)
    assert.equal(settings[0].enabled, true)
    assert.equal(settings[0].accelerator, platform === 'darwin' ? 'Cmd+,' : 'CmdOrCtrl+,')
    settings[0].click()
    assert.deepEqual(calls, ['file.settings'])
  }
})

test('menu state accepts only supported native appearance values', () => {
  for (const theme of ['light', 'dark', 'system']) {
    const state = sanitizeState({
      enabled: [],
      recent: [],
      theme,
      resolvedTheme: theme === 'system' ? 'light' : theme,
    })
    assert.equal(state.theme, theme)
    assert.equal(state.resolvedTheme, theme === 'system' ? 'light' : theme)
  }
  const fallback = sanitizeState({ enabled: [], recent: [], theme: {}, resolvedTheme: 'invalid' })
  assert.equal(fallback.theme, 'dark')
  assert.equal(fallback.resolvedTheme, 'dark')
})

test('native theme submenu checks the stored choice independently of the resolved palette', () => {
  const palettes = Object.keys(require('../electron/theme-presets.json'))
  for (const preference of [...palettes, 'system']) {
    const state = sanitizeState({
      enabled: ['view.theme', `view.theme.${preference}`],
      recent: [],
      themePreference: preference,
      theme: preference === 'system' ? 'system' : 'dark',
      palette: preference === 'system' ? 'dark' : preference,
    })
    const calls = []
    const themes = buildMenuTemplate(state, (id) => calls.push(id), 'win32')
      .find((group) => group.label === '视图')
      .submenu.find((item) => item.id === 'view.theme').submenu
    assert.equal(themes.length, palettes.length + 1)
    const checked = themes.filter((item) => item.checked)
    assert.deepEqual(
      checked.map((item) => item.id),
      [`view.theme.${preference}`],
    )
    checked[0].click()
    assert.deepEqual(calls, [`view.theme.${preference}`])
  }
  assert.equal(
    sanitizeState({ enabled: [], recent: [], themePreference: '__proto__' }).themePreference,
    'dark',
  )
})

test('repository commands are grouped separately from text editing on all desktop platforms', () => {
  const commands = [
    'repository.fetch',
    'repository.pull',
    'repository.push',
    'repository.recovery',
    'repository.settings',
  ]
  for (const platform of ['win32', 'darwin']) {
    const calls = []
    const template = buildMenuTemplate(
      sanitizeState({ enabled: commands, recent: [] }),
      (id) => calls.push(id),
      platform,
    )
    const groups = template.filter((group) => group.label !== 'GitCode')
    assert.deepEqual(
      groups.map((group) => group.label),
      ['文件', '编辑', '视图', '仓库', '帮助'],
    )
    const repository = groups.find((group) => group.label === '仓库')
    const items = repository.submenu.filter((item) => item.type !== 'separator')
    assert.deepEqual(
      items.map((item) => item.id),
      commands,
    )
    for (const item of items) {
      assert.equal(item.enabled, true)
      assert.equal(item.role, undefined)
      item.click()
    }
    assert.deepEqual(calls, commands)
    assert.equal(
      groups
        .find((group) => group.label === '编辑')
        .submenu.some((item) => item.id === 'repository.recovery'),
      false,
    )
  }
  for (const id of ['edit.recovery', 'file.fetchSettings', 'file.gitRuntime'])
    assert.equal(isCommand(id), false)
})

test('label positions are exclusive radio options and column toggles remain direct children', () => {
  for (const after of [false, true]) {
    const commands = [
      'view.labelPosition',
      'view.labelPosition.before',
      'view.labelPosition.after',
      'view.author',
      'view.time',
      'view.sha',
    ]
    const calls = []
    const groups = buildMenuTemplate(
      sanitizeState({ enabled: commands, recent: [], labelsAfterMessage: after }),
      (id) => calls.push(id),
      'win32',
    )
    const view = groups.find((group) => group.label === '视图').submenu
    for (const id of ['view.author', 'view.time', 'view.sha'])
      assert.equal(view.find((item) => item.id === id).type, 'checkbox')
    const positions = view.find((item) => item.id === 'view.labelPosition').submenu
    assert.deepEqual(
      positions.filter((item) => item.checked).map((item) => item.id),
      [`view.labelPosition.${after ? 'after' : 'before'}`],
    )
    positions[0].click()
    assert.deepEqual(calls, ['view.labelPosition.before'])
  }
})
