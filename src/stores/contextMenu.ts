import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { Branch, Commit, StashEntry } from '../types'
import { useRepositoryStore } from './repository'
import type { SidebarSection } from '../sidebar'

export type MenuObject =
  | { kind: 'stash'; stash: StashEntry }
  | { kind: 'branch'; branch: Branch }
  | { kind: 'commit'; commit: Commit }
  | { kind: 'section'; section: SidebarSection }
  | { kind: 'worktree' | 'background' | 'columns' }
export type MenuContext = MenuObject & {
  repo: string
  tabId: number
  head: string
  currentBranch: string
  navigationSource?: string
}

export { branchReference } from '../references'
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
  const target = shallowRef<MenuContext | null>(null)
  const trigger = shallowRef<HTMLElement | null>(null)
  const x = ref(0),
    y = ref(0)
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
    const frozen = JSON.parse(JSON.stringify(object)) as MenuObject
    target.value = {
      ...frozen,
      repo: repository.repo.path,
      tabId: repository.activeTabId,
      head: repository.repo.head,
      currentBranch: repository.repo.branch,
      navigationSource:
        container.closest<HTMLElement>('[data-navigation-key]')?.dataset.navigationKey || '',
    }
  }
  function keyboard(event: KeyboardEvent, object: MenuObject) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, object)
  }
  return { target, trigger, x, y, open, keyboard, close }
})
