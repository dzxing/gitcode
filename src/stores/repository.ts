import {
  readHistoryFilter,
  writeHistoryFilter,
  restoreHistoryFilter,
  historyFilterPreference,
  historyFilterKey,
  type HistoryFilterPreference,
} from '../services/historyFilter'
import { retainHistory, isCommitShaQuery, decorateHistory } from '../historyPaging'
import { useGraphViewStore } from './graphView'
import { visibleHistory } from '../graphVisibility'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { branchReference } from '../references'
import { emptyRepository } from '../repositoryState'
import { readCommitDraft, writeCommitDraft } from '../services/commitDraft'
import { noticePresentation } from '../noticePresentation'
import { readWorkspaceSession, writeWorkspaceSession } from '../services/workspaceSession'
import type { StartupPhase } from '../services/application'
import { createRepositoryObservation } from '../services/repositoryObservation'
import {
  canConnectLocalCore,
  desktop,
  isDesktop,
  onLocalCoreDisconnected,
} from '../services/desktop'
import type {
  ActionResult,
  ActivitySettings,
  FetchStatus,
  CheckoutProtection,
  PublishTarget,
  Branch,
  Commit,
  FileChange,
  GitAction,
  Notice,
  RuntimeInfo,
  SelectedCommitPlan,
  Snapshot,
  StashEntry,
  SyncPlan,
  BackgroundReadResult,
  WorkspaceState,
  WorkspaceTab,
  RepositoryTrustInfo,
  HistoryPage,
} from '../types'

export const useRepositoryStore = defineStore('repository', () => {
  const repo = ref<Snapshot>(emptyRepository())
  const graphView = useGraphViewStore()
  const connected = ref(false)
  const startupPhase = ref<'idle' | 'core' | 'restore' | 'ready' | 'error'>('idle')
  const startupError = ref('')
  const historyLoading = ref(false)
  const historyError = ref('')
  let historyRequestVersion = 0
  const repositoryOpenError = ref('')
  const repositoryOpenPath = ref('')
  const choosingRepository = ref(false)
  const repositoryCreateError = ref('')
  const repositoryCreateDetails = ref('')
  const repositoryCreateCancelled = ref(false)
  const trustRequest = ref<RepositoryTrustInfo | null>(null)
  const trustError = ref('')
  const trustApproving = ref(false)
  let resolveTrust: ((approved: boolean) => void) | null = null
  function cancelTrust() {
    if (trustApproving.value) return
    trustRequest.value = null
    resolveTrust?.(false)
    resolveTrust = null
  }
  async function approveTrust() {
    const request = trustRequest.value
    if (!request || trustApproving.value) return
    trustApproving.value = true
    trustError.value = ''
    try {
      await desktop.approveRepositoryTrust(request.path, request.token)
      trustRequest.value = null
      resolveTrust?.(true)
      resolveTrust = null
    } catch (error) {
      trustError.value = noticePresentation((error as Error).message, true).text
      // A consumed/expired challenge is never replayed. Refresh the metadata,
      // then require a fresh click before granting consent.
      try {
        trustRequest.value = await desktop.repositoryTrust(request.path)
      } catch {
        /* Keep cancellation available. */
      }
    } finally {
      trustApproving.value = false
    }
  }
  async function confirmRepositoryTrust(path: string) {
    const info = await desktop.repositoryTrust(path)
    if (info.trusted) return true
    trustError.value = ''
    trustRequest.value = info
    return new Promise<boolean>((resolve) => {
      resolveTrust = resolve
    })
  }
  const starting = computed(() => startupPhase.value === 'core' || startupPhase.value === 'restore')
  let sessionReady = false
  let restoringSession = false
  let sessionWriteFailed = false
  function startupTrace(phase: StartupPhase) {
    void window.gitkApp
      ?.startupPhase?.(phase)
      .catch((error) => console.warn('[GitCode] 启动阶段记录失败', error))
  }
  const connecting = ref(false),
    connectionError = ref('')
  onScopeDispose(
    onLocalCoreDisconnected(() => {
      connected.value = false
      connectionError.value = '本机连接已中断，请重新连接并核对仓库状态。'
    }),
  )
  const activityPanelOpen = ref(false)
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
      status: (key) => desktop.repositoryChanges(key.slice(key.indexOf('\0') + 1)),
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
          epoch: snapshotEpochs.get(path) || 0,
          selection: selectionVersion,
          path,
          source: file?.source || null,
        }
        return desktop.backgroundSnapshot(path, file ? { file } : null)
      },
      apply: async (_key, result) => {
        if (
          !captured ||
          captured.path !== repo.value.path ||
          captured.epoch !== (snapshotEpochs.get(captured.path) || 0)
        )
          return false
        await applyExternalSnapshot(result, captured.selection, captured.source)
        return true
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
  const activityLogId = ref('')
  const activityLogFocus = ref<'fetch-failure' | null>(null)
  const activitySettings = ref<ActivitySettings | null>(null)
  const automaticFetching = ref(false)
  const fetchStatuses = ref<Record<string, FetchStatus>>({})
  const currentFetchStatus = computed(() => fetchStatuses.value[repo.value.path])
  function openActivityLog(id = '') {
    activityLogFocus.value = null
    activityLogId.value = id
    activityPanelOpen.value = true
  }
  function openFetchLog() {
    openActivityLog()
    activityLogFocus.value = currentFetchStatus.value?.error ? 'fetch-failure' : null
  }
  async function saveActivitySettings(value: ActivitySettings) {
    const saved = await desktop.activitySettings(value)
    if (!saved) throw new Error('请重启本地 Git 服务以加载自动获取设置。')
    activitySettings.value = saved
  }
  function startAutomaticFetch() {
    let disposed = false
    let inFlight = false
    const tick = async () => {
      if (
        disposed ||
        inFlight ||
        !connected.value ||
        isNewTab.value ||
        isWorking.value ||
        externalRefreshing.value
      )
        return
      inFlight = true
      const intent = captureOperation()
      const epoch = snapshotEpochs.get(intent.repo) || 0
      try {
        activitySettings.value = await desktop.activitySettings()
        if (disposed || !sameContext(intent) || isWorking.value || externalRefreshing.value) return
        const status = await desktop.fetchStatus(intent.repo)
        if (status) fetchStatuses.value[intent.repo] = status
        if (!activitySettings.value?.autoFetchInterval || navigator.onLine === false) return
        automaticFetching.value = true
        const result = await desktop.automaticFetch(intent.repo)
        if (disposed) return
        if (result.status) fetchStatuses.value[intent.repo] = result.status
        if (result.snapshot && epoch === (snapshotEpochs.get(intent.repo) || 0)) {
          if (sameContext(intent) && !busy.value) await applySnapshot(result.snapshot)
          else {
            const tab = tabs.value.find(
              (item) => item.id === intent.tabId && item.path === intent.repo,
            )
            if (
              tab?.state &&
              tab.state.repo.head === result.snapshot.head &&
              tab.state.repo.branch === result.snapshot.branch
            )
              tab.state.repo = result.snapshot
          }
        }
      } catch {
        // A disconnected core must be reconnected explicitly; never replay an operation.
      } finally {
        automaticFetching.value = false
        inFlight = false
      }
    }
    const stop = watch(
      () => [connected.value, activeTabId.value, busy.value, starting.value],
      () => {
        void tick()
      },
      { flush: 'post', immediate: true },
    )
    const timer = setInterval(() => {
      void tick()
    }, 15000)
    const wake = () => {
      void tick()
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      disposed = true
      stop()
      clearInterval(timer)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }
  const busy = ref(false)
  const fetching = ref(false),
    fetchCancelling = ref(false),
    fetchOrigin = ref('')
  const isWorking = computed(() => busy.value || fetching.value || starting.value)
  let fetchTask: Promise<boolean> | null = null
  const snapshotEpochs = new Map<string, number>()
  function invalidateSnapshot(path = repo.value.path) {
    snapshotEpochs.set(path, (snapshotEpochs.get(path) || 0) + 1)
  }
  const cancelling = ref(false)
  let cancellationTask: Promise<void> | null = null
  let cancellationEpoch = 0
  const checkoutProtection = ref<
    | (CheckoutProtection & {
        intent: { repo: string; tabId: number; expectedHead: string; expectedBranch: string }
      })
    | null
  >(null)
  const lastActionResult = ref<ActionResult | null>(null)
  const remoteCheckout = ref<
    | (NonNullable<ActionResult['remoteCheckoutProtection']> & {
        intent: { repo: string; tabId: number; expectedHead: string; expectedBranch: string }
      })
    | null
  >(null)
  const upstreamRequest = ref<{
    branch: Branch
    intent: { repo: string; tabId: number; expectedHead: string; expectedBranch: string }
    method: 'ff-only' | 'merge'
  } | null>(null)
  const runtime = ref<RuntimeInfo | null>(null)
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth || 1440 : 1440)
  const authorPreference = ref<boolean | null>(null),
    timePreference = ref<boolean | null>(null)
  const showAuthor = computed({
    get: () => authorPreference.value ?? viewportWidth.value >= 1600,
    set: (value: boolean) => {
      authorPreference.value = value
    },
  })
  const showTime = computed({
    get: () => timePreference.value ?? viewportWidth.value >= 1600,
    set: (value: boolean) => {
      timePreference.value = value
    },
  })
  const showSha = ref(false)
  function updateViewport(width: number) {
    viewportWidth.value = width
  }
  function resetColumns() {
    authorPreference.value = null
    timePreference.value = null
    showSha.value = false
  }
  const query = ref('')
  const historyFilter = ref<{ fullRef: string; source: string } | null>(null)
  const branchFilter = computed(() => historyFilter.value?.fullRef || '')
  const sidebarBranchSelection = computed(() => historyFilter.value?.source || '')
  const branchFilterLabel = computed(
    () =>
      repo.value.branches.find((branch) => branchReference(branch) === branchFilter.value)?.name ||
      branchFilter.value,
  )
  const pendingFilterPreferences = new Map<string, HistoryFilterPreference | null>()
  const filterWriteVersions = new Map<string, number>()
  const filterWarnings = ref<Record<string, boolean>>({})
  const historyPreferenceWarning = computed(() =>
    filterWarnings.value[historyFilterKey(repo.value.path)]
      ? '分支筛选未能保存到本机，仅在本次会话保留。重新选择筛选可重试。'
      : '',
  )
  function rememberBranchFilter() {
    const path = repo.value.path
    if (!path) return
    const key = historyFilterKey(path),
      preference = historyFilterPreference(historyFilter.value)
    const version = (filterWriteVersions.get(key) || 0) + 1
    filterWriteVersions.set(key, version)
    pendingFilterPreferences.set(key, preference)
    const failed = () => {
      if (filterWriteVersions.get(key) === version) filterWarnings.value[key] = true
    }
    try {
      void writeHistoryFilter(path, preference).then(() => {
        if (filterWriteVersions.get(key) !== version) return
        pendingFilterPreferences.delete(key)
        filterWarnings.value[key] = false
      }, failed)
    } catch {
      failed()
    }
  }
  function clearBranchFilter(remember = true) {
    historyFilter.value = null
    if (remember) {
      historyRequestVersion++
      historyLoading.value = false
      rememberBranchFilter()
      void ensureFilteredHistory()
    }
  }
  function restoreRememberedBranchFilter() {
    const key = historyFilterKey(repo.value.path)
    const preference = pendingFilterPreferences.has(key)
      ? pendingFilterPreferences.get(key)!
      : readHistoryFilter(repo.value.path)
    const restored = restoreHistoryFilter(repo.value, preference)
    historyFilter.value = restored.filter
    if (restored.missing) {
      rememberBranchFilter()
      notify('原筛选引用已不存在，已恢复显示全部历史。')
    }
  }
  function snapshotWithHistory(next: Snapshot, preserve = true) {
    const filterExists =
      !historyFilter.value ||
      next.branches.some((b) => branchReference(b) === historyFilter.value!.fullRef)
    return preserve && filterExists ? retainHistory(repo.value, next) : next
  }
  async function ensureFilteredHistory() {
    if (busy.value || historyLoading.value || isNewTab.value || !repo.value.history) return
    if (!historyFilter.value) {
      if (repo.value.history.focusSource === 'branch') await loadHistory('reset', '', false, true)
      return
    }
    const branch = repo.value.branches.find(
      (b) => branchReference(b) === historyFilter.value!.fullRef,
    )
    if (!branch) return
    const target = branch.commitHash || branch.hash
    if (
      (repo.value.history.focus && repo.value.history.focus !== target) ||
      !repo.value.commits.some((c) => c.hash === target)
    )
      await loadHistory('locate', target, true)
  }
  function setBranchFilter(branch: Branch, source = '', toggle = false) {
    historyRequestVersion++
    historyLoading.value = false
    const fullRef = branchReference(branch)
    historyFilter.value =
      toggle && historyFilter.value?.fullRef === fullRef && historyFilter.value.source === source
        ? null
        : { fullRef, source }
    rememberBranchFilter()
    if (
      historyFilter.value &&
      repo.value.history &&
      (repo.value.history.focus ||
        !repo.value.commits.some((c) => c.hash === (branch.commitHash || branch.hash)))
    )
      void loadHistory('locate', branch.commitHash || branch.hash, true)
    else if (!historyFilter.value) void ensureFilteredHistory()
  }
  function validateBranchFilter() {
    if (
      historyFilter.value &&
      !repo.value.branches.some(
        (branch) => branchReference(branch) === historyFilter.value!.fullRef,
      )
    ) {
      clearBranchFilter()
      notify('原筛选引用已不存在，已恢复显示全部历史。')
    }
  }
  const sidebarQuery = ref('')
  const gitflowPanel = ref<'overview' | 'settings' | 'start' | 'finish' | null>(null)
  const selectedCommit = ref<Commit | null>(null)
  const selectedStash = ref<StashEntry | null>(null)
  const stashDiffSource = ref<'working' | 'staged'>('working')
  const selectedFile = ref<FileChange | null>(null)
  const fileStaged = ref(false)
  const fileDiffSource = ref<'working' | 'staged' | null>(null)
  const diffText = ref('')
  const diffTruncated = ref(false)
  const diffLoading = ref(false)
  const diffError = ref('')
  const commitLoading = ref(false)
  const commitError = ref('')
  const commitFiles = ref<FileChange[]>([])
  const commitBody = ref('')
  const modal = ref<
    | 'open'
    | 'clone'
    | 'create'
    | 'close'
    | 'branch'
    | 'push'
    | 'pull'
    | 'help'
    | 'navigation'
    | 'stash-delete'
    | 'gitflow-finish'
    | 'checkout-protected'
    | 'checkout-remote'
    | 'upstream'
    | 'recovery'
    | 'commit-operation'
    | null
  >(null)
  const syncPreview = ref<SyncPlan | null>(null),
    syncError = ref('')
  const pullMethod = ref<'ff-only' | 'merge'>('merge')
  const syncTarget = ref<Branch | null>(null)
  const inlineBranchActive = ref(false)
  const operationOrigin = ref('')
  const checkoutTarget = ref('')
  const checkingOut = computed(() => busy.value && !!checkoutTarget.value)
  const activeOperation = ref('')
  const backgroundFetch = computed(() => fetching.value)
  const blocksTabs = computed(() => busy.value || starting.value || startupPhase.value === 'error')
  const indexWorking = computed(
    () =>
      busy.value &&
      ['stage', 'unstage', 'partial-stage', 'commit', 'commit-selected', 'merge-resolve'].includes(
        activeOperation.value,
      ),
  )
  const rebasePlanning = ref(false)
  const operationLabel = computed(
    () =>
      ({
        clone: '克隆仓库',
        init: '初始化仓库',
        open: '打开仓库',
        'stash-checkout': '贮藏并切换',
        'checkout-revision': '检出修订',
        'commit-operation': '执行提交操作',
        'commit-sequence': '处理优选或还原',
        'gitflow-finish': '完成 GitFlow 分支',
        'gitflow-finish-continue': '继续完成 GitFlow',
        'gitflow-finish-stop': '停止 GitFlow 后续步骤',
        'merge-resolve': '保存冲突解决结果',
        'merge-finish': '完成合并',
        'merge-abort': '中止合并',
        'rebase-start': '变基',
        'rebase-continue': '继续变基',
        'rebase-skip': '跳过当前提交',
        'rebase-abort': '中止变基',
        'stash-create': '贮藏修改',
        'stash-apply': '恢复贮藏',
        'stash-pop': '恢复并移除贮藏',
        'stash-drop': '删除贮藏',
        'gitflow-save': '保存 GitFlow 配置',
        'gitflow-init': '初始化 GitFlow',
        'gitflow-start': '开始 GitFlow 分支',
        'gitflow-preview': '读取初始化计划',
        'set-fetch-scope': '保存分支获取范围',
        unshallow: '补全仓库历史',
        fetch: '获取远程分支',
        pull: '拉取远程分支',
        push: '推送指定分支',
        'pull-and-push': '拉取并推送',
        'prepare-sync': '读取同步目标',
        refresh: '刷新本地状态',
        'partial-stage': '更新所选修改的暂存状态',
        stage: '暂存文件',
        unstage: '取消暂存',
        commit: '创建提交',
        checkout: '检出分支',
        'checkout-remote': '检出远程分支',
        'checkout-remote-confirm': '检出远程分支',
        branch: '创建分支',
        'create-branch': '创建分支',
        'track-branch': '创建跟踪分支',
        'rename-branch': '重命名分支',
        'delete-branch': '删除分支',
      })[activeOperation.value] || '处理 Git 操作',
  )
  let syncIntent: ReturnType<typeof captureOperation> | null = null
  let syncAttempt = 0
  const selectedCommitIntents = new Map<
    string,
    { intent: ReturnType<typeof captureOperation>; plan: SelectedCommitPlan }
  >()
  const notices = ref<Notice[]>([])
  const recent = ref<string[]>([])
  const commitMessage = ref('')
  const commitDescription = ref('')
  let draftPath = ''
  let draftSaveFailed = false
  function reportDraftSaveFailure() {
    if (!draftSaveFailed)
      notify('提交说明草稿未能保存到本机，请保留当前窗口并复制说明后再退出。', true)
    draftSaveFailed = true
  }
  watch(
    [commitMessage, commitDescription],
    ([message, description]) => {
      if (!draftPath || draftPath !== repo.value.path) return
      try {
        const flushed = writeCommitDraft(draftPath, { message, description })
        void Promise.resolve(flushed).then(() => {
          draftSaveFailed = false
        }, reportDraftSaveFailure)
      } catch {
        reportDraftSaveFailure()
      }
    },
    { flush: 'sync' },
  )
  const tabs = ref<WorkspaceTab[]>([{ id: 1, kind: 'new', name: '新标签页' }])
  const activeTabId = ref(1)
  const activeRepositoryTab = computed(() =>
    tabs.value.find((tab) => tab.id === activeTabId.value && tab.kind === 'repository'),
  )
  const unloadedRepository = computed(() => !!activeRepositoryTab.value && !repo.value.path)
  watch(
    () => [
      activeTabId.value,
      ...tabs.value.flatMap((tab) => [tab.id, tab.kind, tab.path, tab.name]),
    ],
    () => {
      if (!sessionReady || restoringSession) return
      try {
        void writeWorkspaceSession(tabs.value, activeTabId.value)?.catch(reportSessionWriteFailure)
        sessionWriteFailed = false
      } catch {
        reportSessionWriteFailure()
      }
    },
    { flush: 'post' },
  )
  function reportSessionWriteFailure() {
    if (!sessionWriteFailed) notify('仓库标签未能保存到本机，下次启动可能无法恢复。', true)
    sessionWriteFailed = true
  }
  const pendingCloseIds = ref<number[]>([])
  const pendingCloseId = computed(() => pendingCloseIds.value[0] ?? null)
  const pendingCloseTabs = computed(() =>
    tabs.value.filter((tab) => pendingCloseIds.value.includes(tab.id)),
  )
  watch(
    modal,
    (value) => {
      if (value !== 'close') pendingCloseIds.value = []
    },
    { flush: 'sync' },
  )
  const isNewTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value)?.kind === 'new',
  )
  const commitContextBlocked = computed(() =>
    isNewTab.value
      ? '请先打开仓库工作区'
      : rebasePlanning.value
        ? '请先完成或取消提交编排'
        : repo.value.gitflow?.finish
          ? '请先完成或停止当前 GitFlow 流程'
          : repo.value.merge
            ? '请通过冲突处理界面解决并完成当前操作'
            : selectedCommit.value || selectedStash.value
              ? '请返回工作区后提交'
              : gitflowPanel.value
                ? '请先收起 GitFlow 面板后提交'
                : modal.value
                  ? '请先关闭当前弹窗后提交'
                  : '',
  )
  const inspectorCovered = computed(
    () =>
      !!gitflowPanel.value && (gitflowPanel.value === 'settings' || viewportWidth.value <= 1300),
  )
  let nextTabId = 1
  let selectionVersion = 0
  let fileTrigger: HTMLElement | null = null
  let noticeId = 0
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem('gitcode.recent') ?? localStorage.getItem('gitk.recent') ?? '[]',
    )
    if (Array.isArray(saved)) {
      recent.value = saved.filter((path): path is string => typeof path === 'string').slice(0, 6)
      if (localStorage.getItem('gitcode.recent') === null)
        localStorage.setItem('gitcode.recent', JSON.stringify(recent.value))
    }
  } catch {
    /* optional persistence */
  }

  const mergeDraftTabs = ref(new Set<number>())
  const draftTabs = computed(() =>
    tabs.value
      .filter(
        (tab) =>
          tab.kind === 'repository' &&
          ((rebasePlanning.value && tab.id === activeTabId.value) ||
            mergeDraftTabs.value.has(tab.id) ||
            (tab.id === activeTabId.value
              ? !!(commitMessage.value.trim() || commitDescription.value.trim())
              : !!(tab.state?.commitMessage.trim() || tab.state?.commitDescription.trim()))),
      )
      .map((tab) => ({ id: tab.id, name: tab.name })),
  )

  function saveTab() {
    const tab = tabs.value.find((tab) => tab.id === activeTabId.value)
    if (!tab || tab.kind === 'new' || !repo.value.path) return
    // A detached copy prevents inactive tabs from sharing reactive selections.
    tab.state = JSON.parse(
      JSON.stringify({
        repo: repo.value,
        query: query.value,
        historyFilter: historyFilter.value,
        sidebarQuery: sidebarQuery.value,
        selectedCommit: selectedCommit.value,
        selectedStash: selectedStash.value,
        stashDiffSource: stashDiffSource.value,
        selectedFile: diffLoading.value ? null : selectedFile.value,
        fileStaged: fileStaged.value,
        fileDiffSource: fileDiffSource.value,
        diffText: diffText.value,
        diffTruncated: diffTruncated.value,
        diffError: diffError.value,
        commitFiles: commitFiles.value,
        commitBody: commitBody.value,
        commitError: commitError.value,
        commitMessage: commitMessage.value,
        commitDescription: commitDescription.value,
      }),
    ) as WorkspaceState
  }

  function activateTab(id: number) {
    if (rebasePlanning.value) return
    if (
      blocksTabs.value ||
      modal.value ||
      id === activeTabId.value ||
      !tabs.value.some((tab) => tab.id === id)
    )
      return
    saveTab()
    restoreTab(id)
    loadSelectedTab()
  }

  function loadSelectedTab() {
    const tab = activeRepositoryTab.value
    if (tab?.path && !repo.value.path) void open(tab.path)
    else void ensureFilteredHistory()
  }

  function restoreTab(id: number) {
    historyRequestVersion++
    historyLoading.value = false
    historyError.value = ''
    repositoryOpenError.value = ''
    draftPath = ''
    selectionVersion++
    fileTrigger = null
    diffLoading.value = false
    commitLoading.value = false
    activeTabId.value = id
    const state = tabs.value.find((tab) => tab.id === id)?.state
    if (!state) {
      repo.value = emptyRepository()
      query.value = ''
      sidebarQuery.value = ''
      gitflowPanel.value = null
      commitMessage.value = ''
      commitDescription.value = ''
      checkoutProtection.value = null
      clearSelection()
      clearBranchFilter(false)
      return
    }
    const saved = JSON.parse(JSON.stringify(state)) as WorkspaceState
    repo.value = saved.repo
    query.value = saved.query
    historyFilter.value = saved.historyFilter || null
    validateBranchFilter()
    sidebarQuery.value = saved.sidebarQuery || ''
    selectedCommit.value = saved.selectedCommit
    selectedStash.value = saved.selectedStash || null
    stashDiffSource.value = saved.stashDiffSource || 'working'
    selectedFile.value = saved.selectedFile
    fileStaged.value = saved.fileStaged
    fileDiffSource.value = saved.fileDiffSource || null
    diffText.value = saved.diffText
    diffTruncated.value = saved.diffTruncated
    diffError.value = saved.diffError || ''
    commitFiles.value = saved.commitFiles
    commitBody.value = saved.commitBody
    commitError.value = saved.commitError || ''
    commitMessage.value = saved.commitMessage
    commitDescription.value = saved.commitDescription
    draftPath = saved.repo.path
    // A selection whose detail fetch was interrupted is reloaded on return.
    if (selectedCommit.value && !commitBody.value && !commitError.value)
      void selectCommit(selectedCommit.value)
  }

  function newTab() {
    if (rebasePlanning.value) return
    if (blocksTabs.value || modal.value) return
    saveTab()
    const id = ++nextTabId
    tabs.value.push({ id, kind: 'new', name: '新标签页' })
    restoreTab(id)
  }

  function closeTab(id: number, confirmed = false) {
    closeTabs([id], confirmed)
  }

  function closeTabs(ids: number[], confirmed = false) {
    if (rebasePlanning.value) return
    if (blocksTabs.value || (modal.value && modal.value !== 'close')) return
    const selected = tabs.value.filter((tab) => ids.includes(tab.id))
    if (!selected.length) return
    const closingIds = new Set(selected.map((tab) => tab.id))
    if (closingIds.has(activeTabId.value)) saveTab()
    if (
      !confirmed &&
      selected.some(
        (tab) =>
          mergeDraftTabs.value.has(tab.id) ||
          tab.state?.commitMessage.trim() ||
          tab.state?.commitDescription.trim(),
      )
    ) {
      pendingCloseIds.value = selected.map((tab) => tab.id)
      modal.value = 'close'
      return
    }
    if (confirmed) {
      try {
        for (const tab of selected)
          if (tab.path)
            void writeCommitDraft(tab.path, { message: '', description: '' }).catch(() =>
              notify('已关闭标签，但说明草稿的磁盘清理未能确认，请重新打开仓库核对。', true),
            )
      } catch {
        notify('无法清除已保存的说明草稿，请稍后重试关闭。', true)
        return
      }
    }
    const oldTabs = [...tabs.value]
    const index = oldTabs.findIndex((tab) => tab.id === activeTabId.value)
    const next =
      oldTabs.slice(index + 1).find((tab) => !closingIds.has(tab.id)) ||
      oldTabs
        .slice(0, index)
        .reverse()
        .find((tab) => !closingIds.has(tab.id))
    for (const id of closingIds) mergeDraftTabs.value.delete(id)
    tabs.value = tabs.value.filter((tab) => !closingIds.has(tab.id))
    modal.value = null
    pendingCloseIds.value = []
    if (!tabs.value.length) {
      const nextId = ++nextTabId
      tabs.value.push({ id: nextId, kind: 'new', name: '新标签页' })
      restoreTab(nextId)
    } else if (closingIds.has(activeTabId.value)) {
      restoreTab(next!.id)
      loadSelectedTab()
    }
  }

  async function acceptRepository(next: Snapshot) {
    sessionReady = true
    invalidateSnapshot(next.path)
    saveTab()
    const existing = tabs.value.find((tab) => tab.kind === 'repository' && tab.path === next.path)
    if (existing) {
      const wasUnloaded = !existing.state
      modal.value = null
      restoreTab(existing.id)
      await applySnapshot(next)
      existing.name = next.name
      if (wasUnloaded) {
        restoreRememberedBranchFilter()
        const draft = readCommitDraft(next.path)
        commitMessage.value = draft.message
        commitDescription.value = draft.description
        draftPath = next.path
      }
      return
    }
    let tab = tabs.value.find((tab) => tab.id === activeTabId.value && tab.kind === 'new')
    if (!tab) {
      tab = { id: ++nextTabId, kind: 'repository', name: next.name }
      tabs.value.push(tab)
    }
    Object.assign(tab, { kind: 'repository', name: next.name, path: next.path })
    draftPath = ''
    activeTabId.value = tab.id
    repo.value = next
    query.value = ''
    clearBranchFilter(false)
    restoreRememberedBranchFilter()
    sidebarQuery.value = ''
    const draft = readCommitDraft(next.path)
    commitMessage.value = draft.message
    commitDescription.value = draft.description
    draftPath = next.path
    clearSelection()
  }

  async function discardCommitDrafts() {
    try {
      const writes = []
      for (const tab of tabs.value) {
        if (tab.kind !== 'repository' || !tab.path) continue
        writes.push(writeCommitDraft(tab.path, { message: '', description: '' }))
      }
      await Promise.all(writes)
    } catch {
      throw new Error('无法清除已保存的说明草稿，请保留应用并稍后重试。')
    }
    const previousPath = draftPath
    draftPath = ''
    commitMessage.value = ''
    commitDescription.value = ''
    draftPath = previousPath
    for (const tab of tabs.value) {
      if (tab.state) {
        tab.state.commitMessage = ''
        tab.state.commitDescription = ''
      }
    }
  }

  function remember(path: string) {
    recent.value = [path, ...recent.value.filter((p) => p !== path)].slice(0, 6)
    try {
      localStorage.setItem('gitcode.recent', JSON.stringify(recent.value))
    } catch {
      /* optional */
    }
  }

  function forgetRecent(path: string) {
    recent.value = recent.value.filter((item) => item !== path)
    try {
      localStorage.setItem('gitcode.recent', JSON.stringify(recent.value))
    } catch {
      /* optional */
    }
  }

  async function ensureSession() {
    if (connected.value) return
    connecting.value = true
    connectionError.value = ''
    try {
      runtime.value = await desktop.runtime()
      connected.value = true
    } catch (error) {
      connected.value = false
      connectionError.value = (error as Error).message
      throw error
    } finally {
      connecting.value = false
    }
  }

  const changes = computed(
    () => new Set([...repo.value.unstaged, ...repo.value.staged].map((f) => f.path)).size,
  )
  const visibleCommits = computed(() => {
    let list = repo.value.history?.focus
      ? repo.value.commits
      : visibleHistory(repo.value.commits, repo.value.branches, graphView.state(repo.value.path))
    if (branchFilter.value) {
      const branch = repo.value.branches.find((b) => branchReference(b) === branchFilter.value)
      const byHash = new Map(list.map((c) => [c.hash, c]))
      const reachable = new Set<string>()
      const pending = branch ? [branch.commitHash || branch.hash] : []
      while (pending.length) {
        const sha = pending.pop()!
        if (reachable.has(sha)) continue
        reachable.add(sha)
        pending.push(...(byHash.get(sha)?.parents || []))
      }
      list = list.filter((c) => reachable.has(c.hash))
    }
    const q = query.value.trim().toLowerCase()
    return q && (!repo.value.history || !isCommitShaQuery(q))
      ? list.filter((c) =>
          `${c.subject} ${c.author} ${c.hash} ${c.refs.join(' ')}`.toLowerCase().includes(q),
        )
      : list
  })

  const inlineBranchAvailable = computed(
    () =>
      !gitflowPanel.value &&
      !rebasePlanning.value &&
      !!repo.value.head &&
      visibleCommits.value.some((commit) => commit.hash === repo.value.head),
  )

  watch(
    modal,
    (value) => {
      inlineBranchActive.value = value === 'branch' && inlineBranchAvailable.value
    },
    { flush: 'sync' },
  )

  function notify(text: string, error = false, logId?: string) {
    const id = ++noticeId
    // Preserve error feedback when a stream of successful actions arrives.
    if (notices.value.length >= 3) {
      const oldestSuccess = notices.value.findIndex((notice) => !notice.error)
      if (oldestSuccess >= 0) notices.value.splice(oldestSuccess, 1)
      else if (!error) return
      else notices.value.shift()
    }
    notices.value.push({
      id,
      ...noticePresentation(text, error),
      error,
      ...(logId ? { logId } : {}),
    })
    const lifetime = error ? 9000 : 4500
    const expire = () => {
      if (notices.value.find((notice) => notice.id === id)?.expanded) setTimeout(expire, lifetime)
      else notices.value = notices.value.filter((notice) => notice.id !== id)
    }
    setTimeout(expire, lifetime)
  }

  async function init() {
    if (starting.value) return
    if (sessionReady) {
      try {
        await ensureSession()
      } catch (error) {
        notify((error as Error).message, true)
      }
      return
    }
    startupPhase.value = 'core'
    startupError.value = ''
    startupTrace('renderer-start')
    if (!isDesktop() && !canConnectLocalCore()) {
      sessionReady = true
      startupPhase.value = 'ready'
      return
    }
    try {
      await ensureSession()
      if (!runtime.value?.gitAvailable)
        throw new Error(runtime.value?.gitError || '未找到 Git，请安装 Git 后重新启动应用。')
      startupTrace('core-ready')
      const saved = repo.value.path ? null : readWorkspaceSession()
      if (saved) {
        restoringSession = true
        tabs.value = saved.tabs.map((tab) => ({
          id: ++nextTabId,
          kind: tab.kind,
          name:
            tab.kind === 'new'
              ? '新标签页'
              : tab.name || tab.path!.split(/[\\/]/).filter(Boolean).at(-1) || '仓库',
          path: tab.path,
        }))
        restoreTab(tabs.value[saved.active].id)
        restoringSession = false
        const selected = activeRepositoryTab.value
        if (selected?.path) {
          startupPhase.value = 'restore'
          startupTrace('restore-start')
          if (!(await open(selected.path))) {
            if (repositoryOpenError.value === '尚未信任此仓库，未读取工作区。') {
              startupPhase.value = 'ready'
              newTab()
            } else
              throw new Error(
                repositoryOpenError.value || '活动仓库未能恢复，请重试或跳过本次恢复。',
              )
          }
        }
      }
      sessionReady = true
      startupPhase.value = 'ready'
      startupTrace('ready')
    } catch (error) {
      restoringSession = false
      startupError.value = noticePresentation((error as Error).message, true).text
      startupPhase.value = isDesktop() || unloadedRepository.value ? 'error' : 'ready'
      startupTrace('failed')
      if (isDesktop()) notify((error as Error).message, true)
    }
  }

  function skipStartup() {
    if (starting.value) return
    startupTrace('skipped')
    sessionReady = true
    startupPhase.value = 'ready'
    startupError.value = ''
    newTab()
  }

  async function retryStartup() {
    if (starting.value || busy.value) return
    sessionReady = false
    if (runtime.value?.gitAvailable === false && isDesktop() && window.gitk?.refreshGitRuntime) {
      startupPhase.value = 'core'
      startupError.value = ''
      try {
        runtime.value = (await window.gitk.refreshGitRuntime()).runtime
      } catch (error) {
        startupError.value = noticePresentation((error as Error).message, true).text
        startupPhase.value = 'error'
        return
      }
      startupPhase.value = 'idle'
    }
    await init()
  }

  function clearSelection() {
    selectionVersion++
    selectedCommit.value = null
    selectedStash.value = null
    stashDiffSource.value = 'working'
    selectedFile.value = null
    fileDiffSource.value = null
    commitFiles.value = []
    commitBody.value = ''
    commitError.value = ''
    diffText.value = ''
    diffError.value = ''
    diffLoading.value = false
    commitLoading.value = false
    fileTrigger = null
  }

  function closeDiff() {
    if (!selectedFile.value) return
    const file = selectedFile.value,
      staged = fileStaged.value,
      historical = !!selectedCommit.value,
      stashed = !!selectedStash.value
    selectedFile.value = null
    fileDiffSource.value = null
    diffText.value = ''
    diffError.value = ''
    diffLoading.value = false
    selectionVersion++
    if (typeof document === 'undefined') return
    if (stashed) {
      const source = [...document.querySelectorAll<HTMLElement>('[data-stash-file-path]')].find(
        (element) => element.dataset.stashFilePath === file.path,
      )
      ;(
        source || document.querySelector<HTMLElement>('.stash-inspector [aria-label="返回工作区"]')
      )?.focus({ preventScroll: true })
      return
    }
    const source = fileTrigger?.isConnected
      ? fileTrigger
      : [...document.querySelectorAll<HTMLButtonElement>('.file-main')].find(
          (element) =>
            element.dataset.filePath === file?.path &&
            element.dataset.fileStaged === String(staged) &&
            element.dataset.fileHistorical === String(historical),
        )
    const fallback = document.querySelector<HTMLElement>(
      historical ? '.inspector [aria-label="返回工作区"]' : '.workspace-nav button',
    )
    ;(source || fallback)?.focus({ preventScroll: true })
  }

  async function requestOpen() {
    if (busy.value || choosingRepository.value) return false
    repositoryOpenError.value = ''
    if (!isDesktop()) {
      modal.value = 'open'
      return false
    }
    choosingRepository.value = true
    try {
      const selected = await desktop.chooseDirectory(
        !isNewTab.value ? repo.value.path : repositoryOpenPath.value || undefined,
        'repository',
      )
      if (!selected) return false
      return await open(selected)
    } catch (error) {
      repositoryOpenError.value = noticePresentation((error as Error).message, true).text
      modal.value = 'open'
      return false
    } finally {
      choosingRepository.value = false
    }
  }

  async function open(path: string) {
    if (busy.value) return false
    repositoryOpenPath.value = path
    invalidateSnapshot(path)
    busy.value = true
    activeOperation.value = 'open'
    operationOrigin.value = path
    repositoryOpenError.value = ''
    try {
      await ensureSession()
      if (!(await confirmRepositoryTrust(path))) {
        repositoryOpenError.value = '尚未信任此仓库，未读取工作区。'
        return false
      }
      const next = await desktop.snapshot(path)
      await acceptRepository(next)
      remember(next.path)
      modal.value = null
      notify(`已打开 ${next.name}`)
      return true
    } catch (error) {
      repositoryOpenError.value = noticePresentation((error as Error).message, true).text
      if (restoringSession || starting.value) notify((error as Error).message, true)
      else modal.value = 'open'
      return false
    } finally {
      await finishOperation()
    }
  }

  async function createRepository(kind: 'clone' | 'init', path: string, url = '') {
    if (busy.value) return false
    repositoryCreateError.value = ''
    repositoryCreateDetails.value = ''
    repositoryCreateCancelled.value = false
    invalidateSnapshot(path)
    busy.value = true
    activeOperation.value = kind
    operationOrigin.value = path
    try {
      await ensureSession()
      if (kind === 'clone') modal.value = null
      const result = await desktop.create(kind, path, url)
      if (result.requiresTrust && result.path) {
        remember(result.path)
        modal.value = null
        if (!(await confirmRepositoryTrust(result.path))) {
          notify('仓库目录已创建；尚未信任，未读取工作区。')
          return true
        }
        result.snapshot = await desktop.snapshot(result.path)
      }
      if (!result.snapshot) {
        if (result.path) remember(result.path)
        notify(result.warning || '仓库目录已创建，但状态未能读取。请手动打开检查。', true)
        modal.value = null
        return true
      }
      await acceptRepository(result.snapshot)
      remember(result.snapshot.path)
      modal.value = null
      notify(kind === 'clone' ? '仓库已克隆并打开' : '仓库已创建并打开')
      return true
    } catch (error) {
      const message = noticePresentation((error as Error).message, true)
      repositoryCreateError.value = message.text
      repositoryCreateDetails.value = message.details || ''
      repositoryCreateCancelled.value = cancelling.value
      modal.value = kind === 'clone' ? 'clone' : 'create'
      return false
    } finally {
      await finishOperation()
    }
  }

  function captureOperation() {
    return {
      repo: repo.value.path,
      tabId: activeTabId.value,
      expectedHead: repo.value.head,
      expectedBranch: repo.value.branch,
    }
  }

  function sameContext(intent: ReturnType<typeof captureOperation>) {
    return intent.repo === repo.value.path && intent.tabId === activeTabId.value
  }

  async function applySnapshot(next: Snapshot, preserve = true) {
    repo.value = snapshotWithHistory(next, preserve)
    next = repo.value
    validateBranchFilter()
    if (selectedStash.value) {
      const present =
        next.stashes?.find(
          (entry) =>
            entry.oid === selectedStash.value!.oid && entry.ref === selectedStash.value!.ref,
        ) || next.stashes?.find((entry) => entry.oid === selectedStash.value!.oid)
      if (!present) clearSelection()
      else selectedStash.value = present
      return
    }
    // Commit details and historical diffs are immutable for a fixed object ID.
    if (selectedCommit.value) {
      selectedCommit.value =
        next.commits.find((c) => c.hash === selectedCommit.value?.hash) || selectedCommit.value
      return
    }
    const file = selectedFile.value
    if (!file) return
    const preferred = fileStaged.value ? next.staged : next.unstaged
    const other = fileStaged.value ? next.unstaged : next.staged
    const present = preferred.find((f) => f.path === file.path)
    const moved = other.find((f) => f.path === file.path)
    if (present || moved) {
      if (fileDiffSource.value)
        await selectWorktreeFile(
          (present || moved)!,
          !present && fileDiffSource.value === 'staged' ? 'working' : fileDiffSource.value,
        )
      else await selectFile((present || moved)!, present ? fileStaged.value : !fileStaged.value)
    } else clearSelection()
  }

  async function applyExternalSnapshot(
    result: BackgroundReadResult,
    selectedVersion: number,
    source: 'working' | 'staged' | 'unstaged' | null,
  ) {
    const next = result.snapshot ? snapshotWithHistory(result.snapshot) : null
    if (!next) return
    externalUpdate.value = true
    try {
      if (JSON.stringify(repo.value) !== JSON.stringify(next)) {
        repo.value = next
        validateBranchFilter()
      }
      if (
        selectedVersion === selectionVersion &&
        selectedFile.value &&
        !selectedCommit.value &&
        !selectedStash.value &&
        source
      ) {
        if (result.diff) {
          selectedFile.value = result.diff.file
          fileStaged.value = result.diff.source === 'staged'
          if (fileDiffSource.value)
            fileDiffSource.value = result.diff.source === 'staged' ? 'staged' : 'working'
          if (result.diff.diff !== undefined) diffText.value = result.diff.diff
          diffTruncated.value = !!result.diff.truncated
          diffError.value = result.diff.error || ''
        } else clearSelection()
      }
      if (
        selectedStash.value &&
        !next.stashes?.some((stash) => stash.oid === selectedStash.value?.oid)
      )
        clearSelection()
      await nextTick()
    } finally {
      externalUpdate.value = false
    }
    await ensureFilteredHistory()
  }

  async function loadHistory(
    kind: 'more' | 'locate' | 'reset' = 'more',
    sha = '',
    keepFilter = false,
    preserveQuery = false,
  ) {
    const state = repo.value.history
    if (historyLoading.value || busy.value || isNewTab.value || !state) return false
    if (kind === 'more' && state.nextOffset === null) return false
    const version = ++historyRequestVersion
    const intent = captureOperation()
    const epoch = snapshotEpochs.get(intent.repo) || 0
    const selection = selectionVersion
    const originalQuery = query.value
    const originalFilter = branchFilter.value
    historyLoading.value = true
    historyError.value = ''
    try {
      const result =
        kind === 'reset'
          ? await desktop.snapshot(intent.repo)
          : await desktop.historyRead(
              intent.repo,
              kind === 'locate'
                ? { token: state.token, sha }
                : { token: state.token, offset: state.nextOffset! },
            )
      if (
        version !== historyRequestVersion ||
        !sameContext(intent) ||
        epoch !== (snapshotEpochs.get(intent.repo) || 0) ||
        repo.value.history?.signature !== state.signature ||
        busy.value
      )
        return false
      if (kind === 'reset') {
        if (query.value !== originalQuery || branchFilter.value !== originalFilter) return false
        if (!preserveQuery) query.value = ''
        clearBranchFilter(false)
        rememberBranchFilter()
        await applySnapshot(result as Snapshot, false)
      } else {
        const incoming = result as HistoryPage
        const page = {
          ...incoming,
          commits: decorateHistory(incoming.commits, repo.value.branches, repo.value.head),
        }
        if (
          kind === 'locate' &&
          ((!keepFilter && selection !== selectionVersion) ||
            query.value !== originalQuery ||
            branchFilter.value !== originalFilter)
        )
          return false
        if (kind === 'locate') {
          if (!keepFilter) {
            query.value = ''
            clearBranchFilter(false)
          }
          repo.value = {
            ...repo.value,
            commits: page.commits,
            history: { ...page.history, focusSource: keepFilter ? 'branch' : 'sha' },
          }
          if (!keepFilter && page.commits[0]) await selectCommit(page.commits[0])
        } else {
          const seen = new Set(repo.value.commits.map((c) => c.hash))
          repo.value = {
            ...repo.value,
            commits: [...repo.value.commits, ...page.commits.filter((c) => !seen.has(c.hash))],
            history: { ...page.history, focusSource: state.focusSource },
          }
        }
      }
      return true
    } catch (error) {
      if (version === historyRequestVersion && sameContext(intent))
        historyError.value = noticePresentation((error as Error).message, true).text
      return false
    } finally {
      if (version === historyRequestVersion) historyLoading.value = false
    }
  }

  async function refresh() {
    if (isNewTab.value) return
    if (busy.value) return
    const intent = captureOperation()
    invalidateSnapshot()
    busy.value = true
    activeOperation.value = 'refresh'
    try {
      const next = await desktop.snapshot(intent.repo)
      if (sameContext(intent)) await applySnapshot(next)
      return true
    } catch (error) {
      notify((error as Error).message, true)
      return false
    } finally {
      await finishOperation()
    }
  }

  async function checkoutBranch(branch: Branch, intent = captureOperation()) {
    if (busy.value || modal.value || isNewTab.value || branch.kind === 'tag') return false
    if (!sameContext(intent)) {
      notify('仓库上下文已变化，请重新选择分支。', true)
      return false
    }
    if (branch.kind === 'remote')
      return run(
        'checkout-remote',
        { fullRef: branchReference(branch), expectedOid: branch.hash },
        intent,
      )
    if (branch.name === repo.value.branch) return false
    if (branch.worktreePath && branch.worktreePath !== repo.value.path)
      return open(branch.worktreePath)
    return run('checkout', { name: branch.name, expectedOid: branch.hash }, intent)
  }

  async function prepareSync(
    kind: 'pull' | 'push',
    source?: Branch,
    origin = captureOperation(),
    method: 'ff-only' | 'merge' = 'merge',
    publish?: PublishTarget,
    review = true,
  ) {
    if (busy.value || fetchCancelling.value) return
    if (isNewTab.value) {
      modal.value = 'open'
      return
    }
    if (!sameContext(origin)) {
      notify('仓库上下文已变化，请重新打开菜单。', true)
      return
    }
    if (kind === 'pull') pullMethod.value = method
    syncIntent = { ...origin }
    const attempt = ++syncAttempt
    const selected =
      source || repo.value.branches.find((b) => b.kind === 'local' && b.name === repo.value.branch)
    syncTarget.value = selected ? { ...selected } : null
    syncPreview.value = null
    syncError.value = ''
    if (kind === 'pull' && selected?.kind === 'local' && !selected.upstream) {
      upstreamRequest.value = { branch: { ...selected }, intent: { ...origin }, method }
      modal.value = 'upstream'
      return
    }
    modal.value = review ? kind : null
    busy.value = true
    activeOperation.value = 'prepare-sync'
    operationOrigin.value = origin.repo
    try {
      if (selected && selected.kind !== 'local') throw new Error('请选择本地分支。')
      const plan = await desktop.syncPlan(syncIntent.repo, kind, {
        ...syncIntent,
        method,
        ...(publish ? { publish } : {}),
        ...(selected
          ? {
              sourceRef: selected.fullRef || `refs/heads/${selected.name}`,
              sourceOid: selected.hash,
            }
          : {}),
      })
      if (attempt !== syncAttempt || !sameContext(origin)) return
      // A renderer hot update can temporarily talk to an older Electron core.
      if (kind === 'pull' && method === 'merge' && plan.method !== 'merge')
        throw new Error('本地 Git 服务尚不支持合并拉取，请重启开发服务或桌面应用。')
      if (
        plan.kind !== kind ||
        (selected &&
          (plan.sourceRef !== (selected.fullRef || `refs/heads/${selected.name}`) ||
            plan.head !== selected.hash ||
            plan.branch !== selected.name))
      )
        throw new Error('同步计划与所选分支不一致，请重启桌面应用后重新确认。')
      syncPreview.value = plan
      if (
        review ||
        plan.publish ||
        (kind === 'push' && !['current', 'forward'].includes(plan.remoteCheck?.state || ''))
      )
        modal.value = kind
    } catch (error) {
      if (attempt === syncAttempt) {
        modal.value = kind
        const message = (error as Error).message
        syncError.value =
          kind === 'push' && /尚无明确上游/.test(message)
            ? `分支 ${selected?.name || repo.value.branch} 尚未关联远端分支，无法确定推送目标。请重启开发服务或桌面应用，加载首次推送功能。`
            : kind === 'pull' && /尚无明确上游/.test(message)
              ? `分支 ${selected?.name || repo.value.branch} 尚未关联远端分支。请先推送并建立关联，或设置上游后再拉取。`
              : message
      }
    } finally {
      await finishOperation()
    }
  }

  async function sync(
    kind: 'pull' | 'push',
    source?: Branch,
    origin = captureOperation(),
    method: 'ff-only' | 'merge' = pullMethod.value,
  ) {
    if (busy.value || fetchCancelling.value) return false
    const epoch = cancellationEpoch
    await prepareSync(kind, source, origin, method, undefined, false)
    if (
      epoch !== cancellationEpoch ||
      !sameContext(origin) ||
      modal.value ||
      !syncPreview.value ||
      syncError.value
    )
      return false
    return confirmSync()
  }

  async function setPublishTarget(remote: string, branch: string) {
    if (busy.value || !syncIntent || !syncTarget.value) return
    await prepareSync('push', syncTarget.value, syncIntent, 'ff-only', { remote, branch })
  }

  async function confirmUpstream(fullRef: string) {
    const request = upstreamRequest.value
    if (!request || busy.value || !sameContext(request.intent)) {
      notify('仓库上下文已变化，请重新设置上游。', true)
      return
    }
    const remote = repo.value.branches.find(
      (b) => b.kind === 'remote' && branchReference(b) === fullRef && !b.symbolicTarget,
    )
    if (!remote) {
      notify('请选择远程实际分支，请先获取更新。', true)
      return
    }
    const ok = await run(
      'set-upstream',
      {
        name: request.branch.name,
        expectedOid: request.branch.hash,
        fullRef,
        upstreamOid: remote.hash,
      },
      request.intent,
    )
    if (ok) {
      upstreamRequest.value = null
      const updated = repo.value.branches.find(
        (b) => b.kind === 'local' && b.name === request.branch.name,
      )
      if (updated) await sync('pull', updated, request.intent, request.method)
    }
  }

  async function retrySync(kind: 'pull' | 'push') {
    if (busy.value || !syncIntent) return
    if (!sameContext(syncIntent)) {
      syncError.value = '仓库上下文已变化，请关闭后重新打开菜单。'
      return
    }
    const selected = syncTarget.value
    if (!selected) {
      syncError.value = '没有明确的同步分支，请关闭后重新选择本地分支。'
      return
    }
    const intent = { ...syncIntent }
    const attempt = ++syncAttempt
    let current: Branch | undefined
    invalidateSnapshot()
    busy.value = true
    activeOperation.value = 'refresh'
    syncPreview.value = null
    syncError.value = ''
    try {
      const next = await desktop.snapshot(intent.repo)
      if (attempt !== syncAttempt) return
      if (!sameContext(intent)) {
        syncError.value = '仓库上下文已变化，请关闭后重新打开菜单。'
        return
      }
      await applySnapshot(next)
      current = repo.value.branches.find(
        (b) =>
          b.kind === 'local' &&
          b.name === selected.name &&
          (b.fullRef || `refs/heads/${b.name}`) ===
            (selected.fullRef || `refs/heads/${selected.name}`),
      )
      if (!current) {
        syncError.value = `分支 ${selected.name} 已不存在，请关闭后重新选择。`
        return
      }
    } catch (error) {
      if (attempt === syncAttempt) syncError.value = (error as Error).message
      return
    } finally {
      await finishOperation()
    }
    if (attempt === syncAttempt)
      await prepareSync(kind, current, captureOperation(), pullMethod.value)
  }

  async function setPullMethod(method: 'ff-only' | 'merge') {
    await prepareSync('pull', syncTarget.value || undefined, captureOperation(), method)
  }
  async function fetchBeforePull() {
    const target = syncTarget.value
    if (target && target.name !== repo.value.branch) {
      syncError.value = `请先切换到 ${target.name}，再获取并合并该分支的远端更新。`
      return
    }
    const origin = captureOperation()
    if (await run('fetch', {}, origin)) {
      const current = target
        ? repo.value.branches.find(
            (branch) => branch.kind === 'local' && branch.name === target.name,
          )
        : undefined
      await prepareSync('pull', current, origin)
    }
  }

  async function confirmSync() {
    if (!syncPreview.value || !syncIntent) return false
    if (
      syncPreview.value.kind === 'push' &&
      (!syncPreview.value.remoteCheck ||
        ['error', 'behind', 'diverged'].includes(syncPreview.value.remoteCheck.state))
    )
      return false
    return run(syncPreview.value.kind, { planId: syncPreview.value.id }, syncIntent)
  }

  async function pullAndPush() {
    const plan = syncPreview.value
    if (
      busy.value ||
      !syncIntent ||
      !plan ||
      plan.kind !== 'push' ||
      plan.publish ||
      !['behind', 'diverged'].includes(plan.remoteCheck?.state || '')
    )
      return false
    if (plan.branch !== repo.value.branch) {
      syncError.value = `请先切换到 ${plan.branch}，再拉取并推送该分支。`
      return false
    }
    const intent = { ...syncIntent }
    modal.value = null
    return run('pull-and-push', { planId: plan.id }, intent)
  }

  async function prepareSelectedCommit(paths: string[]) {
    if (busy.value) return null
    if (isNewTab.value) {
      modal.value = 'open'
      return null
    }
    if (commitContextBlocked.value) {
      notify(commitContextBlocked.value, true)
      return null
    }
    const intent = captureOperation(),
      startedAt = cancellationEpoch
    selectedCommitIntents.clear()
    busy.value = true
    activeOperation.value = 'prepare-commit'
    try {
      const plan = await desktop.selectedCommitPlan(intent.repo, {
        expectedHead: intent.expectedHead,
        expectedBranch: intent.expectedBranch,
        paths,
      })
      if (startedAt !== cancellationEpoch || !sameContext(intent)) return null
      if (
        !plan.id ||
        plan.scope !== 'working-tree' ||
        !Array.isArray(plan.paths) ||
        !Array.isArray(plan.partialPaths) ||
        plan.paths.length !== new Set(paths).size ||
        plan.paths.some((path) => !paths.includes(path))
      )
        throw new Error('提交计划与所选文件不一致，请刷新后重新复核。')
      selectedCommitIntents.set(plan.id, { intent, plan })
      return plan
    } catch (error) {
      notify((error as Error).message, true)
      return null
    } finally {
      await finishOperation()
    }
  }

  async function commitSelected(planId: string, confirmPartial = false) {
    if (busy.value) return false
    const prepared = selectedCommitIntents.get(planId)
    if (
      !prepared ||
      !sameContext(prepared.intent) ||
      prepared.intent.expectedHead !== repo.value.head ||
      prepared.intent.expectedBranch !== repo.value.branch ||
      prepared.plan.expiresAt <= Date.now()
    ) {
      selectedCommitIntents.delete(planId)
      notify('提交计划已过期或仓库已变化，请重新复核所选文件。', true)
      return false
    }
    if (prepared.plan.partialPaths.length && !confirmPartial) {
      notify('所选文件含部分暂存内容，请先确认提交完整工作区版本。', true)
      return false
    }
    if (commitContextBlocked.value) {
      notify(commitContextBlocked.value, true)
      return false
    }
    selectedCommitIntents.delete(planId)
    return run(
      'commit-selected',
      { planId, message: commitMessage.value, confirmPartial },
      prepared.intent,
    )
  }

  function runFetch(intent = captureOperation()): Promise<boolean> {
    if (fetchTask) {
      if (fetchOrigin.value === intent.repo) return fetchTask
      notify('已有其他仓库正在获取远程更新，请稍后再试。', true)
      return Promise.resolve(false)
    }
    if (busy.value || fetchCancelling.value || !sameContext(intent)) return Promise.resolve(false)
    if (isNewTab.value) {
      modal.value = 'open'
      return Promise.resolve(false)
    }
    fetching.value = true
    fetchOrigin.value = intent.repo
    const epoch = snapshotEpochs.get(intent.repo) || 0
    const startedAt = cancellationEpoch
    fetchTask = (async () => {
      try {
        const plan = await desktop.syncPlan(intent.repo, 'fetch', intent)
        if (startedAt !== cancellationEpoch) {
          notify('已放弃获取计划，未开始执行。')
          return false
        }
        const result = await desktop.action(intent.repo, {
          action: 'fetch',
          planId: plan.id,
        })
        if (result.snapshot && epoch === (snapshotEpochs.get(intent.repo) || 0)) {
          if (sameContext(intent)) await applySnapshot(result.snapshot)
          else {
            const tab = tabs.value.find(
              (item) => item.id === intent.tabId && item.path === intent.repo,
            )
            if (
              tab?.state &&
              tab.state.repo.head === result.snapshot.head &&
              tab.state.repo.branch === result.snapshot.branch
            )
              tab.state.repo = result.snapshot
          }
        }
        const status = await desktop.fetchStatus(intent.repo).catch(() => null)
        if (status) fetchStatuses.value[intent.repo] = status
        const name = intent.repo.split(/[\\/]/).pop()
        const steps = result.steps?.map(
          (step) => `${step.remote}：${step.ok ? '已获取' : step.message || '获取未完成'}`,
        )
        notify(
          [
            result.error ||
              result.warning ||
              (result.outcome === 'succeeded'
                ? `已获取 ${name} 的远程更新`
                : `${name} 的远程更新未全部完成，请核对各远端结果`),
            ...(steps || []),
          ].join('\n'),
          !!(result.error || result.warning) || result.outcome !== 'succeeded',
          result.logId,
        )
        return result.outcome === 'succeeded'
      } catch (error) {
        notify(`获取 ${intent.repo.split(/[\\/]/).pop()} 未完成：${(error as Error).message}`, true)
        return false
      } finally {
        await cancellationTask?.catch(() => {})
        fetching.value = false
        fetchCancelling.value = false
        fetchOrigin.value = ''
        fetchTask = null
      }
    })()
    return fetchTask
  }

  async function run(
    action: string,
    extra: Record<string, unknown> = {},
    intent = captureOperation(),
  ) {
    if (action === 'fetch') return runFetch(intent)
    if (fetchCancelling.value) {
      notify('正在取消此前操作，请等待结果确认。', true)
      return false
    }
    if (isNewTab.value) {
      modal.value = 'open'
      return false
    }
    if (busy.value) return false
    if (modal.value === 'branch' && inlineBranchActive.value && action !== 'create-branch') {
      notify('请先创建或取消正在输入的分支。', true)
      return false
    }
    if (rebasePlanning.value && action !== 'rebase-start') {
      notify('请先完成或取消提交编排。', true)
      return false
    }
    if (['commit', 'commit-selected'].includes(action) && commitContextBlocked.value) {
      notify(commitContextBlocked.value, true)
      return false
    }
    if (!sameContext(intent)) {
      notify('仓库上下文已变化，请重新确认操作。', true)
      return false
    }
    const isCheckout = [
      'checkout',
      'checkout-remote',
      'checkout-remote-confirm',
      'stash-checkout',
      'checkout-revision',
    ].includes(action)
    const createsAndSwitches =
      extra.switchAfter === true &&
      ['branch', 'create-branch', 'track-branch', 'gitflow-start'].includes(action)
    checkoutTarget.value =
      isCheckout || createsAndSwitches
        ? (typeof extra.name === 'string' ? extra.name : '') ||
          (action === 'stash-checkout' ? checkoutProtection.value?.branch : undefined) ||
          (action === 'checkout-remote-confirm' ? remoteCheckout.value?.branch : undefined) ||
          (typeof extra.fullRef === 'string'
            ? extra.fullRef.replace(/^refs\/remotes\//, '')
            : '') ||
          '目标分支'
        : ''
    invalidateSnapshot()
    busy.value = true
    activeOperation.value = action
    operationOrigin.value = intent.repo
    lastActionResult.value = null
    const isSync = ['fetch', 'pull', 'push', 'pull-and-push'].includes(action)
    const wasSyncModal = modal.value === 'push' || modal.value === 'pull'
    const operationModal = modal.value
    const startedAt = cancellationEpoch
    let worktreePatched = false
    let checkoutNotice: { text: string; head: string; branch: string } | null = null
    try {
      const request = {
        expectedHead: intent.expectedHead,
        expectedBranch: intent.expectedBranch,
        ...extra,
        ...(['stage', 'unstage'].includes(action) ? { refresh: 'worktree' } : {}),
        action,
      } as GitAction
      if (isSync && !('planId' in request)) {
        const plan = await desktop.syncPlan(
          intent.repo,
          action as 'fetch' | 'pull' | 'push',
          intent,
        )
        if (startedAt !== cancellationEpoch) {
          notify('已放弃本次同步计划，未开始执行。')
          return false
        }
        Object.assign(request, { planId: plan.id })
      }
      const result = await desktop.action(intent.repo, request)
      if (!sameContext(intent)) return false
      lastActionResult.value = result
      if (result.snapshot) await applySnapshot(result.snapshot)
      else if (result.worktree) {
        const update = result.worktree
        if (
          update.path !== intent.repo ||
          update.head !== repo.value.head ||
          update.branch !== repo.value.branch
        ) {
          requestExternalRefresh()
          notify('操作已返回，仓库上下文发生变化，正在重新核对状态。', true)
          return false
        }
        repo.value = { ...repo.value, staged: update.staged, unstaged: update.unstaged }
        worktreePatched = true
        const file = selectedFile.value
        if (file && !selectedCommit.value && !selectedStash.value) {
          const preferred = fileStaged.value ? update.staged : update.unstaged
          const other = fileStaged.value ? update.unstaged : update.staged
          const present = preferred.find((entry) => entry.path === file.path)
          const moved = other.find((entry) => entry.path === file.path)
          if (!present && !moved) clearSelection()
          else if (fileDiffSource.value)
            void selectWorktreeFile(
              (present || moved)!,
              !present && fileDiffSource.value === 'staged' ? 'working' : fileDiffSource.value,
            )
          else void selectFile((present || moved)!, present ? fileStaged.value : !fileStaged.value)
        }
      }
      if (
        action.startsWith('rebase-') &&
        ['succeeded', 'partial'].includes(result.outcome || 'succeeded')
      ) {
        clearSelection()
        clearBranchFilter()
      }
      if (action === 'checkout' && result.checkoutProtection) {
        checkoutProtection.value = { ...result.checkoutProtection, intent }
        modal.value = 'checkout-protected'
      }
      if (result.remoteCheckoutProtection) {
        remoteCheckout.value = { ...result.remoteCheckoutProtection, intent }
        modal.value = 'checkout-remote'
      }
      const outcome = result.outcome || 'succeeded'
      if (['commit', 'commit-selected'].includes(action) && outcome === 'succeeded') {
        commitMessage.value = ''
        commitDescription.value = ''
      }
      if (
        ([
          'checkout',
          'checkout-remote',
          'checkout-remote-confirm',
          'stash-checkout',
          'branch',
        ].includes(action) ||
          extra.switchAfter) &&
        outcome === 'succeeded'
      )
        clearSelection()
      if (
        ([
          'checkout',
          'checkout-remote',
          'checkout-remote-confirm',
          'stash-checkout',
          'branch',
          'rename-branch',
          'delete-branch',
        ].includes(action) ||
          extra.switchAfter) &&
        outcome === 'succeeded'
      )
        clearBranchFilter()
      const completed =
        outcome === 'succeeded' ||
        (['create-branch', 'track-branch'].includes(action) && !!result.warning && !result.error)
      const cancellationRequested = startedAt !== cancellationEpoch
      if (completed && !cancellationRequested && modal.value === operationModal) modal.value = null
      if (wasSyncModal && cancellationRequested)
        syncError.value =
          result.error ||
          result.warning ||
          (outcome === 'succeeded'
            ? '操作最终已经完成，请核对实际仓库状态；取消请求不代表操作已撤销。'
            : '操作已停止，请核对实际仓库状态。取消不等于回滚。')
      const messages: Record<string, string> = {
        'stash-checkout': '已贮藏并切换，记录保留，可手动恢复',
        'gitflow-finish': '完成 GitFlow 分支',
        'gitflow-finish-continue': '继续完成 GitFlow',
        'gitflow-finish-stop': '停止 GitFlow 后续步骤',
        'merge-resolve': '文件已保存并标记解决',
        'merge-finish': '合并提交已创建，可以推送',
        'merge-abort': '合并已中止',
        'rebase-start': '变基已完成，请核对历史与暂存状态后再推送',
        'rebase-continue': '变基已继续执行，请核对当前状态',
        'rebase-skip': '已跳过当前提交并继续变基',
        'rebase-abort': '变基已中止',
        'stash-create': '修改已贮藏，提交说明草稿保留',
        'stash-apply': '贮藏已恢复，记录保留',
        'stash-pop': '贮藏已恢复并移除',
        'stash-drop': '贮藏已删除',
        'set-upstream': '已设置上游分支',
        'merge-branch': '合并操作已执行，请核对结果',
        'fast-forward': '当前分支已快进',
        'create-tag': '标签已创建',
        'delete-remote-branch': '远程分支已删除',
        stage: '文件已暂存',
        unstage: '已取消暂存',
        commit: '提交成功',
        branch: '分支已创建并切换',
        checkout: '已切换分支',
        'set-fetch-scope': '获取范围已保存，历史深度未改变；点击获取更新分支列表',
        unshallow: '补全历史操作已完成，请核对仓库历史状态',
        fetch: '远程分支已获取，已清理获取范围内的失效远程引用（不含标签）',
        pull: '拉取已完成',
        'pull-and-push': '拉取并推送已完成',
        push: '指定分支已推送',
        'create-branch': extra.switchAfter ? '分支创建操作已完成，请检查当前分支' : '分支已创建',
        'track-branch': '本地跟踪分支已创建',
        'rename-branch': '分支已重命名',
        'delete-branch': '本地分支已删除，可通过仓库菜单中的 Git 操作恢复找回',
        'partial-stage': '所选修改已更新暂存状态，工作文件保留',
        'recovery-undo': '最近提交已撤回，代码与暂存区保留',
        'checkout-revision': '已检出修订，当前处于分离 HEAD',
        'commit-operation': '提交操作已完成，请核对历史和工作区',
        'commit-sequence': '优选或还原步骤已完成',
        'recovery-restore': '本地分支已恢复',
      }
      if (result.steps?.length && action === 'fetch')
        notify(
          result.steps
            .map(
              (step) => `${step.remote}：${step.ok ? '获取/推送完成' : step.message || '未完成'}`,
            )
            .join('\n'),
          outcome !== 'succeeded',
        )
      if (result.error) {
        notify(
          `${outcome === 'partial' && !['commit', 'commit-selected'].includes(action) ? '操作已部分完成。' : ''}${result.error}`,
          true,
          result.logId,
        )
        if (isSync) {
          syncError.value = result.error
          if (!wasSyncModal && !result.snapshot?.merge)
            modal.value = action === 'pull-and-push' ? 'push' : (action as 'pull' | 'push')
        }
      }
      if (
        result.warning &&
        !(action === 'pull' && result.snapshot?.merge?.active) &&
        !(
          ['rebase-start', 'rebase-continue'].includes(action) &&
          result.snapshot?.merge?.rebase &&
          /还有 \d+ 个冲突文件/.test(result.warning)
        )
      )
        notify(result.warning, true, result.logId)
      if (result.cleanupError)
        notify(`操作临时引用清理失败：${result.cleanupError}，请检查仓库。`, true)
      if (result.refreshError)
        notify(
          `操作结果：${{ succeeded: '已完成', failed: '未正常完成', partial: '部分完成', cancelled: '已取消' }[outcome]}；状态刷新失败：${result.refreshError}。请刷新确认，不要重复执行。`,
          true,
        )
      if (!result.error && !result.warning && !result.refreshError && outcome === 'succeeded') {
        const text =
          action === 'commit-selected'
            ? '所选文件已提交'
            : messages[action] || result.output || '操作完成'
        if (isCheckout || createsAndSwitches) {
          if (result.snapshot && !cancellationRequested)
            checkoutNotice = { text, head: result.snapshot.head, branch: result.snapshot.branch }
          else if (!result.snapshot)
            notify('检出命令已完成，但未取得最新仓库状态。请刷新确认，不要重复执行。', true)
        } else notify(text)
      }
      return completed
    } catch (error) {
      notify((error as Error).message, true)
      if (wasSyncModal) syncError.value = (error as Error).message
      // IPC/transport failures may happen after Git already changed the repo.
      try {
        const next = await desktop.snapshot(intent.repo)
        if (sameContext(intent)) await applySnapshot(next)
      } catch {
        notify('无法重新读取仓库，请手动刷新确认操作结果。', true)
      }
      return false
    } finally {
      if (isSync) syncPreview.value = null
      await finishOperation()
      if (checkoutNotice) {
        // Flush branch decorations and remove the checkout overlay before announcing success.
        await nextTick()
        if (
          sameContext(intent) &&
          !busy.value &&
          startedAt === cancellationEpoch &&
          repo.value.head === checkoutNotice.head &&
          repo.value.branch === checkoutNotice.branch
        )
          notify(checkoutNotice.text)
      }
      if (worktreePatched) requestExternalRefresh()
    }
  }

  async function selectCommit(commit: Commit) {
    if (isNewTab.value) return
    clearSelection()
    selectedCommit.value = commit
    const version = selectionVersion
    commitLoading.value = true
    try {
      const result = await desktop.commit(repo.value.path, commit.hash)
      if (version !== selectionVersion) return
      commitFiles.value = result.files
      commitBody.value = result.body
    } catch (error) {
      if (version === selectionVersion) {
        commitError.value = (error as Error).message
        notify(commitError.value, true)
      }
    } finally {
      if (version === selectionVersion) commitLoading.value = false
    }
  }

  async function selectFile(
    file: FileChange,
    staged = false,
    trigger?: HTMLElement | null,
    source: 'working' | 'staged' | null = null,
  ) {
    if (isNewTab.value) return
    if (trigger) fileTrigger = trigger
    const version = ++selectionVersion
    selectedFile.value = file
    fileStaged.value = staged
    fileDiffSource.value = source
    diffText.value = ''
    diffError.value = ''
    diffLoading.value = true
    diffTruncated.value = false
    try {
      const result = await desktop.diff(
        repo.value.path,
        file.path,
        source === 'working' ? 'working' : staged,
        selectedCommit.value?.hash,
      )
      if (version !== selectionVersion) return
      diffText.value = result.diff
      diffTruncated.value = result.truncated
    } catch (error) {
      if (version === selectionVersion) {
        diffError.value = (error as Error).message
        notify(diffError.value, true)
      }
    } finally {
      if (version === selectionVersion) diffLoading.value = false
    }
  }

  async function selectWorktreeFile(
    file: FileChange,
    source: 'working' | 'staged' = 'working',
    trigger?: HTMLElement | null,
  ) {
    return selectFile(file, source === 'staged', trigger, source)
  }

  async function chooseDirectory() {
    try {
      return await desktop.chooseDirectory()
    } catch (error) {
      notify((error as Error).message, true)
      return null
    }
  }

  async function finishOperation() {
    // A late cancel acknowledgement must not abort the next user operation.
    await cancellationTask?.catch(() => {})
    busy.value = false
    activeOperation.value = ''
    operationOrigin.value = ''
    checkoutTarget.value = ''
    cancelling.value = false
    await ensureFilteredHistory()
  }

  async function cancelOperation() {
    if (!busy.value && fetching.value) {
      if (fetchCancelling.value) return
      cancellationEpoch++
      fetchCancelling.value = true
      const task = desktop.cancel()
      cancellationTask = task
      try {
        await task
      } catch (error) {
        notify(`取消请求未确认：${(error as Error).message}。请等待获取结束后核对。`, true)
      } finally {
        if (cancellationTask === task) cancellationTask = null
      }
      return
    }
    if (!busy.value || cancelling.value) return
    cancellationEpoch++
    const preparing =
      activeOperation.value === 'prepare-sync' ||
      ((modal.value === 'push' || modal.value === 'pull') && activeOperation.value === 'refresh')
    cancelling.value = true
    if (preparing) {
      syncAttempt++
      syncPreview.value = null
    }
    const task = desktop.cancel()
    cancellationTask = task
    try {
      await task
      if (preparing)
        syncError.value = '已放弃本次同步计划，未执行推送或拉取。请等待读取结束后关闭或重新读取。'
    } catch (error) {
      const message = `取消请求未确认：${(error as Error).message}。请等待操作结果后核对状态。`
      if (preparing) syncError.value = message
      notify(message, true)
      cancelling.value = false
    } finally {
      if (cancellationTask === task) cancellationTask = null
    }
  }

  async function openResource(resource: 'git-docs' | 'git-book') {
    try {
      await desktop.openResource(resource)
    } catch (error) {
      notify((error as Error).message, true)
    }
  }

  return {
    externalRefreshing,
    externalUpdate,
    externalRefreshError,
    externalRefreshDeferred,
    requestExternalRefresh,
    startRepositoryObservation,
    startupPhase,
    startupError,
    starting,
    unloadedRepository,
    activeRepositoryTab,
    historyPreferenceWarning,
    historyLoading,
    historyError,
    loadHistory,
    repositoryOpenError,
    repositoryOpenPath,
    choosingRepository,
    repositoryCreateError,
    repositoryCreateDetails,
    repositoryCreateCancelled,
    requestOpen,
    trustRequest,
    trustError,
    trustApproving,
    approveTrust,
    cancelTrust,
    skipStartup,
    retryStartup,
    activityPanelOpen,
    activityLogId,
    activityLogFocus,
    openFetchLog,
    openActivityLog,
    activitySettings,
    saveActivitySettings,
    startAutomaticFetch,
    automaticFetching,
    currentFetchStatus,
    rebasePlanning,
    checkoutProtection,
    remoteCheckout,
    upstreamRequest,
    confirmUpstream,
    checkoutBranch,
    mergeDraftTabs,
    pullMethod,
    setPullMethod,
    fetchBeforePull,
    draftTabs,
    discardCommitDrafts,
    operationLabel,
    fetching,
    fetchOrigin,
    fetchCancelling,
    isWorking,
    inlineBranchAvailable,
    inlineBranchActive,
    operationOrigin,
    backgroundFetch,
    blocksTabs,
    indexWorking,
    checkingOut,
    checkoutTarget,
    captureOperation,
    prepareSync,
    retrySync,
    confirmSync,
    pullAndPush,
    sync,
    prepareSelectedCommit,
    commitSelected,
    syncTarget,
    syncPreview,
    setPublishTarget,
    syncError,
    activeOperation,
    showAuthor,
    showTime,
    showSha,
    updateViewport,
    resetColumns,
    repo,
    connected,
    connecting,
    connectionError,
    busy,
    cancelling,
    query,
    branchFilter,
    branchFilterLabel,
    sidebarBranchSelection,
    setBranchFilter,
    clearBranchFilter,
    sidebarQuery,
    gitflowPanel,
    commitContextBlocked,
    selectedCommit,
    selectedStash,
    stashDiffSource,
    selectedFile,
    fileStaged,
    fileDiffSource,
    diffText,
    diffTruncated,
    diffError,
    diffLoading,
    commitLoading,
    commitError,
    commitFiles,
    commitBody,
    commitMessage,
    modal,
    notices,
    recent,
    changes,
    visibleCommits,
    init,
    open,
    refresh,
    run,
    notify,
    clearSelection,
    selectCommit,
    selectFile,
    selectWorktreeFile,
    tabs,
    activeTabId,
    isNewTab,
    newTab,
    activateTab,
    closeTab,
    closeTabs,
    pendingCloseIds,
    pendingCloseTabs,
    pendingCloseId,
    commitDescription,
    createRepository,
    forgetRecent,
    runtime,
    chooseDirectory,
    cancelOperation,
    openResource,
    lastActionResult,
    inspectorCovered,
    closeDiff,
  }
})
