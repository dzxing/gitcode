import schema from '../electron/menu-schema.json'
import type { ApplicationMenuState } from './services/application'
export interface MenuItem {
  id: string
  label: string
  accelerator?: string
  separator?: boolean
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
export function buildMenus(state: ApplicationMenuState): MenuGroup[] {
  const enabled = new Set(state.enabled)
  return schema.map((group) => ({
    ...group,
    items: group.items.map((definition) => {
      const item: MenuItem = { ...definition, enabled: enabled.has(definition.id) }
      if (definition.id === 'file.recent') {
        item.children = state.recent.map((label, i) => ({
          id: `file.recent.${i}`,
          label,
          enabled: enabled.has(`file.recent.${i}`),
        }))
        item.enabled = item.children.length > 0 && item.children.some((child) => child.enabled)
      }
      if ('checkbox' in definition)
        item.checked = state[definition.id.split('.')[1] as 'author' | 'time' | 'sha']
      return item
    }),
  }))
}
export function shortcutLabel(value: string | undefined, mac: boolean) {
  return value?.replace('CmdOrCtrl', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift') || ''
}
