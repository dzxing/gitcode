import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Branch } from '../../../shared/contracts'
import { branchReference } from '../../../shared/lib/references'
import {
  BRANCH_SORTS,
  sortSidebarBranches,
  DEFAULT_SIDEBAR_ORDER,
  normalizeSidebarOrder,
  type BranchSort,
  type SidebarSection,
} from '../sidebar'

const storageKey = 'gitcode.sidebar-sections'
export const useSidebarStore = defineStore('sidebar', () => {
  let saved: unknown
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
  } catch {
    /* Optional UI preferences. */
  }
  const order = ref(normalizeSidebarOrder(saved)),
    warning = ref('')
  interface BranchPreferences {
    groupDirectories: boolean
    collapsedDirectories: string[]
    favorites: string[]
    sorts: Partial<Record<SidebarSection, BranchSort>>
  }
  const branchStorageKey = 'gitcode.branch-preferences'
  const preferences = ref<Record<string, BranchPreferences>>({})
  try {
    const input: unknown = JSON.parse(localStorage.getItem(branchStorageKey) || 'null')
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const [path, value] of Object.entries(input)) {
        if (!value || typeof value !== 'object' || path === '__proto__') continue
        const raw = value as {
          favorites?: unknown
          sorts?: unknown
          groupDirectories?: unknown
          remoteTree?: unknown
          remoteCollapsed?: unknown
          collapsedDirectories?: unknown
        }
        const favorites = Array.isArray(raw.favorites)
          ? [
              ...new Set(
                raw.favorites.filter(
                  (ref): ref is string =>
                    typeof ref === 'string' && /^refs\/(heads|remotes|tags)\//.test(ref),
                ),
              ),
            ]
          : []
        const sorts: BranchPreferences['sorts'] = {}
        for (const section of DEFAULT_SIDEBAR_ORDER) {
          const mode =
            raw.sorts && typeof raw.sorts === 'object'
              ? (raw.sorts as Record<string, unknown>)[section]
              : null
          if (BRANCH_SORTS.some((item) => item.id === mode)) sorts[section] = mode as BranchSort
        }
        preferences.value[path] = {
          favorites,
          sorts,
          groupDirectories:
            typeof raw.groupDirectories === 'boolean'
              ? raw.groupDirectories
              : raw.remoteTree !== false,
          collapsedDirectories: Array.isArray(raw.collapsedDirectories)
            ? [
                ...new Set(
                  raw.collapsedDirectories.filter((key): key is string => typeof key === 'string'),
                ),
              ]
            : Array.isArray(raw.remoteCollapsed)
              ? raw.remoteCollapsed.flatMap((key) => {
                  try {
                    const parts: unknown = JSON.parse(String(key))
                    return Array.isArray(parts) && parts.every((part) => typeof part === 'string')
                      ? [JSON.stringify(['remote', ...parts])]
                      : []
                  } catch {
                    return []
                  }
                })
              : [],
        }
      }
    }
  } catch {
    /* Malformed preferences fall back to name order and no favorites. */
  }
  function branchPreferences(path: string): BranchPreferences {
    return Object.hasOwn(preferences.value, path)
      ? preferences.value[path]
      : { favorites: [], sorts: {}, groupDirectories: true, collapsedDirectories: [] }
  }
  function persistBranches(path: string, next: BranchPreferences) {
    preferences.value = { ...preferences.value, [path]: next }
    try {
      localStorage.setItem(branchStorageKey, JSON.stringify(preferences.value))
      warning.value = ''
    } catch {
      warning.value = '导航显示设置和收藏仅在本次会话保留。'
    }
  }
  function isFavorite(path: string, branch: Branch) {
    return branchPreferences(path).favorites.includes(branchReference(branch))
  }
  function toggleFavorite(path: string, branch: Branch) {
    const current = branchPreferences(path),
      fullRef = branchReference(branch)
    const favorites = current.favorites.includes(fullRef)
      ? current.favorites.filter((ref) => ref !== fullRef)
      : [...current.favorites, fullRef]
    persistBranches(path, { ...current, favorites })
  }
  function sortMode(path: string, section: SidebarSection) {
    return branchPreferences(path).sorts[section] || 'name-asc'
  }
  function setSort(path: string, section: SidebarSection, mode: BranchSort) {
    if (!BRANCH_SORTS.some((item) => item.id === mode)) return
    const current = branchPreferences(path)
    persistBranches(path, { ...current, sorts: { ...current.sorts, [section]: mode } })
  }
  function sortedBranches(path: string, section: SidebarSection, branches: readonly Branch[]) {
    return sortSidebarBranches(branches, sortMode(path, section), branchPreferences(path).favorites)
  }
  function groupDirectories(path: string) {
    return branchPreferences(path).groupDirectories
  }
  function toggleGroupDirectories(path: string) {
    const current = branchPreferences(path)
    persistBranches(path, { ...current, groupDirectories: !current.groupDirectories })
  }
  function collapsedDirectories(path: string, key: string) {
    return branchPreferences(path).collapsedDirectories.includes(key)
  }
  function toggleDirectoryCollapsed(path: string, key: string) {
    const current = branchPreferences(path)
    persistBranches(path, {
      ...current,
      collapsedDirectories: current.collapsedDirectories.includes(key)
        ? current.collapsedDirectories.filter((item) => item !== key)
        : [...current.collapsedDirectories, key],
    })
  }
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(order.value))
      warning.value = ''
    } catch {
      warning.value = '分组顺序仅在本次会话保留。'
    }
  }
  function canMove(section: SidebarSection, direction: -1 | 1) {
    const index = order.value.indexOf(section)
    return index >= 0 && index + direction >= 0 && index + direction < order.value.length
  }
  function move(section: SidebarSection, direction: -1 | 1) {
    if (!canMove(section, direction)) return false
    const next = [...order.value],
      from = next.indexOf(section),
      to = from + direction
    ;[next[from], next[to]] = [next[to], next[from]]
    order.value = next
    persist()
    return true
  }
  function reset() {
    order.value = [...DEFAULT_SIDEBAR_ORDER]
    persist()
  }
  return {
    order,
    warning,
    canMove,
    move,
    reset,
    isFavorite,
    toggleFavorite,
    sortMode,
    setSort,
    sortedBranches,
    groupDirectories,
    toggleGroupDirectories,
    collapsedDirectories,
    toggleDirectoryCollapsed,
  }
})
