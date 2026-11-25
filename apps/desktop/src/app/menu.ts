import schema from '../../electron/menu-schema.json'
import type { ApplicationMenuState } from '../infrastructure/application'
export interface MenuItem {
  id: string
  label: string
  accelerator?: string
  separator?: boolean
  radio?: boolean
  checkbox?: boolean
  checked?: boolean
  enabled: boolean
  children?: MenuItem[]
}
export interface MenuGroup {
  id: string
  label: string
  accessKey: string
  items: MenuItem[]
}
interface MenuDefinition {
  windowsOnly?: boolean
  id: string
  label: string
  accelerator?: string
  separator?: boolean
  checkbox?: boolean
  radio?: boolean
  children?: MenuDefinition[]
}
export function buildMenus(state: ApplicationMenuState): MenuGroup[] {
  const enabled = new Set(state.enabled)
  function buildItem(definition: MenuDefinition): MenuItem {
    const { children, ...fields } = definition
    const item: MenuItem = { ...fields, enabled: enabled.has(definition.id) }
    if (children) item.children = children.map(buildItem)
    if (definition.id === 'file.recent') {
      item.children = state.recent.map((label, i) => ({
        id: `file.recent.${i}`,
        label,
        enabled: enabled.has(`file.recent.${i}`),
      }))
      item.enabled = item.children.length > 0 && item.children.some((child) => child.enabled)
    }
    if (definition.checkbox)
      item.checked =
        state[
          definition.id.split('.')[1] as
            'author' | 'time' | 'sha' | 'longEdges' | 'mergeCommits' | 'labelsAfterMessage'
        ]
    if (definition.radio)
      item.checked = definition.id.startsWith('view.theme.')
        ? (state.themePreference ||
            (state.theme === 'system' ? 'system' : state.palette || 'dark')) ===
          definition.id.slice('view.theme.'.length)
        : definition.id.startsWith('view.labelPosition.')
          ? (state.labelsAfterMessage !== false) === definition.id.endsWith('.after')
          : (state.labelStyle || 'gitkraken') === definition.id.split('.').at(-1)
    return item
  }
  return schema.map((group) => ({
    ...group,
    items: group.items.filter((item) => !('windowsOnly' in item) || state.wsl).map(buildItem),
  }))
}
export function shortcutLabel(value: string | undefined, mac: boolean) {
  return value?.replace('CmdOrCtrl', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift') || ''
}
