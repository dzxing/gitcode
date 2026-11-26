import { ref, watch, type Ref } from 'vue'
import { createRepositoryObservation } from '../../infrastructure/repositoryObservation'
import { coreBridge } from '../../infrastructure/coreBridge'
import { noticePresentation } from '../../shared/lib/noticePresentation'
import type {
  BackgroundReadResult,
  FileChange,
  Snapshot,
  Commit,
  StashEntry,
} from '../../shared/contracts'

type DiffSource = 'working' | 'staged' | 'unstaged' | null
interface ObservationContext {
  repo: Ref<Snapshot>
  connected: Ref<boolean>
  isNewTab: Readonly<Ref<boolean>>
  activeTabId: Ref<number>
  busy: Ref<boolean>
  fetching: Ref<boolean>
  starting: Readonly<Ref<boolean>>
  automaticFetching: Ref<boolean>
  modal: Readonly<Ref<string | null>>
  rebasePlanning: Ref<boolean>
  diffLoading: Ref<boolean>
  commitLoading: Ref<boolean>
  selectedFile: Ref<FileChange | null>
  selectedCommit: Ref<Commit | null>
  selectedStash: Ref<StashEntry | null>
  fileDiffSource: Ref<DiffSource>
  fileStaged: Ref<boolean>
  snapshotEpoch: (path: string) => number
  selectionVersion: () => number
  applyExternalSnapshot: (
    result: BackgroundReadResult,
    selection: number,
    source: DiffSource,
  ) => Promise<boolean>
}

// Observation owns scheduling, not snapshots. Repository mutations and stale-response
// validation keep using the repository Store's single epoch/selection authority.
export function createRepositoryObservationController(context: ObservationContext) {
  const {
    repo,
    connected,
    isNewTab,
    activeTabId,
    busy,
    fetching,
    starting,
    automaticFetching,
    modal,
    rebasePlanning,
    diffLoading,
    commitLoading,
    selectedFile,
    selectedCommit,
    selectedStash,
    fileDiffSource,
    fileStaged,
    snapshotEpoch,
    selectionVersion,
    applyExternalSnapshot,
  } = context
  const externalRefreshing = ref(false)
  const externalUpdate = ref(false)
  const externalRefreshError = ref('')
  const externalRefreshDeferred = ref(false)
  let observationWake: (() => void) | null = null
  function requestExternalRefresh() {
    observationWake?.()
  }
  function startRepositoryObservation() {
    let captured: {
      epoch: number
      selection: number
      path: string
      source: 'working' | 'staged' | 'unstaged' | null
    } | null = null
    const observer = createRepositoryObservation({
      context: () =>
        connected.value && !isNewTab.value && repo.value.path
          ? `${activeTabId.value}\0${repo.value.path}`
          : null,
      allowed: () =>
        !busy.value &&
        !fetching.value &&
        !starting.value &&
        !automaticFetching.value &&
        !modal.value &&
        !rebasePlanning.value &&
        !diffLoading.value &&
        !commitLoading.value &&
        document.visibilityState !== 'hidden',
      status: (key) => coreBridge.repositoryChanges(key.slice(key.indexOf('\0') + 1)),
      read: (key) => {
        const path = key.slice(key.indexOf('\0') + 1)
        const file =
          selectedFile.value && !selectedCommit.value && !selectedStash.value
            ? {
                path: selectedFile.value.path,
                source:
                  fileDiffSource.value ||
                  (fileStaged.value ? ('staged' as const) : ('unstaged' as const)),
              }
            : undefined
        captured = {
          epoch: snapshotEpoch(path),
          selection: selectionVersion(),
          path,
          source: file?.source || null,
        }
        return coreBridge.backgroundSnapshot(path, file ? { file } : null)
      },
      apply: async (_key, result) => {
        if (
          !captured ||
          captured.path !== repo.value.path ||
          captured.epoch !== snapshotEpoch(captured.path)
        )
          return false
        return applyExternalSnapshot(result, captured.selection, captured.source)
      },
      reading: (value) => {
        externalRefreshing.value = value
      },
      error: (value) => {
        externalRefreshError.value = value
          ? noticePresentation(
              value instanceof Error
                ? value.message
                : typeof value === 'string'
                  ? value
                  : '自动核对未完成，请稍后重试。',
              true,
            ).text
          : ''
      },
      deferred: (value) => {
        externalRefreshDeferred.value = value
      },
    })
    const wake = () => {
      observer.request()
      void observer.tick()
    }
    observationWake = wake
    const stop = watch(
      [
        () => connected.value,
        () => activeTabId.value,
        () => repo.value.path,
        () => busy.value,
        () => fetching.value,
        () => starting.value,
        () => automaticFetching.value,
        () => modal.value,
        () => rebasePlanning.value,
        () => diffLoading.value,
        () => commitLoading.value,
      ],
      wake,
      { immediate: true, flush: 'post' },
    )
    const timer = setInterval(() => {
      void observer.tick()
    }, 1000)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      observer.dispose()
      stop()
      clearInterval(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
      if (observationWake === wake) observationWake = null
    }
  }
  return {
    externalRefreshing,
    externalUpdate,
    externalRefreshError,
    externalRefreshDeferred,
    requestExternalRefresh,
    startRepositoryObservation,
  }
}
