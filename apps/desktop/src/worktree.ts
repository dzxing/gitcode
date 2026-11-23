import type { FileChange } from './types'

export interface WorktreeChange extends FileChange {
  staged?: FileChange
  unstaged?: FileChange
  partial: boolean
  conflict: boolean
  untracked: boolean
}
export interface WorktreeNode {
  key: string
  label: string
  path: string
  kind: 'group' | 'directory' | 'file'
  children: WorktreeNode[]
  files: WorktreeChange[]
  file?: WorktreeChange
}
export type WorktreeLayout = 'tree' | 'list'
export type StagingZone = 'unstaged' | 'staged'

export function stagingSelectionState(files: readonly FileChange[], selected: ReadonlySet<string>) {
  const count = files.filter((file) => selected.has(file.path)).length
  return {
    checked: files.length > 0 && count === files.length,
    mixed: count > 0 && count < files.length,
    disabled: !files.length,
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export function collectWorktreeChanges(
  staged: readonly FileChange[],
  unstaged: readonly FileChange[],
): WorktreeChange[] {
  const files = new Map<string, { staged?: FileChange; unstaged?: FileChange }>()
  for (const file of staged) files.set(file.path, { ...files.get(file.path), staged: file })
  for (const file of unstaged) files.set(file.path, { ...files.get(file.path), unstaged: file })
  return [...files]
    .map(([path, versions]) => {
      const { staged: index, unstaged: local } = versions
      const conflict = index?.status === 'U' || local?.status === 'U'
      const untracked = !index && local?.status === '?'
      const status = conflict
        ? 'U'
        : local?.status === 'D'
          ? 'D'
          : index?.status === 'R' || local?.status === 'R'
            ? 'R'
            : untracked
              ? '?'
              : index?.status === 'A'
                ? 'A'
                : local?.status || index?.status || 'M'
      return {
        path,
        oldPath: index?.oldPath || local?.oldPath,
        status,
        ...versions,
        partial: !!index && !!local && !conflict,
        conflict,
        untracked,
      }
    })
    .sort((a, b) => collator.compare(a.path, b.path) || a.path.localeCompare(b.path))
}

export function filterWorktreeChanges(files: readonly WorktreeChange[], query: string) {
  const term = query.trim().toLocaleLowerCase()
  return term
    ? files.filter((file) =>
        `${file.path}\n${file.oldPath || ''}`.toLocaleLowerCase().includes(term),
      )
    : [...files]
}

export function worktreeSelectionState(
  files: readonly WorktreeChange[],
  selected: ReadonlySet<string>,
) {
  const selectable = files.filter((file) => !file.conflict)
  const count = selectable.filter((file) => selected.has(file.path)).length
  return {
    checked: selectable.length > 0 && count === selectable.length,
    mixed: count > 0 && count < selectable.length,
    disabled: !selectable.length,
  }
}

function makeGroup(key: string, label: string): WorktreeNode {
  return { key, label, path: '', kind: 'group', children: [], files: [] }
}

function addFile(root: WorktreeNode, file: WorktreeChange, layout: WorktreeLayout) {
  root.files.push(file)
  let parent = root
  const parts = file.path.split('/')
  if (layout === 'tree') {
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let directory = parent.children.find(
        (child) => child.kind === 'directory' && child.path === path,
      )
      if (!directory) {
        directory = {
          key: `${root.key}:directory:${path}`,
          label: parts[i],
          path,
          kind: 'directory',
          children: [],
          files: [],
        }
        parent.children.push(directory)
      }
      directory.files.push(file)
      parent = directory
    }
  }
  parent.children.push({
    key: `${root.key}:file:${file.path}`,
    label: parts.at(-1) || file.path,
    path: file.path,
    kind: 'file',
    children: [],
    files: [file],
    file,
  })
}

function organize(node: WorktreeNode, compress: boolean): WorktreeNode {
  let result = { ...node, children: node.children.map((child) => organize(child, compress)) }
  while (
    compress &&
    result.kind === 'directory' &&
    result.children.length === 1 &&
    result.children[0]?.kind === 'directory'
  ) {
    const child = result.children[0]
    result = { ...child, label: `${result.label}/${child.label}` }
  }
  result.children.sort(
    (a, b) =>
      Number(a.kind === 'file') - Number(b.kind === 'file') || collator.compare(a.label, b.label),
  )
  return result
}

export function buildWorktreeTree(
  files: readonly WorktreeChange[],
  layout: WorktreeLayout = 'tree',
  compress = true,
): WorktreeNode[] {
  const groups = [
    makeGroup('conflicts', '冲突'),
    makeGroup('changes', '变更'),
    makeGroup('untracked', '未跟踪文件'),
  ]
  for (const file of files)
    addFile(groups[file.conflict ? 0 : file.untracked ? 2 : 1], file, layout)
  return groups.filter((group) => group.files.length).map((group) => organize(group, compress))
}

/** A staging zone is already the group: do not add status-based roots. */
export function buildStagingTree(
  files: readonly WorktreeChange[],
  zone: StagingZone,
  layout: WorktreeLayout = 'list',
  compress = true,
): WorktreeNode[] {
  const root = makeGroup(zone, zone)
  for (const file of files) addFile(root, file, layout)
  return organize(root, compress).children
}
