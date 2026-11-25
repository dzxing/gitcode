import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { FileChange } from '../../../shared/contracts'
import type { StagingZone, WorktreeLayout } from '../worktree'

interface StagingView {
  query: string
  collapsed: string[]
  layout: WorktreeLayout
  compress: boolean
  selected: Record<StagingZone, string[]>
}
const initial = (): StagingView => ({
  query: '',
  collapsed: [],
  layout: 'list',
  compress: true,
  selected: { unstaged: [], staged: [] },
})
const key = 'gitcode.staging-view.v1'
export const useStagingStore = defineStore('staging-view', () => {
  const repositories = ref<Record<string, StagingView>>({})
  const contexts = new Map<string, string>()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      for (const [path, item] of Object.entries(saved).slice(-30)) {
        if (!item || typeof item !== 'object') continue
        const pref = item as Partial<StagingView>
        repositories.value[path] = {
          ...initial(),
          layout: pref.layout === 'tree' ? 'tree' : 'list',
          compress: pref.compress !== false,
        }
      }
  } catch {
    /* View preferences are optional; checkbox choices are never restored. */
  }
  function view(path: string) {
    return repositories.value[path] || initial()
  }
  function update(path: string, changes: Partial<StagingView>) {
    repositories.value = { ...repositories.value, [path]: { ...view(path), ...changes } }
    try {
      localStorage.setItem(
        key,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(repositories.value)
              .slice(-30)
              .map(([repo, value]) => [repo, { layout: value.layout, compress: value.compress }]),
          ),
        ),
      )
    } catch {
      /* Session state remains available. */
    }
  }
  function selected(path: string, zone: StagingZone, files: readonly FileChange[]) {
    const available = new Set(files.map((file) => file.path))
    return new Set(view(path).selected[zone].filter((name) => available.has(name)))
  }
  function choose(path: string, zone: StagingZone, files: readonly FileChange[], checked: boolean) {
    const next = new Set(view(path).selected[zone])
    for (const file of files) {
      if (checked) next.add(file.path)
      else next.delete(file.path)
    }
    update(path, { selected: { ...view(path).selected, [zone]: [...next] } })
  }
  function remove(path: string, zone: StagingZone, paths: readonly string[]) {
    const removed = new Set(paths)
    update(path, {
      selected: {
        ...view(path).selected,
        [zone]: view(path).selected[zone].filter((name) => !removed.has(name)),
      },
    })
  }
  function reconcile(
    path: string,
    files: Record<StagingZone, readonly FileChange[]>,
    context: string,
  ) {
    const changed = contexts.has(path) && contexts.get(path) !== context
    contexts.set(path, context)
    const before = view(path).selected
    const next = changed
      ? { unstaged: [], staged: [] }
      : {
          unstaged: [...selected(path, 'unstaged', files.unstaged)],
          staged: [...selected(path, 'staged', files.staged)],
        }
    if (
      before.unstaged.join('\0') !== next.unstaged.join('\0') ||
      before.staged.join('\0') !== next.staged.join('\0')
    )
      update(path, { selected: next })
    return changed && before.unstaged.length + before.staged.length > 0
  }
  function toggle(path: string, node: string) {
    const collapsed = new Set(view(path).collapsed)
    if (collapsed.has(node)) collapsed.delete(node)
    else collapsed.add(node)
    update(path, { collapsed: [...collapsed] })
  }
  return { repositories, view, update, selected, choose, remove, reconcile, toggle }
})
