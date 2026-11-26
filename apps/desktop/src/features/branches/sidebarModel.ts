import { branchReference } from '../../shared/lib/references'
import type { Branch } from '../../shared/contracts'

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

export interface BranchTreeNode {
  key: string
  label: string
  branch?: Branch
  children: BranchTreeNode[]
  count: number
  current: boolean
}
export interface BranchDirectoryTree {
  favorites: { branch: Branch; label: string }[]
  children: BranchTreeNode[]
  count: number
}
export function branchDirectoryTree(
  branches: readonly Branch[],
  scope: readonly string[],
  favorites: readonly string[],
  order: BranchSort = 'name-asc',
  query = '',
  labelFor: (branch: Branch) => string = (branch) => branch.name,
): BranchDirectoryTree {
  const result: BranchDirectoryTree = { favorites: [], children: [], count: 0 }
  const nodes = new Map<string, BranchTreeNode>(),
    pinned = new Set(favorites)
  for (const branch of sortSidebarBranches(branches, order, favorites)) {
    if (branch.symbolicTarget || !branch.name.toLowerCase().includes(query.trim().toLowerCase()))
      continue
    const label = labelFor(branch)
    result.count++
    if (pinned.has(branchReference(branch))) {
      result.favorites.push({ branch, label })
      continue
    }
    let children = result.children
    const segments = label.split('/')
    for (let index = 0; index < segments.length; index++) {
      const key = JSON.stringify([...scope, ...segments.slice(0, index + 1)])
      let node = nodes.get(key)
      if (!node) {
        node = { key, label: segments[index], children: [], count: 0, current: false }
        nodes.set(key, node)
        children.push(node)
      }
      node.count++
      node.current ||= branch.current
      if (index === segments.length - 1) node.branch = branch
      children = node.children
    }
  }
  const sortNodes = (nodes: BranchTreeNode[]) => {
    nodes.sort((a, b) => {
      if (order === 'current-first' && a.current !== b.current)
        return Number(b.current) - Number(a.current)
      const name =
        collator.compare(a.label, b.label) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
      return order === 'name-desc' ? -name : name
    })
    nodes.forEach((node) => sortNodes(node.children))
  }
  sortNodes(result.children)
  return result
}
export interface RemoteBranchGroup extends BranchDirectoryTree {
  remote: string
  key: string
}
export function remoteBranchGroups(
  branches: readonly Branch[],
  remotes: readonly string[],
  favorites: readonly string[],
  order: BranchSort = 'name-asc',
  query = '',
): RemoteBranchGroup[] {
  const groups = new Map<string, Branch[]>()
  const known = [...remotes].sort((a, b) => b.length - a.length)
  if (!query.trim()) remotes.forEach((remote) => groups.set(remote, []))
  for (const branch of branches) {
    if (
      branch.kind !== 'remote' ||
      branch.symbolicTarget ||
      !branch.name.toLowerCase().includes(query.trim().toLowerCase())
    )
      continue
    const remote =
      known.find((remote) => branch.name.startsWith(remote + '/')) || branch.name.split('/')[0]
    const items = groups.get(remote) || []
    items.push(branch)
    groups.set(remote, items)
  }
  return [...groups]
    .map(([remote, items]) => ({
      remote,
      key: JSON.stringify(['remote', remote]),
      ...branchDirectoryTree(
        items,
        ['remote', remote],
        favorites,
        order,
        query,
        (branch) => branch.name.slice(remote.length + 1) || branch.name,
      ),
    }))
    .sort(
      (a, b) =>
        Number(b.remote === 'origin') - Number(a.remote === 'origin') ||
        collator.compare(a.remote, b.remote) ||
        a.remote.localeCompare(b.remote),
    )
}
