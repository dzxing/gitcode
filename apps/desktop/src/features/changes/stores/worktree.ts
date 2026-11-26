import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WorktreeChange, WorktreeLayout } from '../worktreeModel'

interface WorktreePreferences {
  selected: string[]
  query: string
  collapsed: string[]
  mode: 'selection' | 'staging'
  layout: WorktreeLayout
  compress: boolean
}
const storageKey = 'gitcode.worktree-view.v1'
const initial = (): WorktreePreferences => ({
  selected: [],
  query: '',
  collapsed: [],
  mode: 'selection',
  layout: 'tree',
  compress: true,
})

export const useWorktreeStore = defineStore('worktree-view', () => {
  const repositories = ref<Record<string, WorktreePreferences>>({})
  const warning = ref('')
  const contexts = new Map<string, string>()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [path, value] of Object.entries(saved).slice(-30)) {
        if (!value || typeof value !== 'object') continue
        const item = value as Partial<WorktreePreferences>
        repositories.value[path] = {
          ...initial(),
          mode: item.mode === 'staging' ? 'staging' : 'selection',
          layout: item.layout === 'list' ? 'list' : 'tree',
          compress: item.compress !== false,
        }
      }
    }
  } catch {
    /* Display preferences are optional. */
  }
  function view(path: string) {
    return repositories.value[path] || initial()
  }
  function save() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(repositories.value)
              .slice(-30)
              .map(([path, value]) => [
                path,
                { mode: value.mode, layout: value.layout, compress: value.compress },
              ]),
          ),
        ),
      )
      warning.value = ''
    } catch {
      warning.value = '工作区视图与勾选仅在本次会话保留。'
    }
  }
  function update(path: string, changes: Partial<WorktreePreferences>) {
    repositories.value = { ...repositories.value, [path]: { ...view(path), ...changes } }
    save()
  }
  function selected(path: string, files: readonly WorktreeChange[]) {
    const available = new Set(files.filter((file) => !file.conflict).map((file) => file.path))
    return new Set(view(path).selected.filter((name) => available.has(name)))
  }
  function choose(path: string, files: readonly WorktreeChange[], checked: boolean) {
    const next = new Set(view(path).selected)
    for (const file of files)
      if (!file.conflict) {
        if (checked) next.add(file.path)
        else next.delete(file.path)
      }
    update(path, { selected: [...next] })
  }
  function reconcile(path: string, files: readonly WorktreeChange[], context: string) {
    const changed =
      contexts.has(path) && contexts.get(path) !== context && view(path).selected.length > 0
    contexts.set(path, context)
    if (changed) {
      update(path, { selected: [] })
      return true
    }
    const next = [...selected(path, files)]
    if (next.length !== view(path).selected.length) update(path, { selected: next })
    return false
  }
  function remove(path: string, paths: readonly string[]) {
    const removed = new Set(paths)
    update(path, { selected: view(path).selected.filter((name) => !removed.has(name)) })
  }
  function toggle(path: string, key: string) {
    const collapsed = new Set(view(path).collapsed)
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    update(path, { collapsed: [...collapsed] })
  }
  return { repositories, warning, view, update, selected, choose, reconcile, remove, toggle }
})
