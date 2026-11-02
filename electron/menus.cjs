'use strict'
const schema = require('./menu-schema.json')
const ids = new Set(
  schema
    .flatMap((group) => group.items.map((item) => item.id))
    .filter((id) => id !== 'file.recent'),
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
    value.enabled.length > 40 ||
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
  return {
    enabled: new Set(value.enabled),
    recent,
    author: value.author === true,
    time: value.time === true,
    sha: value.sha === true,
  }
}
function buildMenuTemplate(state, dispatch, platform = process.platform) {
  const groups = schema.map((group) => ({
    label: group.label,
    submenu: group.items.flatMap((definition) => {
      if (
        platform === 'darwin' &&
        (definition.id === 'file.quit' || definition.id === 'help.about')
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
        if (definition.accelerator) item.accelerator = definition.accelerator
        if (definition.checkbox) {
          item.type = 'checkbox'
          item.checked = state[definition.id.split('.')[1]]
        }
        if (definition.id.startsWith('edit.')) item.role = definition.id.slice(5)
        else item.click = () => dispatch(definition.id)
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
