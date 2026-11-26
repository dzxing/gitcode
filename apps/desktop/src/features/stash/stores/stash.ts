import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from '../../repository/stores/repository'
import { coreBridge } from '../../../infrastructure/coreBridge'
import type { StashDetails, StashEntry } from '../../../shared/contracts'

type StashOperation = 'stash-apply' | 'stash-pop' | 'stash-drop'
export const useStashStore = defineStore('stash', () => {
  const repository = useRepositoryStore()
  const selected = computed(() => repository.selectedStash)
  const details = ref<StashDetails | null>(null),
    loading = ref(false),
    readError = ref(''),
    error = ref('')
  const preferences = ref<
    Record<string, { message: string; includeUntracked: boolean; creating: boolean }>
  >({})
  const prefs = () =>
    preferences.value[repository.repo.path] || {
      message: '',
      includeUntracked: true,
      creating: false,
    }
  function updatePrefs(changes: Partial<ReturnType<typeof prefs>>) {
    preferences.value[repository.repo.path] = { ...prefs(), ...changes }
  }
  const message = computed({
    get: () => prefs().message,
    set: (value) => updatePrefs({ message: value }),
  })
  const includeUntracked = computed({
    get: () => prefs().includeUntracked,
    set: (value) => updatePrefs({ includeUntracked: value }),
  })
  const creating = computed({
    get: () => prefs().creating,
    set: (value) => updatePrefs({ creating: value }),
  })
  const restoreIndex = ref(false)
  const pendingRestore = ref<{
    operation: 'stash-apply' | 'stash-pop'
    oid: string
    changes: string
    restoreIndex: boolean
  } | null>(null)
  const changeSignature = () => JSON.stringify([repository.repo.staged, repository.repo.unstaged])
  type Intent = ReturnType<typeof repository.captureOperation>
  let version = 0,
    detailFile = ''
  const selectionIntent = ref<Intent | null>(null),
    selectionSignature = ref('')
  const deleteTarget = ref<{ entry: StashEntry; intent: Intent; signature: string } | null>(null)
  const entries = computed(() => repository.repo.stashes || [])
  const supported = computed(() => typeof repository.repo.stashSignature === 'string')
  const baseBlocked = computed(() =>
    repository.busy
      ? '请等待当前 Git 操作完成'
      : repository.isNewTab
        ? '请先打开本地仓库'
        : !supported.value
          ? '请重启开发服务或桌面应用以加载贮藏功能'
          : !repository.repo.head
            ? '首次提交后才能使用贮藏'
            : repository.repo.gitflow?.operationError ||
              ([...repository.repo.staged, ...repository.repo.unstaged].some(
                (f) => f.status === 'U',
              )
                ? '请先解决工作区冲突'
                : ''),
  )
  const count = computed(
    () =>
      new Set(
        [
          ...repository.repo.staged,
          ...repository.repo.unstaged.filter((f) => includeUntracked.value || f.status !== '?'),
        ].map((f) => f.path),
      ).size,
  )
  const untrackedCount = computed(
    () => repository.repo.unstaged.filter((f) => f.status === '?').length,
  )
  const selectionBlocked = computed(() =>
    repository.selectedCommit || selected.value
      ? '请先选中“未提交的更改（WIP）”后再贮藏'
      : repository.gitflowPanel
        ? '请先返回工作区并选中未提交的更改'
        : repository.modal
          ? '请先关闭当前弹窗'
          : '',
  )
  const createEntryBlocked = computed(
    () =>
      baseBlocked.value || selectionBlocked.value || (!repository.changes ? '没有修改可贮藏' : ''),
  )
  const createBlocked = computed(
    () =>
      baseBlocked.value ||
      selectionBlocked.value ||
      (!count.value ? '没有符合范围的修改可贮藏' : ''),
  )
  const selectedMissing = computed(
    () =>
      !!selected.value &&
      !entries.value.some((e) => e.oid === selected.value!.oid && e.ref === selected.value!.ref),
  )
  function sameRepo(intent: Intent) {
    return repository.activeTabId === intent.tabId && repository.repo.path === intent.repo
  }
  function sameOperation(intent: Intent, signature: string) {
    return (
      sameRepo(intent) &&
      repository.repo.head === intent.expectedHead &&
      repository.repo.branch === intent.expectedBranch &&
      repository.repo.stashSignature === signature
    )
  }
  const stale = computed(
    () =>
      !!selected.value &&
      !!selectionIntent.value &&
      !sameOperation(selectionIntent.value, selectionSignature.value),
  )
  const restoreBlocked = computed(
    () =>
      baseBlocked.value ||
      (!selected.value
        ? '请选择贮藏记录'
        : selectedMissing.value
          ? '贮藏已变化，请重新选择'
          : stale.value
            ? '恢复目标或贮藏列表已变化，请重新核对'
            : repository.modal
              ? '请先关闭当前弹窗'
              : repository.repo.staged.length
                ? '恢复前请先提交或取消暂存当前已暂存的修改'
                : ''),
  )
  const file = computed(() => (selected.value ? repository.selectedFile?.path || '' : ''))
  function validRead(attempt: number, entry: StashEntry, intent: Intent) {
    return attempt === version && sameRepo(intent) && selected.value?.oid === entry.oid
  }
  function clearRead() {
    version++
    loading.value = false
    details.value = null
    readError.value = ''
    detailFile = ''
  }
  async function load(entry: StashEntry, savedFile = '', source: 'working' | 'staged' = 'working') {
    pendingRestore.value = null
    clearRead()
    error.value = ''
    selectionIntent.value = repository.captureOperation()
    selectionSignature.value = repository.repo.stashSignature || ''
    const attempt = version,
      intent = { ...selectionIntent.value }
    repository.diffLoading = false
    loading.value = true
    try {
      const result = await coreBridge.stashRead(intent.repo, entry.oid)
      if (!validRead(attempt, entry, intent)) return
      details.value = result
      loading.value = false
      if (savedFile && result.files.some((item) => item.path === savedFile))
        await preview(savedFile, source)
    } catch (failure) {
      if (validRead(attempt, entry, intent)) readError.value = (failure as Error).message
    } finally {
      if (validRead(attempt, entry, intent)) loading.value = false
    }
  }
  function openCreate() {
    if (createEntryBlocked.value) {
      repository.notify(createEntryBlocked.value, true)
      return
    }
    creating.value = true
    error.value = ''
  }
  function openList(entry?: StashEntry, operation?: StashOperation) {
    pendingRestore.value = null
    if (repository.busy || repository.modal || repository.isNewTab) return
    const item = entry || entries.value[0]
    if (!item) {
      repository.notify('暂无贮藏记录')
      return
    }
    if (!entries.value.some((value) => value.oid === item.oid && value.ref === item.ref)) {
      repository.notify('贮藏已变化，请刷新后重新选择', true)
      return
    }
    const keepRestorePreference =
      selected.value?.oid === item.oid && selected.value?.ref === item.ref
    const previousRestoreIndex = restoreIndex.value
    repository.clearSelection()
    repository.gitflowPanel = null
    creating.value = false
    repository.selectedStash = { ...item }
    restoreIndex.value = keepRestorePreference ? previousRestoreIndex : false
    void load(item)
    if (operation === 'stash-drop') requestDelete()
    else if (operation) void restore(operation)
  }
  async function preview(path: string, source: 'working' | 'staged' = 'working') {
    const entry = selected.value,
      item = details.value?.files.find((item) => item.path === path)
    if (!entry || !item) return
    const intent = repository.captureOperation(),
      attempt = ++version
    repository.selectedFile = item
    repository.fileStaged = false
    repository.fileDiffSource = null
    repository.stashDiffSource = source
    repository.diffText = ''
    repository.diffError = ''
    repository.diffTruncated = false
    repository.diffLoading = true
    readError.value = ''
    const current = () =>
      validRead(attempt, entry, intent) && repository.selectedFile?.path === path
    try {
      const result = await coreBridge.stashRead(intent.repo, entry.oid, path)
      if (!current()) return
      details.value = result
      detailFile = path
      const diff = source === 'staged' ? result.indexDiff : result.diff
      repository.diffText = diff?.diff || ''
      repository.diffTruncated = !!diff?.truncated
    } catch (failure) {
      if (current()) repository.diffError = (failure as Error).message
    } finally {
      if (current()) repository.diffLoading = false
    }
  }
  function setSource(source: 'working' | 'staged') {
    if (!file.value || repository.diffLoading) return
    if (detailFile !== file.value) {
      void preview(file.value, source)
      return
    }
    repository.stashDiffSource = source
    const diff = source === 'staged' ? details.value?.indexDiff : details.value?.diff
    repository.diffText = diff?.diff || ''
    repository.diffTruncated = !!diff?.truncated
  }
  async function create() {
    if (createBlocked.value) {
      error.value = createBlocked.value
      return false
    }
    const intent = repository.captureOperation(),
      signature = repository.repo.stashSignature || ''
    error.value = ''
    const ok = await repository.run(
      'stash-create',
      {
        message: message.value,
        includeUntracked: includeUntracked.value,
        stashSignature: signature,
      },
      intent,
    )
    if (!sameRepo(intent)) return ok
    if (ok) message.value = ''
    else {
      creating.value = true
      error.value =
        repository.lastActionResult?.warning ||
        repository.lastActionResult?.error ||
        '操作未完成，请核对工作区与贮藏列表。'
    }
    return ok
  }
  async function restore(operation: 'stash-apply' | 'stash-pop', confirmed = false) {
    if (restoreBlocked.value || !selectionIntent.value || !selected.value) {
      error.value = restoreBlocked.value
      return false
    }
    if (repository.repo.unstaged.length && !confirmed) {
      pendingRestore.value = {
        operation,
        oid: selected.value.oid,
        changes: changeSignature(),
        restoreIndex: restoreIndex.value,
      }
      error.value = ''
      return false
    }
    pendingRestore.value = null
    const entry = { ...selected.value },
      intent = { ...selectionIntent.value },
      signature = selectionSignature.value
    error.value = ''
    const ok = await repository.run(
      operation,
      {
        stashOid: entry.oid,
        stashRef: entry.ref,
        stashSignature: signature,
        restoreIndex: restoreIndex.value,
        confirmUnstaged: confirmed,
      },
      intent,
    )
    if (!sameRepo(intent)) return ok
    if (ok) {
      if (selected.value?.oid === entry.oid) repository.clearSelection()
    } else if (selected.value?.oid === entry.oid)
      error.value =
        repository.lastActionResult?.warning ||
        repository.lastActionResult?.error ||
        '操作未完成，请检查工作区；不要重复恢复。'
    return ok
  }
  async function confirmRestore() {
    const pending = pendingRestore.value
    if (
      !pending ||
      pending.oid !== selected.value?.oid ||
      pending.changes !== changeSignature() ||
      pending.restoreIndex !== restoreIndex.value
    ) {
      pendingRestore.value = null
      error.value = '工作区或恢复选项已变化，请重新选择恢复操作。'
      return false
    }
    return restore(pending.operation, true)
  }
  function cancelRestore() {
    pendingRestore.value = null
  }
  function requestDelete() {
    pendingRestore.value = null
    if (repository.busy || repository.modal || !selected.value || selectedMissing.value) return
    deleteTarget.value = {
      entry: { ...selected.value },
      intent: repository.captureOperation(),
      signature: repository.repo.stashSignature || '',
    }
    error.value = ''
    repository.modal = 'stash-delete'
  }
  async function confirmDelete() {
    const target = deleteTarget.value
    if (!target || repository.busy) return
    if (!sameOperation(target.intent, target.signature)) {
      error.value = '仓库或贮藏列表已变化，请取消后重新选择。'
      return
    }
    const ok = await repository.run(
      'stash-drop',
      {
        stashOid: target.entry.oid,
        stashRef: target.entry.ref,
        stashSignature: target.signature,
        confirmDelete: true,
      },
      target.intent,
    )
    if (!ok && sameRepo(target.intent))
      error.value =
        repository.lastActionResult?.warning ||
        repository.lastActionResult?.error ||
        '删除未完成，请核对贮藏列表。'
  }
  function closeDelete() {
    if (!repository.busy && repository.modal === 'stash-delete') repository.modal = null
  }
  function close() {
    if (!repository.busy) {
      pendingRestore.value = null
      creating.value = false
      repository.clearSelection()
    }
  }
  async function recheck() {
    const oid = selected.value?.oid,
      ref = selected.value?.ref
    if (!oid || repository.busy) return
    if (await repository.refresh()) {
      const item =
        entries.value.find((entry) => entry.oid === oid && entry.ref === ref) ||
        entries.value.find((entry) => entry.oid === oid)
      if (item && selected.value?.oid === oid)
        await load(item, file.value, repository.stashDiffSource)
    }
  }
  watch(
    [() => repository.activeTabId, () => repository.repo.path],
    ([tab, path], [previousTab, previousPath]) => {
      pendingRestore.value = null
      clearRead()
      error.value = ''
      deleteTarget.value = null
      selectionIntent.value = null
      if (repository.modal === 'stash-delete') repository.modal = null
      if (repository.isNewTab || !selected.value) return
      if (
        (tab === previousTab && path !== previousPath) ||
        !entries.value.some(
          (entry) => entry.oid === selected.value!.oid && entry.ref === selected.value!.ref,
        )
      ) {
        repository.clearSelection()
        return
      }
      void load(selected.value, file.value, repository.stashDiffSource)
    },
  )
  watch(
    () => selected.value?.oid,
    (oid) => {
      pendingRestore.value = null
      if (!oid) {
        clearRead()
        error.value = ''
        selectionIntent.value = null
      }
    },
    { flush: 'sync' },
  )
  watch([() => repository.selectedCommit, () => selected.value], ([commit, entry]) => {
    if (commit || entry) creating.value = false
  })
  watch(
    () => repository.modal,
    (value) => {
      if (value !== 'stash-delete') deleteTarget.value = null
    },
  )
  return {
    selected,
    details,
    file,
    loading,
    readError,
    error,
    message,
    includeUntracked,
    creating,
    restoreIndex,
    pendingRestore,
    confirmRestore,
    cancelRestore,
    entries,
    supported,
    baseBlocked,
    count,
    untrackedCount,
    createEntryBlocked,
    createBlocked,
    restoreBlocked,
    selectedMissing,
    stale,
    deleteTarget,
    openCreate,
    openList,
    preview,
    setSource,
    create,
    restore,
    requestDelete,
    confirmDelete,
    closeDelete,
    close,
    recheck,
  }
})
