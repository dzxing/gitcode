import { branchReference } from './references'
import type { Branch } from './types'

export const SIDEBAR_SECTIONS = {
  gitflow: { title: 'GitFlow', icon: 'GitMerge' },
  local: { title: '本地分支', icon: 'GitBranch' },
  remote: { title: '远程分支', icon: 'Cloud' },
  tag: { title: '标签', icon: 'Tag' },
} as const
export type SidebarSection = keyof typeof SIDEBAR_SECTIONS
export const DEFAULT_SIDEBAR_ORDER: SidebarSection[] = ['gitflow', 'local', 'remote', 'tag']
export function normalizeSidebarOrder(input: unknown): SidebarSection[] {
  const saved = Array.isArray(input)
    ? input.filter(
        (id): id is SidebarSection => typeof id === 'string' && Object.hasOwn(SIDEBAR_SECTIONS, id),
      )
    : []
  return [...new Set([...saved, ...DEFAULT_SIDEBAR_ORDER])]
}
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export type BranchSort = 'name-asc' | 'name-desc' | 'current-first'
export const BRANCH_SORTS: { id: BranchSort; label: string }[] = [
  { id: 'name-asc', label: '名称升序' },
  { id: 'name-desc', label: '名称降序' },
  { id: 'current-first', label: '当前分支优先' },
]
export function sortSidebarBranches(
  branches: readonly Branch[],
  order: BranchSort = 'name-asc',
  favorites: readonly string[] = [],
) {
  const pinned = new Set(favorites)
  return [...branches].sort((a, b) => {
    const favorite = Number(pinned.has(branchReference(b))) - Number(pinned.has(branchReference(a)))
    if (favorite) return favorite
    if (order === 'current-first' && a.current !== b.current)
      return Number(b.current) - Number(a.current)
    const name =
      collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return order === 'name-desc' ? -name : name
  })
}
