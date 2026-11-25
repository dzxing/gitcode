import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { Branch, Commit, FileChange, Snapshot, StashEntry } from '../../shared/contracts'
import { useRepositoryStore } from '../../features/repository/stores/repository'
import { useHistoryQueryStore } from '../../features/history/stores/historyQuery'
import type { SidebarSection } from '../../features/branches/sidebar'

export type MenuObject =
  | { kind: 'files'; files: FileChange[]; staged: boolean; label: string }
  | { kind: 'file-revision'; path: string; oldPath?: string; currentPath: string; revision: string }
  | { kind: 'historical-file'; path: string; revision: string }
  | { kind: 'stash'; stash: StashEntry }
  | { kind: 'branch'; branch: Branch }
  | { kind: 'commit'; commit: Commit; commits?: Commit[] }
  | { kind: 'section'; section: SidebarSection }
  | { kind: 'worktree' | 'background' | 'columns' | 'navigation' }
export type MenuContext = MenuObject & {
  repo: string
  tabId: number
  head: string
  currentBranch: string
  navigationSource?: string
  commitEligibility?: string
}

import { branchReference } from '../../shared/lib/references'
export { branchReference } from '../../shared/lib/references'

// Refreshing an unchanged snapshot must not dismiss a native branch menu or its form.
export function branchContextCurrent(target: MenuContext, snapshot: Snapshot, tabId: number) {
  if (
    target.kind !== 'branch' ||
    target.repo !== snapshot.path ||
    target.tabId !== tabId ||
    target.head !== snapshot.head ||
    target.currentBranch !== snapshot.branch
  )
    return false
  const branch = snapshot.branches.find(
    (entry) => branchReference(entry) === branchReference(target.branch),
  )
  return (
    !!branch &&
    branch.hash === target.branch.hash &&
    branch.commitHash === target.branch.commitHash &&
    branch.symbolicTarget === target.branch.symbolicTarget &&
    branch.worktreePath === target.branch.worktreePath &&
    branch.upstream === target.branch.upstream
  )
}

export function commitContextCurrent(target: MenuContext, snapshot: Snapshot, tabId: number) {
  return (
    target.kind === 'commit' &&
    target.repo === snapshot.path &&
    target.tabId === tabId &&
    target.head === snapshot.head &&
    target.currentBranch === snapshot.branch &&
    target.commitEligibility === commitEligibility(snapshot) &&
    (target.commits?.length ? target.commits : [target.commit]).every((c) =>
      snapshot.commits.some((commit) => commit.hash === c.hash),
    )
  )
}
function commitEligibility(snapshot: Snapshot) {
  return JSON.stringify([
    snapshot.history?.signature || '',
    snapshot.merge || null,
    snapshot.branches
      .filter((branch) => branch.kind === 'remote')
      .map((branch) => [branch.name, branch.commitHash || branch.hash])
      .sort((a, b) => a[0].localeCompare(b[0])),
  ])
}

export function referenceBranch(branches: Branch[], name: string, hash: string) {
  const tag = name.startsWith('tag: ')
  const short = name.replace(/^HEAD -> /, '').replace(/^tag: /, '')
  return branches.find(
    (branch) =>
      branch.name === short &&
      (tag ? branch.kind === 'tag' : branch.kind !== 'tag') &&
      (branch.hash === hash || branch.kind === 'tag'),
  )
}

export const useContextMenuStore = defineStore('context-menu', () => {
  const repository = useRepositoryStore()
  const query = useHistoryQueryStore()
  const historyCommits = computed(() => [
    ...new Map(
      [...repository.repo.commits, ...(query.enabled ? query.commits : [])].map((commit) => [
        commit.hash,
        commit,
      ]),
    ).values(),
  ])
  const visibleCommits = computed(() => (query.enabled ? query.commits : repository.visibleCommits))
  const target = shallowRef<MenuContext | null>(null)
  const trigger = shallowRef<HTMLElement | null>(null)
  const selectedCommits = ref<string[]>([])
  watch(
    () => visibleCommits.value.map((c) => c.hash).join(','),
    () => {
      const visible = new Set(visibleCommits.value.map((c) => c.hash))
      selectedCommits.value = selectedCommits.value.filter((sha) => visible.has(sha))
    },
  )
  watch(
    () => [repository.activeTabId, repository.repo.path, repository.repo.head],
    () => {
      selectedCommits.value = []
    },
  )
  watch(
    () => repository.selectedCommit?.hash,
    (sha) => {
      if (!sha) selectedCommits.value = []
      else if (!selectedCommits.value.includes(sha)) selectedCommits.value = [sha]
    },
  )
  const x = ref(0),
    y = ref(0)
  // Chromium hover titles must be cleared before a native menu captures the
  // pointer; its source element may never receive mouseleave.
  function hoverTitle(value: string | null | undefined) {
    return target.value ? undefined : (value ?? undefined)
  }
  function close(restore = true) {
    target.value = null
    if (restore && trigger.value?.isConnected) trigger.value.focus({ preventScroll: true })
  }
  function open(event: MouseEvent | KeyboardEvent, object: MenuObject) {
    event.preventDefault()
    event.stopPropagation()
    if (repository.isNewTab || repository.modal || document.querySelector('dialog[open]')) return
    const container = event.currentTarget as HTMLElement
    const source = event.target as HTMLElement | null
    const focusable = source?.closest?.<HTMLElement>('button, [tabindex]')
    trigger.value = focusable && container.contains(focusable) ? focusable : container
    const bounds = trigger.value.getBoundingClientRect()
    const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)
    x.value = pointer ? event.clientX : bounds.left + Math.min(bounds.width / 2, 120)
    y.value = pointer ? event.clientY : bounds.top + Math.min(bounds.height, 28)
    if (object.kind === 'commit') {
      if (!selectedCommits.value.includes(object.commit.hash))
        selectedCommits.value = [object.commit.hash]
      object = {
        ...object,
        commits: historyCommits.value.filter((c) => selectedCommits.value.includes(c.hash)),
      }
    }
    const frozen = JSON.parse(JSON.stringify(object)) as MenuObject
    target.value = {
      ...frozen,
      repo: repository.repo.path,
      tabId: repository.activeTabId,
      head: repository.repo.head,
      currentBranch: repository.repo.branch,
      ...(object.kind === 'commit'
        ? { commitEligibility: commitEligibility(repository.repo) }
        : {}),
      navigationSource:
        container.closest<HTMLElement>('[data-navigation-key]')?.dataset.navigationKey || '',
    }
  }
  function keyboard(event: KeyboardEvent, object: MenuObject) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, object)
  }
  return {
    historyCommits,
    target,
    trigger,
    selectedCommits,
    x,
    y,
    open,
    keyboard,
    close,
    hoverTitle,
  }
})
