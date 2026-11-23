'use strict'
const schema = require('./menu-schema.json')
const themePresets = require('./theme-presets.json')
const collectIds = (items) => items.flatMap((item) => [item.id, ...collectIds(item.children || [])])
const ids = new Set(
  collectIds(schema.flatMap((group) => group.items)).filter((id) => id !== 'file.recent'),
)
const editCommands = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
function isCommand(id) {
  return typeof id === 'string' && (ids.has(id) || /^file\.recent\.[0-5]$/.test(id))
}
function sanitizeState(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.enabled) ||
    value.enabled.length > ids.size + 6 ||
    value.enabled.some((id) => !isCommand(id))
  )
    throw new Error('无效的菜单状态。')
  const recent = Array.isArray(value.recent)
    ? value.recent
        .slice(0, 6)
        .map((label) =>
          typeof label === 'string' ? label.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) : '',
        )
    : []
  const palette =
    typeof value.palette === 'string' && Object.hasOwn(themePresets, value.palette)
      ? value.palette
      : value.resolvedTheme === 'light'
        ? 'light'
        : 'dark'
  return {
    palette,
    themePreference:
      value.themePreference === 'system' ||
      (typeof value.themePreference === 'string' &&
        Object.hasOwn(themePresets, value.themePreference))
        ? value.themePreference
        : value.theme === 'system'
          ? 'system'
          : palette,
    enabled: new Set(value.enabled),
    theme: value.theme === 'system' ? 'system' : themePresets[palette].mode,
    resolvedTheme: themePresets[palette].mode,
    recent,
    author: value.author === true,
    time: value.time === true,
    sha: value.sha === true,
    longEdges: value.longEdges === true,
    mergeCommits: value.mergeCommits !== false,
    labelsAfterMessage: value.labelsAfterMessage !== false,
    labelStyle: ['current', 'gitkraken', 'idea'].includes(value.labelStyle)
      ? value.labelStyle
      : 'gitkraken',
  }
}
function buildMenuTemplate(state, dispatch, platform = process.platform) {
  const groups = schema.map((group) => ({
    label: group.label,
    submenu: group.items.flatMap((definition) => {
      if (definition.windowsOnly && platform !== 'win32') return []
      if (
        platform === 'darwin' &&
        ['file.quit', 'help.about', 'file.settings'].includes(definition.id)
      )
        return []
      let item
      if (definition.id === 'file.recent') {
        item = {
          label: definition.label,
          enabled: !!state.recent.length,
          submenu: state.recent.map((label, i) => ({
            label,
            enabled: state.enabled.has(`file.recent.${i}`),
            click: () => dispatch(`file.recent.${i}`),
          })),
        }
      } else {
        item = {
          label: definition.label,
          id: definition.id,
          enabled: state.enabled.has(definition.id),
        }
        if (definition.children)
          item.submenu = definition.children.map((child) => ({
            id: child.id,
            label: child.label,
            type: 'radio',
            enabled: state.enabled.has(child.id),
            checked: child.id.startsWith('view.theme.')
              ? state.themePreference === child.id.slice('view.theme.'.length)
              : child.id.startsWith('view.labelPosition.')
                ? (state.labelsAfterMessage !== false) === child.id.endsWith('.after')
                : (state.labelStyle || 'gitkraken') === child.id.split('.').at(-1),
            click: () => dispatch(child.id),
          }))
        if (definition.accelerator) item.accelerator = definition.accelerator
        if (definition.checkbox) {
          item.type = 'checkbox'
          item.checked = state[definition.id.split('.')[1]]
        }
        if (definition.id.startsWith('edit.') && editCommands.has(definition.id.slice(5)))
          item.role = definition.id.slice(5)
        else if (!definition.children) item.click = () => dispatch(definition.id)
      }
      return definition.separator ? [{ type: 'separator' }, item] : [item]
    }),
  }))
  if (platform === 'darwin')
    groups.unshift({
      label: 'GitCode',
      submenu: [
        {
          label: '关于 GitCode',
          enabled: state.enabled.has('help.about'),
          click: () => dispatch('help.about'),
        },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'Cmd+,',
          enabled: state.enabled.has('file.settings'),
          click: () => dispatch('file.settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: '退出 GitCode', accelerator: 'Cmd+Q', click: () => dispatch('file.quit') },
      ],
    })
  return groups
}
module.exports = { schema, isCommand, editCommands, sanitizeState, buildMenuTemplate }
