import { branchReference, sidebarBranchKey } from '../references'
import type { Branch, Snapshot } from '../types'
export type FilterSection = 'local' | 'gitflow' | 'remote' | 'tag'
export interface HistoryFilterPreference {
  fullRef: string
  section: FilterSection | null
}
const sections = new Set(['local', 'gitflow', 'remote', 'tag'])
const validRef = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  /^refs\/(heads|remotes|tags)\/.+/.test(value) &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
export function historyFilterKey(path: string) {
  // Core snapshots already contain canonical paths. Preserve case for Unix,
  // case-sensitive NTFS directories and UNC servers; only normalize spelling
  // of Windows separators and the drive letter.
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
  const normalized = (
    windows ? path.replace(/\\/g, '/').replace(/^[A-Z]:/, (d) => d.toLowerCase()) : path
  ).replace(/\/+$/, '')
  return `gitcode.historyFilter.v1:${normalized || (path.startsWith('/') ? '/' : '')}`
}
export function historyFilterPreference(
  filter: { fullRef: string; source: string } | null,
): HistoryFilterPreference | null {
  if (!filter || !validRef(filter.fullRef)) return null
  let section: FilterSection | null = null
  try {
    const source: unknown = JSON.parse(filter.source)
    if (
      Array.isArray(source) &&
      source.length === 2 &&
      typeof source[0] === 'string' &&
      sections.has(source[0]) &&
      source[1] === filter.fullRef
    )
      section = source[0] as FilterSection
  } catch {
    /* Graph-origin filters have no sidebar selection. */
  }
  return { fullRef: filter.fullRef, section }
}
export function readHistoryFilter(path: string): HistoryFilterPreference | null {
  try {
    const raw = localStorage.getItem(historyFilterKey(path))
    if (!raw || raw.length > 16000) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const input = value as Record<string, unknown>
    if (input.version !== 1 || !validRef(input.fullRef)) return null
    return {
      fullRef: input.fullRef,
      section:
        typeof input.section === 'string' && sections.has(input.section)
          ? (input.section as FilterSection)
          : null,
    }
  } catch {
    return null
  }
}
export function writeHistoryFilter(path: string, preference: HistoryFilterPreference | null) {
  const key = historyFilterKey(path)
  if (preference) {
    if (!validRef(preference.fullRef)) throw Error('无效的筛选引用。')
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, fullRef: preference.fullRef, section: preference.section }),
    )
  } else localStorage.removeItem(key)
  return Promise.resolve(
    typeof window === 'undefined' ? undefined : window.gitcodeApp?.flushDraftStorage?.(),
  )
}
function isFlowBranch(snapshot: Snapshot, branch: Branch) {
  const flow = snapshot.gitflow
  if (branch.kind !== 'local' || !flow?.ready) return false
  const c = flow.config
  return (
    branch.name === c.production ||
    branch.name === c.develop ||
    [c.feature, c.release, c.hotfix].some(
      (prefix) => prefix && branch.name.startsWith(prefix) && branch.name.length > prefix.length,
    )
  )
}
export function restoreHistoryFilter(
  snapshot: Snapshot,
  preference: HistoryFilterPreference | null,
) {
  if (!preference) return { filter: null, missing: false }
  const branch = snapshot.branches.find((b) => branchReference(b) === preference.fullRef)
  if (!branch) return { filter: null, missing: true }
  let section = preference.section
  if (section === 'gitflow' && !isFlowBranch(snapshot, branch))
    section = branch.kind === 'local' ? 'local' : null
  if (section && section !== 'gitflow' && (section !== branch.kind || branch.symbolicTarget))
    section = null
  return {
    filter: {
      fullRef: preference.fullRef,
      source: section ? sidebarBranchKey(section, branch) : '',
    },
    missing: false,
  }
}
