<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, useId } from 'vue'
import { isCommitShaQuery } from '../historyPaging'
import { useRepositoryStore } from '../stores/repository'
import { buildHistoryGraph, HISTORY_ROW_HEIGHT, type GraphNavigationArrow } from '../graph'
import { ideaGraphLayout } from '../ideaGraphLayout'
import {
  defaultGraphViewport,
  graphPaint,
  paintHistoryGraph,
  graphArrowPath,
  graphArrowHit,
} from '../graphPainting'
import type { Commit, StashEntry, CommitMetadata } from '../types'
import Icon from './Icon.vue'
import { desktop } from '../services/desktop'
import { getUIPlatform } from '../services/platform'
import ReferenceBadge from './ReferenceBadge.vue'
import BranchInlineForm from './BranchInlineForm.vue'
import {
  resolveCommitReferences,
  groupCommitReferences,
  type CommitReference,
  type ReferenceGroup,
} from '../referenceLabels'
import DiffViewer from './DiffViewer.vue'
import HistoryFilters from './HistoryFilters.vue'
import { useHistoryQueryStore } from '../stores/historyQuery'
import { useHistoryToolsStore } from '../stores/historyTools'
import { useContextMenuStore } from '../stores/contextMenu'
import { useStashStore } from '../stores/stash'
import { branchReference } from '../references'
import { useGraphViewStore } from '../stores/graphView'
import { useFontStore } from '../stores/fonts'

const store = useRepositoryStore()
const historyQuery = useHistoryQueryStore()
const displayCommits = computed(() =>
  historyQuery.enabled ? historyQuery.commits : store.visibleCommits,
)
const graphSource = computed(() =>
  historyQuery.enabled ? historyQuery.commits : store.repo.commits,
)
watch(
  () =>
    [
      store.repo.path,
      store.activeTabId,
      store.repo.history?.token,
      store.query,
      store.branchFilter,
      historyQuery.filters.author,
      historyQuery.filters.path,
      historyQuery.filters.since,
      historyQuery.filters.until,
    ] as const,
  () => {
    const filters = historyQuery.filters
    const active =
      !!store.repo.history &&
      ((!!store.query.trim() && !isCommitShaQuery(store.query)) ||
        !!filters.author ||
        !!filters.path ||
        !!filters.since ||
        !!filters.until)
    historyQuery.configure(
      `${store.activeTabId}:${store.repo.path}`,
      {
        repo: store.repo.path,
        token: store.repo.history?.token || '',
        query: isCommitShaQuery(store.query) ? '' : store.query.trim(),
        branch: store.branchFilter,
      },
      active,
    )
  },
  { immediate: true },
)
function selectHistoryCommit(commit: Commit, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    const removing = menu.selectedCommits.includes(commit.hash)
    menu.selectedCommits = menu.selectedCommits.includes(commit.hash)
      ? menu.selectedCommits.filter((sha) => sha !== commit.hash)
      : [...menu.selectedCommits, commit.hash]
    if (removing) {
      const remaining = graphSource.value.find((c) => menu.selectedCommits.includes(c.hash))
      if (remaining) void store.selectCommit(remaining)
      else store.clearSelection()
      return
    }
  } else if (event.shiftKey && menu.selectedCommits.length) {
    const visible = displayCommits.value
    const start = visible.findIndex((c) => c.hash === menu.selectedCommits[0])
    const end = visible.findIndex((c) => c.hash === commit.hash)
    menu.selectedCommits =
      start < 0 || end < 0
        ? [commit.hash]
        : visible.slice(Math.min(start, end), Math.max(start, end) + 1).map((c) => c.hash)
  } else menu.selectedCommits = [commit.hash]
  void store.selectCommit(commit)
}
const graphView = useGraphViewStore()
const fonts = useFontStore()
const graphBranches = computed(() =>
  graphView.visibleBranches(store.repo.path, store.repo.branches),
)
const graphReferenceKeys = computed(() => new Set(graphBranches.value.map(branchReference)))
function resolveVisibleReferences(commit: Commit) {
  return resolveCommitReferences(commit, store.repo.branches).filter(
    (reference) => !reference.branch || graphReferenceKeys.value.has(reference.key),
  )
}
const menu = useContextMenuStore()
const stash = useStashStore()
const historyPanel = ref<HTMLElement>()
const historySvg = ref<SVGSVGElement>()
const viewport = ref({ ...defaultGraphViewport })
const paint = computed(() => graphPaint(viewport.value))
const referenceStarts = ref(new Map<string, number>())
let referenceMeasureNeeded = true
const searchInput = ref<HTMLInputElement>()
const searchFocused = ref(false)
const searchShortcut = getUIPlatform() === 'macos' ? '⌘ K' : 'Ctrl K'
const refsPopover = ref<HTMLElement>()
const refsCommit = ref<Commit | null>(null)
let refsVersion = 0
const referenceTailInset = 6
const pointerExpandedReference = ref(''),
  focusedExpandedReference = ref('')
let refsTrigger: HTMLElement | null = null
let refsAnchor: DOMRect | null = null
let refsOriginKey = '',
  refsOriginHash = ''
const searching = computed(
  () => historyQuery.enabled || !!store.query.trim() || !!store.branchFilter,
)
const visibleStashes = computed(() => {
  if (store.repo.history?.focus || historyQuery.enabled) return []
  const term = store.query.trim().toLocaleLowerCase()
  // Stashes belong to the repository. A branch-history filter must not hide them.
  return stash.entries.filter(
    (entry) =>
      !term || `${entry.message} ${entry.branch} ${entry.oid}`.toLocaleLowerCase().includes(term),
  )
})
const showWorktree = computed(
  () => store.changes > 0 && !store.repo.history?.focus && !historyQuery.enabled,
)
const layoutBasis = computed(
  () => ideaGraphLayout(graphSource.value, store.repo.branches, !!store.repo.history).identities,
)
const rawGraph = computed(() =>
  buildHistoryGraph(
    displayCommits.value,
    visibleStashes.value,
    showWorktree.value,
    !!store.repo.history && !historyQuery.enabled && (!store.query.trim() || shaQuery.value),
    graphBranches.value,
    !graphView.showLongEdges,
    layoutBasis.value,
    graphSource.value,
  ),
)
const graph = computed(() => paintHistoryGraph(rawGraph.value, viewport.value))
const relative = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`
  return new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
const nodeColors = computed(() => new Map(graph.value.nodes.map((node) => [node.hash, node.color])))
const referenceData = computed(
  () =>
    new Map(
      displayCommits.value.map((commit) => {
        const references = resolveVisibleReferences(commit)
        return [commit.hash, { references, groups: groupCommitReferences(references) }]
      }),
    ),
)
function references(commit: Commit) {
  return referenceData.value.get(commit.hash)?.references || resolveVisibleReferences(commit)
}
function referenceGroups(commit: Commit): ReferenceGroup[] {
  return referenceData.value.get(commit.hash)?.groups || groupCommitReferences(references(commit))
}
const referenceHashes = computed(
  () =>
    new Set(
      [...referenceData.value].filter(([, data]) => data.groups.length).map(([hash]) => hash),
    ),
)
const currentReferenceHash = computed(
  () => store.repo.branches.find((branch) => branch.kind === 'local' && branch.current)?.hash || '',
)
// The whole guide is drawn in SVG, so CSS tails cannot drift from its endpoint.
const referenceNodes = computed(() =>
  (graphView.labelsAfterMessage ? [] : graph.value.nodes)
    .filter((node) => referenceHashes.value.has(node.hash))
    .map((node) => ({
      ...node,
      guideX: paint.value.x(referenceStarts.value.get(node.hash) ?? -referenceTailInset),
    }))
    .filter((node) => node.guideX < node.x - paint.value.radius),
)
function measureGraphPainting() {
  const svg = historySvg.value
  const matrix = svg?.getScreenCTM()
  if (!svg || !matrix || matrix.a <= 0 || matrix.d <= 0) return
  const ratio = window.devicePixelRatio || 1
  const next = {
    ratio,
    scaleX: matrix.a,
    scaleY: matrix.d,
    phaseX: (((matrix.e * ratio) % 1) + 1) % 1,
    phaseY: (((matrix.f * ratio) % 1) + 1) % 1,
  }
  if (JSON.stringify(next) !== JSON.stringify(viewport.value)) viewport.value = next
  if (!referenceMeasureNeeded) return
  referenceMeasureNeeded = false
  const inverse = matrix.inverse()
  const starts = new Map<string, number>()
  historyPanel.value
    ?.querySelectorAll<HTMLElement>('.commit-row[data-commit-hash] .ref-labels')
    .forEach((labels) => {
      const row = labels.closest<HTMLElement>('.commit-row')
      const badge = labels.querySelector('.ref-labels-content') || labels
      if (!row) return
      const bounds = badge.getBoundingClientRect()
      const local = new DOMPoint(bounds.right, bounds.top).matrixTransform(inverse)
      starts.set(row.dataset.commitHash!, local.x)
    })
  if (JSON.stringify([...starts]) !== JSON.stringify([...referenceStarts.value]))
    referenceStarts.value = starts
}
watch(
  [
    rawGraph,
    referenceData,
    pointerExpandedReference,
    focusedExpandedReference,
    () => graphView.labelsAfterMessage,
    () => graphView.labelStyle,
    () => JSON.stringify(fonts.settings.code),
  ],
  () => {
    referenceMeasureNeeded = true
    void nextTick(updateExpandedReferences)
  },
  { flush: 'post' },
)
function updateExpansionLimit(group: HTMLElement) {
  const panelBounds = historyPanel.value?.getBoundingClientRect()
  const right = Math.min(window.innerWidth, panelBounds?.right || window.innerWidth)
  const left = Math.max(0, panelBounds?.left || 0) + 8
  group.style.setProperty(
    '--ref-expanded-limit',
    `${graphView.labelsAfterMessage ? Math.min(640, Math.max(0, right - left - 8)) : Math.max(group.getBoundingClientRect().width, Math.min(640, right - group.getBoundingClientRect().left - 8))}px`,
  )
  const content = group.querySelector<HTMLElement>('.ref-labels-content')
  const anchor = group.getBoundingClientRect().right
  const width = content?.getBoundingClientRect().width || 0
  const offset = graphView.labelsAfterMessage
    ? anchor - Math.max(left + width, Math.min(anchor, right - 8))
    : 0
  group.style.setProperty('--ref-expanded-right', `${offset}px`)
}
function expandFromPointer(commit: Commit, event: MouseEvent) {
  if (menu.target) return
  const group = (event.currentTarget as HTMLElement).closest<HTMLElement>('.ref-labels')
  if (group) {
    updateExpansionLimit(group)
    pointerExpandedReference.value = commit.hash
    void nextTick(() => updateExpansionLimit(group))
  }
}
function referenceFocusIn(commit: Commit, event: FocusEvent) {
  if (menu.target) return
  if ((event.target as HTMLElement).matches(':focus-visible')) {
    const group = event.currentTarget as HTMLElement
    updateExpansionLimit(group)
    focusedExpandedReference.value = commit.hash
    void nextTick(() => updateExpansionLimit(group))
  }
}
function referenceFocusOut(commit: Commit, event: FocusEvent) {
  if (
    !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null) &&
    focusedExpandedReference.value === commit.hash
  )
    focusedExpandedReference.value = ''
}
function referencePointerLeave(commit: Commit) {
  if (pointerExpandedReference.value === commit.hash) pointerExpandedReference.value = ''
}
function updateExpandedReferences(event?: Event) {
  if (event?.type === 'scroll') closeReferences()
  else positionReferences(event?.type === 'resize')
  if (event?.type === 'scroll') hideArrowHint()
  if (event?.type === 'resize') referenceMeasureNeeded = true
  historyPanel.value
    ?.querySelectorAll<HTMLElement>('.ref-labels.is-expanded')
    .forEach(updateExpansionLimit)
  measureGraphPainting()
}
let panelResize: ResizeObserver | undefined
function editorFontLoaded() {
  referenceMeasureNeeded = true
  updateExpandedReferences()
}
let ratioQuery: MediaQueryList | undefined
function followPixelRatio() {
  ratioQuery?.removeEventListener('change', pixelRatioChanged)
  ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  ratioQuery.addEventListener('change', pixelRatioChanged)
}
function pixelRatioChanged() {
  referenceMeasureNeeded = true
  measureGraphPainting()
  followPixelRatio()
}
onMounted(() => {
  document.fonts.addEventListener('loadingdone', editorFontLoaded)
  followPixelRatio()
  panelResize = new ResizeObserver(() => {
    referenceMeasureNeeded = true
    updateExpandedReferences()
    positionReferences(true)
  })
  if (historyPanel.value) {
    try {
      panelResize.observe(historyPanel.value, { box: 'device-pixel-content-box' })
    } catch {
      panelResize.observe(historyPanel.value)
    }
  }
  window.addEventListener('resize', updateExpandedReferences)
  window.visualViewport?.addEventListener('resize', updateExpandedReferences)
  measureGraphPainting()
})
onBeforeUnmount(() => {
  document.fonts.removeEventListener('loadingdone', editorFontLoaded)
  panelResize?.disconnect()
  ratioQuery?.removeEventListener('change', pixelRatioChanged)
  window.removeEventListener('resize', updateExpandedReferences)
  window.visualViewport?.removeEventListener('resize', updateExpandedReferences)
})
function moreDescription(commit: Commit) {
  return `另有 ${Math.max(0, referenceGroups(commit).length - 1)} 组引用，查看全部 ${references(commit).length} 个引用：${commit.subject}`
}
function referenceActionLabel(reference: CommitReference) {
  const branch = reference.branch
  return branch?.kind === 'local'
    ? branch.current
      ? `当前分支 ${branch.name}`
      : `切换到本地分支 ${branch.name}`
    : `查看引用 ${reference.rawLabel}`
}
function referenceTitle(group: ReferenceGroup) {
  const reference = group.primary,
    branch = reference.branch
  const identities = group.members
    .map((member) => (member.branch ? member.key : member.rawLabel))
    .join('\n')
  if (branch?.kind !== 'local') return identities
  if (branch.current) return `当前分支 ${branch.name}\n${identities}`
  return `${store.busy ? `操作进行中，暂不能切换到 ${branch.name}` : `单击切换到 ${branch.name}`}\n${identities}`
}
async function activateReference(commit: Commit, reference: CommitReference, event: MouseEvent) {
  event.stopPropagation()
  if (event.detail > 1) return
  const branch = reference.branch
  if (branch?.kind !== 'local') {
    await showReferences(commit, event)
    return
  }
  if (store.busy || store.modal || branch.current) return
  const trigger = event.currentTarget as HTMLElement
  const succeeded = await store.checkoutBranch(branch)
  if (succeeded) {
    await nextTick()
    // The visible reference key changes to HEAD after a successful checkout.
    if (document.activeElement === document.body || document.activeElement === trigger)
      historyPanel.value
        ?.querySelector<HTMLButtonElement>('.ref-tag.current-ref .ref-primary')
        ?.focus({ preventScroll: true })
  }
}
function referenceMenu(
  event: MouseEvent | KeyboardEvent,
  reference: CommitReference,
  commit: Commit,
) {
  const branch = reference.branch
  menu.open(event, branch ? { kind: 'branch', branch } : { kind: 'commit', commit })
}
function referenceKeyboard(event: KeyboardEvent, reference: CommitReference, commit: Commit) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    referenceMenu(event, reference, commit)
}
function selectStashNode(entry: StashEntry) {
  if (store.busy || store.modal) return
  stash.openList(entry)
  void nextTick(() =>
    [...(historyPanel.value?.querySelectorAll<HTMLButtonElement>('.stash-row') || [])]
      .find((row) => row.dataset.stashOid === entry.oid && row.dataset.stashRef === entry.ref)
      ?.focus({ preventScroll: true }),
  )
}
const graphId = `graph-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
const arrowHint = ref<{ key: string; x: number; y: number } | null>(null)
const metadata = ref(new Map<string, CommitMetadata | null>())
const metadataFailures = new Map<string, number>()
function rememberMetadata(key: string, value: CommitMetadata | null) {
  if (metadata.value.size >= 256 && !metadata.value.has(key)) {
    const oldest = metadata.value.keys().next().value!
    metadata.value.delete(oldest)
    metadataFailures.delete(oldest)
  }
  metadata.value.set(key, value)
  if (value) metadataFailures.delete(key)
  else metadataFailures.set(key, Date.now())
}
let metadataPending = false
let graphDisposed = false
const hintedArrow = computed(() =>
  graph.value.arrows.find((arrow) => arrow.key === arrowHint.value?.key),
)
const hintMetadata = computed(() => {
  const arrow = hintedArrow.value
  if (!arrow) return null
  return (
    graphSource.value.find((commit) => commit.hash === arrow.targetHash) ||
    metadata.value.get(
      `${store.repo.path}\0${store.repo.history?.signature || ''}\0${arrow.targetHash}`,
    ) ||
    null
  )
})
const hintUnavailable = computed(
  () =>
    !!hintedArrow.value &&
    !displayCommits.value.some((commit) => commit.hash === hintedArrow.value?.targetHash),
)
const hintDate = computed(() => {
  const value = hintMetadata.value?.date
  return value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
    : ''
})
async function loadArrowMetadata() {
  const arrow = hintedArrow.value
  if (!arrow || metadataPending || hintMetadata.value || graphDisposed) return
  const path = store.repo.path,
    hash = arrow.targetHash,
    key = `${path}\0${store.repo.history?.signature || ''}\0${hash}`
  if (metadata.value.has(key)) {
    if (metadata.value.get(key) || Date.now() - (metadataFailures.get(key) || 0) < 5000) return
    metadata.value.delete(key)
  }
  metadataPending = true
  try {
    const value = await desktop.historyMetadata(path, hash)
    if (!graphDisposed) rememberMetadata(key, value)
  } catch {
    if (!graphDisposed) rememberMetadata(key, null)
  } finally {
    metadataPending = false
    if (!graphDisposed && hintedArrow.value?.targetHash !== hash) void loadArrowMetadata()
  }
}
function showArrowHint(arrow: GraphNavigationArrow, event: MouseEvent | FocusEvent) {
  if (menu.target) return
  const bounds = (event.currentTarget as Element).getBoundingClientRect()
  const x = event instanceof MouseEvent ? event.clientX : bounds.right
  const y = event instanceof MouseEvent ? event.clientY : bounds.top
  arrowHint.value = {
    key: arrow.key,
    x: Math.max(8, Math.min(x + 6, window.innerWidth - 338)),
    y: Math.max(8, Math.min(y + 8, window.innerHeight - 150)),
  }
  void loadArrowMetadata()
}
function hideArrowHint() {
  arrowHint.value = null
}
function graphArrowTitle(arrow: GraphNavigationArrow) {
  const target = graphSource.value.find((commit) => commit.hash === arrow.targetHash)
  return `${arrow.direction === 'down' ? '向下跳转到父提交' : '向上跳转到子提交'} ${arrow.targetHash.slice(0, 7)}${target ? ` · ${target.subject}` : ''}`
}
watch(
  [
    () => store.activeTabId,
    () => store.repo.path,
    () => store.modal,
    () => store.query,
    () => store.branchFilter,
    () => graphView.showLongEdges,
    () => store.repo.history?.token,
  ],
  hideArrowHint,
)
onBeforeUnmount(() => {
  graphDisposed = true
})
async function jumpGraphArrow(arrow: GraphNavigationArrow, event: MouseEvent | KeyboardEvent) {
  if (store.busy || store.modal || store.historyLoading) return
  const target = displayCommits.value.find((commit) => commit.hash === arrow.targetHash)
  if (!target) {
    showArrowHint(arrow, event as MouseEvent)
    return
  }
  hideArrowHint()
  const tab = store.activeTabId
  const pending = store.selectCommit(target)
  await nextTick()
  if (tab !== store.activeTabId || store.selectedCommit?.hash !== target.hash) return
  const row = [...(historyPanel.value?.querySelectorAll<HTMLElement>('.commit-row') || [])].find(
    (element) => element.dataset.commitHash === target.hash,
  )
  const scroller = historyScroll.value
  if (row && scroller) {
    const bounds = row.getBoundingClientRect()
    const visible = scroller.getBoundingClientRect()
    const headerHeight =
      historyPanel.value?.querySelector('.table-head')?.getBoundingClientRect().height || 0
    const top = visible.top + headerHeight
    if (bounds.top < top) scroller.scrollTop += bounds.top - top
    else if (bounds.bottom > visible.bottom) scroller.scrollTop += bounds.bottom - visible.bottom
  }
  row?.querySelector<HTMLButtonElement>('.commit-select')?.focus({ preventScroll: true })
  await pending
}
function nodeMenu(event: MouseEvent, hash: string) {
  const commit = displayCommits.value.find((c) => c.hash === hash)
  if (commit) menu.open(event, { kind: 'commit', commit })
}
async function showReferences(commit: Commit, event: MouseEvent) {
  if (menu.target) return
  const version = ++refsVersion
  refsCommit.value = commit
  refsTrigger = event.currentTarget as HTMLElement
  refsAnchor = refsTrigger.getBoundingClientRect()
  refsOriginKey =
    refsTrigger.closest<HTMLElement>('[data-reference-key]')?.dataset.referenceKey || ''
  refsOriginHash = commit.hash
  await nextTick()
  if (version !== refsVersion || !refsTrigger?.isConnected) return
  refsPopover.value?.showPopover()
  positionReferences()
  refsPopover.value
    ?.querySelector<HTMLButtonElement>('.reference-popup-action')
    ?.focus({ preventScroll: true })
}
function positionReferences(followAnchor = false) {
  const popup = refsPopover.value
  if (!popup?.matches(':popover-open') || !refsTrigger?.isConnected) return
  if (followAnchor || !refsAnchor) refsAnchor = refsTrigger.getBoundingClientRect()
  const anchor = refsAnchor
  const bounds = popup.getBoundingClientRect()
  const left = graphView.labelsAfterMessage ? anchor.right - bounds.width : anchor.left
  const top =
    anchor.bottom + 4 + bounds.height <= window.innerHeight - 8
      ? anchor.bottom + 4
      : anchor.top - bounds.height - 4
  popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`
  popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`
}
function closeReferences(restore = false) {
  refsVersion++
  refsPopover.value?.hidePopover()
  refsCommit.value = null
  refsAnchor = null
  if (restore) restoreReferenceFocus()
}
function referencesToggled() {
  if (!refsPopover.value?.matches(':popover-open')) {
    refsVersion++
    refsCommit.value = null
  }
}
function referencesKeyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeReferences(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [
    ...(refsPopover.value?.querySelectorAll<HTMLButtonElement>('.reference-popup-action') || []),
  ]
  if (!buttons.length) return
  event.preventDefault()
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  ]?.focus()
}
function popupReferenceMenu(event: MouseEvent | KeyboardEvent, reference: CommitReference) {
  const commit = refsCommit.value
  if (!commit) return
  referenceMenu(event, reference, commit)
  menu.trigger = refsTrigger
  closeReferences()
}
async function popupReferenceActivate(reference: CommitReference, event: MouseEvent) {
  const commit = refsCommit.value
  if (!commit) return
  if (reference.branch?.kind === 'local') {
    if (store.busy) return
    closeReferences(true)
    await activateReference(commit, reference, event)
  } else popupReferenceMenu(event, reference)
}
function restoreReferenceFocus() {
  refsCommit.value = null
  if (refsTrigger?.isConnected) {
    refsTrigger.focus({ preventScroll: true })
    return
  }
  const badges = [...(historyPanel.value?.querySelectorAll<HTMLElement>('.ref-tag') || [])]
  const target =
    badges.find((badge) => badge.dataset.referenceKey === refsOriginKey) ||
    badges.find(
      (badge) =>
        badge.closest<HTMLElement>('[data-commit-hash]')?.dataset.commitHash === refsOriginHash,
    )
  ;(target?.querySelector<HTMLButtonElement>('.ref-primary') || searchInput.value)?.focus({
    preventScroll: true,
  })
}
watch(
  () => store.activeTabId,
  () => {
    closeReferences()
    pointerExpandedReference.value = ''
    focusedExpandedReference.value = ''
  },
)
watch(
  () => store.repo,
  () => closeReferences(),
)
watch(
  () => store.modal,
  () => closeReferences(),
)
watch(
  () => menu.target,
  (target) => {
    if (!target) return
    closeReferences()
    hideArrowHint()
    pointerExpandedReference.value = ''
    focusedExpandedReference.value = ''
  },
  { flush: 'sync' },
)
function focusSearch() {
  useHistoryToolsStore().active = ''
  void nextTick(focusSearchInput)
}
function focusSearchInput() {
  const input = searchInput.value
  if (!input) return
  input.focus({ preventScroll: true })
  input.select()
  input.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
defineExpose({ focusSearch })
watch([() => store.query, () => store.branchFilter, () => graphView.labelsAfterMessage], () =>
  closeReferences(),
)
const shaQuery = computed(() => !!store.repo.history && isCommitShaQuery(store.query))
const historyScroll = ref<HTMLElement>()
async function locateSha() {
  if (shaQuery.value && (await store.loadHistory('locate', store.query.trim()))) {
    await nextTick()
    historyScroll.value?.scrollTo({ top: 0 })
    historyPanel.value
      ?.querySelector<HTMLButtonElement>('.commit-row.selected .commit-select')
      ?.focus({ preventScroll: true })
  }
}
async function loadMore() {
  const element = historyScroll.value
  const top = element?.scrollTop || 0
  const hash = store.selectedCommit?.hash
  await store.loadHistory()
  await nextTick()
  if (element && store.selectedCommit?.hash === hash) element.scrollTop = top
}
function clearHistoryFilters() {
  store.query = ''
  historyQuery.clear()
  store.clearBranchFilter()
}
</script>

<template>
  <main
    ref="historyPanel"
    class="history-panel"
    :data-label-style="graphView.labelStyle"
    :class="{
      'show-author': store.showAuthor,
      'show-time': store.showTime,
      'show-sha': store.showSha,
      'labels-after-message': graphView.labelsAfterMessage,
    }"
    :style="{
      '--history-row-height': `${HISTORY_ROW_HEIGHT}px`,
      '--ref-tail-inset': `${referenceTailInset}px`,
      '--author-width': store.showAuthor ? '100px' : '0px',
      '--time-width': store.showTime ? '78px' : '0px',
      '--sha-width': store.showSha ? '90px' : '0px',
    }"
  >
    <header class="panel-header history-heading">
      <div class="panel-title">
        <Icon name="History" /><strong>提交历史</strong
        ><span class="pill">{{ store.repo.total }}</span>
      </div>
      <label class="commit-search"
        ><Icon
          name="Search"
          :size="14" /><input
          autocomplete="off"
          ref="searchInput"
          v-model="store.query"
          placeholder="搜索全部历史的提交说明"
          :title="menu.hoverTitle('搜索本地全部历史；7 至 64 位 SHA 可定位提交')"
          @keydown.enter.prevent="locateSha"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
          aria-label="搜索提交" /><kbd v-if="!store.query">{{ searchShortcut }}</kbd
        ><span
          v-if="searchFocused && !store.query.trim() && !store.repo.history?.focus"
          class="commit-search-hint"
          role="status"
          >搜索本地已有的全部提交历史</span
        ><button
          v-if="store.query"
          class="icon-button"
          aria-label="清除搜索"
          @click="store.query = ''"
        >
          <Icon
            name="X"
            :size="12"
          /></button
      ></label>
    </header>
    <HistoryFilters />
    <div
      v-if="store.historyPreferenceWarning"
      class="history-scope-banner"
      role="status"
    >
      {{ store.historyPreferenceWarning }}
    </div>
    <div
      v-if="store.repo.history?.focus"
      class="history-scope-banner"
      role="status"
    >
      <span>定位视图 · {{ store.repo.history.focus.slice(0, 12) }} 及其祖先</span>
      <button
        class="text-button"
        :disabled="store.historyLoading || store.busy"
        @click="store.loadHistory('reset')"
      >
        返回全部历史
      </button>
    </div>
    <div
      v-else-if="store.query.trim()"
      class="history-scope-banner"
      role="status"
    >
      <span>{{
        shaQuery
          ? 'SHA 定位：按 Enter 查找提交'
          : '筛选本地历史；未显示的提交不会被当作直接父子关系'
      }}</span>
      <button
        v-if="shaQuery && store.repo.history"
        class="text-button"
        :disabled="store.historyLoading || store.busy"
        @click="locateSha"
      >
        {{ store.historyLoading ? '正在定位…' : '按 SHA 定位' }}
      </button>
    </div>
    <div
      v-if="
        store.repo.branches.some((branch) => graphView.isHidden(store.repo.path, branch)) ||
        graphView.soloActive(store.repo.path, store.repo.branches)
      "
      class="filter-banner"
      role="status"
    >
      <span>{{
        graphView.soloActive(store.repo.path, store.repo.branches)
          ? 'Solo：仅显示选定引用的历史'
          : '部分引用已从图谱隐藏'
      }}</span>
      <button @click="graphView.reset(store.repo.path)">显示全部引用</button>
      <span v-if="graphView.warning">{{ graphView.warning }}</span>
    </div>
    <div
      v-if="store.branchFilter"
      class="filter-banner"
    >
      <Icon
        name="GitBranch"
        :size="13"
      /><span>正在查看 {{ store.branchFilterLabel }}</span
      ><button @click="store.clearBranchFilter()">
        显示全部
        <Icon
          name="X"
          :size="12"
        />
      </button>
    </div>
    <div
      ref="historyScroll"
      class="history-scroll"
      tabindex="0"
      aria-label="提交图谱"
      @scroll="updateExpandedReferences"
      @contextmenu="menu.open($event, { kind: 'background' })"
      @keydown="menu.keyboard($event, { kind: 'background' })"
    >
      <div
        class="history-table"
        :style="{ '--graph-width': `${graph.recommendedWidth}px` }"
      >
        <div
          class="table-head commit-grid"
          tabindex="0"
          aria-label="历史列表显示列"
          @contextmenu="menu.open($event, { kind: 'columns' })"
          @keydown="menu.keyboard($event, { kind: 'columns' })"
        >
          <span class="reference-heading">分支 / 标签</span><span>图谱</span
          ><span>{{ graphView.labelsAfterMessage ? '提交说明 / 分支标签' : '提交说明' }}</span
          ><span class="author-heading">作者</span><span class="time-cell">时间</span
          ><span class="sha-cell">SHA</span>
        </div>
        <div class="history-body">
          <svg
            ref="historySvg"
            class="commit-graph"
            :width="graph.width"
            :height="(graph.rows.length + graph.rowOffset) * HISTORY_ROW_HEIGHT"
            aria-label="提交关系图"
          >
            <g
              class="reference-connectors"
              aria-hidden="true"
              pointer-events="none"
            >
              <line
                v-for="node in referenceNodes"
                :key="node.hash"
                :data-reference-hash="node.hash"
                :class="{ 'is-current-reference': node.hash === currentReferenceHash }"
                :x1="node.guideX"
                :x2="node.x"
                :y1="node.y"
                :y2="node.y"
                :stroke="node.color"
                :stroke-width="paint.lineWidth"
              />
            </g>
            <path
              v-for="(edge, i) in graph.edges"
              :key="i"
              :data-child-hash="edge.childHash"
              :data-parent-hash="edge.parentHash"
              :d="edge.d"
              :stroke="edge.color"
              :stroke-dasharray="edge.boundary || edge.dotted ? '3 3' : undefined"
              :stroke-width="paint.lineWidth"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              v-for="edge in graph.stashEdges"
              :key="edge.childHash"
              class="stash-base-edge"
              :data-stash-child="edge.childHash"
              :data-stash-base="edge.parentHash"
              :d="edge.d"
              :stroke="edge.color"
              :stroke-width="paint.lineWidth"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-dasharray="3 3"
              fill="none"
            />
            <g
              v-for="node in graph.stashNodes"
              :key="node.key"
              :data-stash-node="node.hash"
              class="stash-graph-node"
              @click="selectStashNode(node.entry)"
              @contextmenu="menu.open($event, { kind: 'stash', stash: node.entry })"
            >
              <title v-if="!menu.target">
                {{ node.entry.message }} ·
                {{
                  node.boundary
                    ? `创建时的基础提交 ${node.baseHash.slice(0, 7)} 不在当前视图`
                    : `创建时的基础提交 ${node.baseHash.slice(0, 7)}`
                }}
              </title>
              <rect
                :x="node.x - 6"
                :y="node.y - 5"
                width="12"
                height="10"
                rx="2"
                fill="var(--bg)"
                :stroke="node.color"
                stroke-width="1.7"
              />
              <path
                :d="`M${node.x - 6} ${node.y - 1}h12m-8 3h4`"
                :stroke="node.color"
                fill="none"
                stroke-width="1.4"
              />
              <rect
                v-if="
                  store.selectedStash?.oid === node.entry.oid &&
                  store.selectedStash?.ref === node.entry.ref
                "
                class="graph-selection-ring stash-selection-ring"
                :x="node.x - 9"
                :y="node.y - 8"
                width="18"
                height="16"
                rx="4"
                fill="none"
                :stroke="node.color"
                :stroke-width="paint.selectionWidth"
              />
            </g>
            <circle
              v-if="showWorktree && !searching"
              :cx="graph.worktree.x"
              :cy="graph.worktree.y"
              :r="paint.radius + 1"
              fill="var(--bg)"
              :stroke="graph.worktree.color"
              :stroke-width="paint.lineWidth"
              stroke-dasharray="2 2"
            />
            <g v-if="showWorktree && !searching && !store.selectedCommit && !store.selectedStash">
              <circle
                class="graph-selection-ring worktree-selection-ring"
                :cx="graph.worktree.x"
                :cy="graph.worktree.y"
                :r="paint.selectionRadius"
                fill="none"
                :stroke="graph.worktree.color"
                :stroke-width="paint.selectionWidth"
              />
            </g>
            <g
              v-for="(arrow, index) in graph.arrows"
              :key="arrow.key"
              class="graph-jump-arrow"
              :class="{ 'is-hovered': arrowHint?.key === arrow.key }"
              :aria-disabled="store.busy || !!store.modal || store.historyLoading"
              @mouseenter="showArrowHint(arrow, $event)"
              @mousemove="showArrowHint(arrow, $event)"
              @mouseleave="hideArrowHint"
              @click.stop="jumpGraphArrow(arrow, $event)"
            >
              <defs>
                <clipPath :id="`${graphId}-arrow-${index}`">
                  <rect
                    x="0"
                    :y="arrow.rowTop"
                    :width="graph.width"
                    :height="HISTORY_ROW_HEIGHT"
                  />
                </clipPath>
              </defs>
              <g :clip-path="`url(#${graphId}-arrow-${index})`">
                <ellipse
                  class="graph-arrow-hit"
                  :cx="graphArrowHit(arrow, paint.lineWidth).cx"
                  :cy="graphArrowHit(arrow, paint.lineWidth).cy"
                  :rx="graphArrowHit(arrow, paint.lineWidth).rx"
                  :ry="graphArrowHit(arrow, paint.lineWidth).ry"
                  :transform="`rotate(${graphArrowHit(arrow, paint.lineWidth).angle} ${graphArrowHit(arrow, paint.lineWidth).cx} ${graphArrowHit(arrow, paint.lineWidth).cy})`"
                />
                <path
                  class="graph-arrow-mark"
                  :d="`M${arrow.fromX} ${arrow.fromY} L${arrow.x} ${arrow.y}`"
                  fill="none"
                  :stroke-width="paint.lineWidth + 2 / viewport.ratio"
                />
                <path
                  class="graph-arrow-mark"
                  :d="graphArrowPath(arrow)"
                  fill="none"
                  :stroke-width="paint.arrowWidth + 2 / viewport.ratio"
                />
                <path
                  class="graph-arrow-segment"
                  :d="`M${arrow.fromX} ${arrow.fromY} L${arrow.x} ${arrow.y}`"
                  fill="none"
                  :stroke="arrow.color"
                  :stroke-width="paint.lineWidth"
                  stroke-linecap="round"
                />
                <path
                  class="graph-arrow-head"
                  role="button"
                  tabindex="0"
                  :data-graph-arrow="arrow.direction"
                  :data-arrow-target="arrow.targetHash"
                  :aria-label="graphArrowTitle(arrow)"
                  :aria-describedby="arrowHint?.key === arrow.key ? `${graphId}-hint` : undefined"
                  :aria-disabled="store.busy || !!store.modal || store.historyLoading"
                  @focus="showArrowHint(arrow, $event)"
                  @blur="hideArrowHint"
                  @keydown.enter.prevent="jumpGraphArrow(arrow, $event)"
                  @keydown.space.prevent="jumpGraphArrow(arrow, $event)"
                  @keydown.esc.prevent="hideArrowHint"
                  :d="graphArrowPath(arrow)"
                  fill="none"
                  :stroke="arrow.color"
                  :stroke-width="paint.arrowWidth"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </g>
            </g>
            <g
              v-for="node in graph.nodes"
              :key="node.hash"
              :data-node-hash="node.hash"
              tabindex="-1"
              @contextmenu="nodeMenu($event, node.hash)"
            >
              <circle
                :cx="node.x"
                :cy="node.y"
                :r="paint.radius"
                :fill="node.merge ? 'var(--bg)' : node.color"
                :stroke="node.color"
                :stroke-width="node.merge ? paint.lineWidth : 0"
              />
              <circle
                v-if="store.selectedCommit?.hash === node.hash"
                class="node-selection-ring graph-selection-ring"
                :cx="node.x"
                :cy="node.y"
                :r="paint.selectionRadius"
                fill="none"
                :stroke="node.color"
                :stroke-width="paint.selectionWidth"
              />
              <circle
                v-if="node.merge"
                class="merge-node-center"
                :cx="node.x"
                :cy="node.y"
                r="1.5"
                :fill="node.color"
              />
            </g>
          </svg>
          <button
            v-if="showWorktree"
            class="wip-row commit-grid"
            @contextmenu="menu.open($event, { kind: 'worktree' })"
            @keydown="menu.keyboard($event, { kind: 'worktree' })"
            :class="{ selected: !store.selectedCommit && !store.selectedStash }"
            @click="store.clearSelection()"
          >
            <span class="worktree-tag"
              ><Icon
                name="FolderGit2"
                :size="13"
              />工作区</span
            ><span></span
            ><span class="wip-message"
              ><span
                v-if="graphView.labelsAfterMessage"
                class="inline-kind-label"
                >工作区</span
              ><strong>未提交的更改</strong
              ><span class="wip-count">{{ store.changes }} 个文件</span></span
            ><span class="wip-owner">本机</span
            ><span class="time-cell"><span class="live-dot"></span>现在</span>
          </button>
          <template
            v-for="row in graph.rows"
            :key="row.kind === 'stash' ? row.stash.ref + row.stash.oid : row.commit.hash"
          >
            <button
              v-if="row.kind === 'stash'"
              class="stash-row commit-grid"
              :style="{
                '--row-graph-width': `${graph.stashRowWidths.get(`stash:${row.stash.ref}:${row.stash.oid}`) || graph.recommendedWidth}px`,
              }"
              :data-stash-oid="row.stash.oid"
              :data-stash-ref="row.stash.ref"
              :aria-pressed="
                stash.selected?.oid === row.stash.oid && stash.selected?.ref === row.stash.ref
              "
              :class="{
                selected:
                  stash.selected?.oid === row.stash.oid && stash.selected?.ref === row.stash.ref,
              }"
              v-overflow-title="{
                text: menu.hoverTitle(row.stash.message),
                target: '.stash-row-message',
              }"
              :aria-label="`查看贮藏 ${row.stash.message}`"
              :disabled="store.busy"
              @click="stash.openList(row.stash)"
              @contextmenu="menu.open($event, { kind: 'stash', stash: row.stash })"
              @keydown="menu.keyboard($event, { kind: 'stash', stash: row.stash })"
            >
              <span class="stash-row-label"
                ><Icon
                  name="Archive"
                  :size="12"
                />贮藏</span
              ><span></span
              ><span class="stash-row-message"
                ><span
                  v-if="graphView.labelsAfterMessage"
                  class="inline-kind-label"
                  >贮藏</span
                >{{ row.stash.message.replace(/^(?:On|WIP on) [^:]+:\s*/, '') }}</span
              ><span
                class="author-cell"
                aria-hidden="true"
              ></span
              ><span class="time-cell">{{ relative(row.stash.date) }}</span
              ><span class="sha-cell">{{ row.stash.oid.slice(0, 7) }}</span>
            </button>
            <template
              v-for="commit in row.kind === 'commit' ? [row.commit] : []"
              :key="commit.hash"
              ><div
                class="commit-row commit-grid"
                tabindex="-1"
                :data-commit-hash="commit.hash"
                :style="{
                  '--row-color': nodeColors.get(commit.hash),
                  '--row-graph-width': `${graph.rowWidths.get(commit.hash) || graph.recommendedWidth}px`,
                }"
                @contextmenu="menu.open($event, { kind: 'commit', commit })"
                @keydown="menu.keyboard($event, { kind: 'commit', commit })"
                :class="{
                  selected:
                    menu.selectedCommits.includes(commit.hash) ||
                    store.selectedCommit?.hash === commit.hash,
                  'is-merge': graphView.dimMergeCommits && commit.parents.length >= 2,
                }"
              >
                <button
                  class="commit-select"
                  v-overflow-title="{
                    text: menu.hoverTitle(commit.subject),
                    target: '.commit-subject',
                    parent: true,
                  }"
                  :aria-label="`查看提交 ${commit.subject}`"
                  :aria-pressed="store.selectedCommit?.hash === commit.hash"
                  @click="selectHistoryCommit(commit, $event)"
                ></button>
                <Teleport
                  :disabled="!graphView.labelsAfterMessage"
                  :to="`#commit-ref-${commit.hash}`"
                  defer
                >
                  <span
                    class="ref-cell"
                    :class="{
                      'has-reference': referenceHashes.has(commit.hash),
                      'is-current-reference': commit.hash === currentReferenceHash,
                    }"
                    :style="{ '--ref-color': nodeColors.get(commit.hash) }"
                  >
                    <BranchInlineForm
                      v-if="
                        store.modal === 'branch' &&
                        store.inlineBranchActive &&
                        commit.hash === store.repo.head
                      "
                    />
                    <span
                      v-else-if="referenceGroups(commit).length"
                      class="ref-labels"
                      :class="{
                        'is-expanded':
                          pointerExpandedReference === commit.hash ||
                          focusedExpandedReference === commit.hash,
                      }"
                      @mouseleave="referencePointerLeave(commit)"
                      @focusin="referenceFocusIn(commit, $event)"
                      @focusout="referenceFocusOut(commit, $event)"
                    >
                      <span
                        class="ref-labels-sizing"
                        aria-hidden="true"
                        inert
                      >
                        <ReferenceBadge
                          :appearance="graphView.labelStyle"
                          v-for="group in referenceGroups(commit).slice(0, 1)"
                          :key="group.key"
                          :group="group"
                          title=""
                          action-label=""
                          presentation
                        />
                        <span
                          v-if="referenceGroups(commit).length > 1"
                          class="ref-more-sizing"
                          >+{{ referenceGroups(commit).length - 1 }}</span
                        >
                      </span>
                      <span class="ref-labels-content">
                        <ReferenceBadge
                          :appearance="graphView.labelStyle"
                          v-for="group in referenceGroups(commit).slice(0, 1)"
                          :key="group.key"
                          :group="group"
                          :title="referenceTitle(group)"
                          :tooltips-disabled="!!menu.target"
                          :action-label="referenceActionLabel(group.primary)"
                          :busy="store.busy"
                          @expand="(event) => expandFromPointer(commit, event)"
                          @activate="
                            (reference, event) => activateReference(commit, reference, event)
                          "
                          @inspect="(_, event) => showReferences(commit, event)"
                          @menu="(event, reference) => referenceMenu(event, reference, commit)"
                          @keyboard="
                            (event, reference) => referenceKeyboard(event, reference, commit)
                          "
                        />
                        <button
                          v-if="referenceGroups(commit).length > 1"
                          class="ref-more"
                          :title="menu.hoverTitle(moreDescription(commit))"
                          :aria-label="moreDescription(commit)"
                          aria-haspopup="dialog"
                          :aria-expanded="refsCommit?.hash === commit.hash"
                          :aria-controls="`${graphId}-references`"
                          @click="showReferences(commit, $event)"
                        >
                          +{{ referenceGroups(commit).length - 1 }}
                        </button>
                      </span>
                    </span>
                  </span>
                </Teleport>
                <span
                  class="graph-lane-cell"
                  :class="{ 'has-reference': references(commit).length > 0 }"
                ></span
                ><span class="commit-message"
                  ><Icon
                    v-if="commit.parents.length > 1"
                    name="GitMerge"
                    :size="13" /><span class="commit-subject">{{ commit.subject }}</span
                  ><span
                    :id="`commit-ref-${commit.hash}`"
                    v-show="
                      graphView.labelsAfterMessage &&
                      (referenceGroups(commit).length > 0 ||
                        (store.modal === 'branch' &&
                          store.inlineBranchActive &&
                          commit.hash === store.repo.head))
                    "
                    class="commit-ref-target"
                  ></span
                ></span>
                <span class="author-cell"
                  ><span
                    class="avatar"
                    :class="{ violet: commit.author !== displayCommits[0]?.author }"
                    >{{ commit.author.slice(0, 1).toUpperCase() }}</span
                  ><span>{{ commit.author }}</span></span
                >
                <span
                  class="time-cell"
                  :title="menu.hoverTitle(new Date(commit.date).toLocaleString('zh-CN'))"
                  >{{ relative(commit.date) }}</span
                ><span class="sha-cell">{{ commit.hash.slice(0, 7) }}</span>
              </div>
            </template></template
          >
          <div
            v-if="!graph.rows.length"
            class="empty-state"
          >
            <Icon
              :name="searching ? 'Search' : 'GitCommitHorizontal'"
              :size="30"
            /><strong>{{
              store.historyLoading ? '正在读取历史…' : searching ? '没有匹配的提交' : '暂无提交记录'
            }}</strong>
            <p>
              {{
                store.historyLoading
                  ? '正在读取所选引用的历史，请稍候。'
                  : searching
                    ? '请调整搜索条件，或清除分支筛选。'
                    : '暂存文件并填写提交说明，以创建首次提交。'
              }}
            </p>
            <button
              v-if="searching"
              class="text-button"
              @click="clearHistoryFilters"
            >
              清除筛选
            </button>
          </div>
        </div>
      </div>
      <div
        v-if="
          !historyQuery.enabled && store.repo.history?.nextOffset !== null && store.repo.history
        "
        class="history-pagination"
      >
        <span>已加载 {{ graphSource.length }} / {{ store.repo.history.total }} 条</span>
        <button
          class="secondary-button"
          :disabled="store.historyLoading || store.busy"
          @click="loadMore"
        >
          {{ store.historyLoading ? '正在加载…' : '加载更早的 250 条提交' }}
        </button>
      </div>
      <div
        v-else-if="!historyQuery.enabled && graphSource.length"
        class="history-end"
      >
        <span></span
        ><Icon
          name="GitCommitHorizontal"
          :size="14"
        /><small>{{
          searching ? `已加载历史中找到 ${displayCommits.length} 条提交` : '已显示全部可用历史'
        }}</small
        ><span></span>
      </div>
      <div
        v-if="store.historyError"
        class="history-page-error"
        role="alert"
      >
        <span>{{ store.historyError }}</span>
        <button
          class="text-button"
          :disabled="store.historyLoading || store.busy"
          @click="store.loadHistory('reset')"
        >
          重新加载历史
        </button>
      </div>
    </div>
    <div
      v-if="historyQuery.enabled && historyQuery.nextOffset !== null"
      class="history-pagination"
    >
      <span>已加载 {{ displayCommits.length }} 条匹配提交</span
      ><button
        class="secondary-button"
        :disabled="historyQuery.loading"
        @click="historyQuery.read(true)"
      >
        加载更多结果
      </button>
    </div>
    <DiffViewer v-if="store.selectedFile" />
    <footer class="history-footer">
      <span><span class="legend-dot teal"></span>颜色区分图谱轨道</span
      ><span
        >{{ displayCommits.length }} 条提交<span v-if="visibleStashes.length">
          · {{ visibleStashes.length }} 条贮藏</span
        ><span class="footer-separator">·</span>拓扑排序</span
      >
    </footer>
    <div
      ref="refsPopover"
      :id="`${graphId}-references`"
      popover="auto"
      role="dialog"
      class="refs-popover"
      aria-labelledby="refs-title"
      @toggle="referencesToggled"
      @keydown="referencesKeyboard"
    >
      <header>
        <div>
          <h2 id="refs-title">提交引用</h2>
          <code>{{ refsCommit?.hash.slice(0, 7) }}</code>
        </div>
        <button
          class="icon-button"
          aria-label="关闭引用列表"
          @click="closeReferences(true)"
        >
          <Icon
            name="X"
            :size="18"
          />
        </button>
      </header>
      <p v-overflow-title="menu.hoverTitle(refsCommit?.subject)">{{ refsCommit?.subject }}</p>
      <ul>
        <li
          v-for="reference in refsCommit ? references(refsCommit) : []"
          :key="reference.key"
        >
          <button
            class="reference-popup-action"
            v-overflow-title="
              menu.hoverTitle(reference.branch ? reference.key : reference.rawLabel)
            "
            :aria-label="referenceActionLabel(reference)"
            :aria-disabled="store.busy && reference.kind === 'local' ? true : undefined"
            @click="popupReferenceActivate(reference, $event)"
            @contextmenu.prevent.stop="popupReferenceMenu($event, reference)"
            @keydown="
              ($event.key === 'ContextMenu' || ($event.shiftKey && $event.key === 'F10')) &&
              popupReferenceMenu($event, reference)
            "
          >
            <Icon
              :name="
                reference.kind === 'local'
                  ? 'Laptop'
                  : reference.kind === 'remote'
                    ? 'Cloud'
                    : reference.kind === 'tag'
                      ? 'Tag'
                      : 'GitBranch'
              "
              :size="15"
            /><span>{{ reference.label }}</span
            ><strong v-if="reference.current">当前分支</strong></button
          ><code class="reference-full-name">{{
            reference.branch ? reference.key : reference.rawLabel
          }}</code>
        </li>
      </ul>
    </div>
  </main>
  <Teleport to="body">
    <div
      v-if="arrowHint && hintedArrow"
      :id="`${graphId}-hint`"
      role="tooltip"
      class="graph-arrow-tooltip"
      :style="{ left: `${arrowHint.x}px`, top: `${arrowHint.y}px` }"
    >
      <strong v-if="hintMetadata"
        >跳转到“{{
          hintMetadata.subject.length > 50
            ? hintMetadata.subject.slice(0, 47) + '...'
            : hintMetadata.subject
        }}”</strong
      >
      <strong v-else>跳转到 {{ hintedArrow.targetHash.slice(0, 7) }}</strong>
      <span v-if="hintMetadata">{{ hintMetadata.author }} · {{ hintDate }}</span>
      <small>{{ hintedArrow.targetHash.slice(0, 7) }}</small>
      <span
        v-if="hintUnavailable"
        class="graph-arrow-unavailable"
        >目标提交尚未加载或被筛选隐藏；请加载更早的提交或调整筛选。</span
      >
    </div>
  </Teleport>
</template>

<style scoped>
.stash-row {
  height: var(--history-row-height);
  width: 100%;
  padding: 0;
  gap: 0;
  align-items: center;
  text-align: left;
  font-size: var(--ui-font-size);
  color: var(--text);
  box-shadow: inset 0 -1px #ffffff03;
  position: relative;
  background: var(--theme-purple-fill, #bd93d704);
}
.stash-row:hover {
  background: var(--control-hover-bg);
}
.stash-row.selected {
  background: var(--view-selection-bg);
}
.stash-row-label {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  margin-left: 10px;
  gap: 5px;
  padding: 2px 6px;
  font-size: var(--ui-font-size);
  color: var(--theme-purple-text, #d4b4e6);
  border: 1px solid var(--theme-purple-border, #bd93d755);
  border-radius: 3px;
}
.stash-row-message {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  padding-left: 12px;
  color: var(--theme-purple-text, #d4b4e6);
}
.stash-row .author-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.stash-graph-node {
  pointer-events: all;
  cursor: default;
}
.stash-row-message {
  font: var(--code-font-size)/1.2 var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
</style>
