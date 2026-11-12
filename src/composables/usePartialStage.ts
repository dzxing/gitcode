import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { desktop } from '../services/desktop'
import { noticePresentation } from '../noticePresentation'
import type { PartialStagePlan } from '../types'

export function usePartialStage(scroll: () => HTMLElement | null | undefined) {
  const store = useRepositoryStore()
  const enabled = ref(false),
    loading = ref(false),
    applying = ref(false),
    stale = ref(false),
    error = ref('')
  const plan = ref<PartialStagePlan | null>(null),
    selected = ref(new Set<number>())
  const available = computed(
    () =>
      !!store.selectedFile &&
      !store.selectedCommit &&
      !store.selectedStash &&
      !store.diffTruncated &&
      !store.diffError,
  )
  const locked = computed(
    () => store.busy || loading.value || applying.value || stale.value || !plan.value,
  )
  const hunkMap = computed(
    () => new Map(plan.value?.hunks.map((h, i) => [h.id, { ...h, number: i + 1 }]) || []),
  )
  const selectable = computed(
    () => new Set(plan.value?.hunks.filter((h) => !h.hunkOnly).flatMap((h) => h.lines) || []),
  )
  const action = computed(() => (plan.value?.source === 'staged' ? '取消暂存' : '暂存'))
  let version = 0,
    disposed = false
  let intent: ReturnType<typeof store.captureOperation> | null = null
  function reset() {
    version++
    enabled.value = false
    plan.value = null
    selected.value = new Set()
    loading.value = false
    stale.value = false
    error.value = ''
    intent = null
  }
  watch(
    [
      () => store.activeTabId,
      () => store.repo.path,
      () => store.selectedFile?.path,
      () => store.fileStaged,
      () => store.fileDiffSource,
      () => store.selectedCommit?.hash,
      () => store.selectedStash?.oid,
    ],
    () => {
      if (!applying.value) reset()
    },
  )
  watch(
    [() => store.diffText, () => store.repo.head, () => store.repo.branch, () => store.diffLoading],
    () => {
      if (enabled.value && plan.value && !loading.value && !applying.value) stale.value = true
    },
  )
  function sameFile(origin: ReturnType<typeof store.captureOperation>, file: string) {
    return (
      !disposed &&
      store.activeTabId === origin.tabId &&
      store.repo.path === origin.repo &&
      store.selectedFile?.path === file &&
      !store.selectedCommit &&
      !store.selectedStash
    )
  }
  async function load() {
    if (loading.value || store.busy || !available.value) return
    const file = store.selectedFile!.path,
      origin = store.captureOperation(),
      request = ++version
    loading.value = true
    plan.value = null
    selected.value = new Set()
    stale.value = false
    error.value = ''
    intent = null
    try {
      const value = await desktop.partialStageRead(origin.repo, {
        ...origin,
        file,
        source: store.fileStaged ? 'staged' : 'unstaged',
      })
      if (request !== version || !sameFile(origin, file)) return
      plan.value = value
      intent = origin
    } catch (reason) {
      if (request === version && sameFile(origin, file))
        error.value = noticePresentation(
          reason instanceof Error ? reason.message : '局部差异读取失败。',
          true,
        ).text
    } finally {
      if (request === version) loading.value = false
    }
  }
  async function enter() {
    if (!available.value || store.busy || store.diffLoading) return
    const file = store.selectedFile!
    if (store.fileDiffSource === 'working')
      await store.selectFile(file, !store.repo.unstaged.some((item) => item.path === file.path))
    if (!available.value) return
    enabled.value = true
    await load()
  }
  function toggle(id: number) {
    if (locked.value || !selectable.value.has(id)) return
    const next = new Set(selected.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected.value = next
  }
  function toggleHunk(id: number) {
    if (locked.value) return
    const hunk = hunkMap.value.get(id)
    if (!hunk) return
    const next = new Set(selected.value),
      remove = hunk.lines.every((line) => next.has(line))
    for (const line of hunk.lines) {
      if (remove) next.delete(line)
      else next.add(line)
    }
    selected.value = next
  }
  async function apply(ids = [...selected.value]) {
    const origin = intent,
      preview = plan.value
    if (locked.value || !origin || !preview || !ids.length) return
    const position = scroll()?.scrollTop || 0
    applying.value = true
    error.value = ''
    try {
      const ok = await store.run('partial-stage', { planId: preview.id, lines: ids }, origin)
      if (!sameFile(origin, preview.file)) {
        reset()
        return
      }
      selected.value = new Set()
      plan.value = null
      if (!ok) {
        stale.value = true
        error.value =
          store.lastActionResult?.error ||
          store.lastActionResult?.warning ||
          '操作未完整完成，请重新读取并核对暂存区。'
      } else if ((store.fileStaged ? 'staged' : 'unstaged') === preview.source) {
        applying.value = false
        await load()
      } else reset()
      await nextTick()
      const element = scroll()
      if (element) element.scrollTop = position
      const focusTarget =
        element?.querySelector<HTMLElement>('input[type="checkbox"]:not(:disabled)') ||
        element?.querySelector<HTMLElement>('.partial-hunk-actions button:not(:disabled)') ||
        element
          ?.closest('.diff-panel')
          ?.querySelector<HTMLElement>('.partial-toolbar button:not(:disabled)')
      focusTarget?.focus({ preventScroll: true })
    } finally {
      applying.value = false
    }
  }
  onScopeDispose(() => {
    disposed = true
    version++
  })
  return {
    enabled,
    loading,
    applying,
    stale,
    error,
    plan,
    selected,
    available,
    locked,
    hunkMap,
    selectable,
    action,
    enter,
    load,
    reset,
    toggle,
    toggleHunk,
    apply,
  }
}
