import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { branchReference } from '../references'
import { emptyRepository } from '../repositoryState'
import {
  canConnectLocalCore,
  desktop,
  isDesktop,
  onLocalCoreDisconnected,
} from '../services/desktop'
import type {
  ActionResult,
  CheckoutProtection,
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
  WorkspaceState,
  WorkspaceTab,
} from '../types'

export const useRepositoryStore = defineStore('repository', () => {
  const repo = ref<Snapshot>(emptyRepository())
  const connected = ref(false)
  const connecting = ref(false),
    connectionError = ref('')
  onScopeDispose(
    onLocalCoreDisconnected(() => {
      connected.value = false
      connectionError.value = '本机连接已中断，请重新连接并核对仓库状态。'
    }),
  )
  const busy = ref(false)
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
  function clearBranchFilter() {
    historyFilter.value = null
  }
  function setBranchFilter(branch: Branch, source = '', toggle = false) {
    const fullRef = branchReference(branch)
    historyFilter.value =
      toggle && historyFilter.value?.fullRef === fullRef && historyFilter.value.source === source
        ? null
        : { fullRef, source }
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
    | 'checkout'
    | 'push'
    | 'pull'
    | 'help'
    | 'stash-delete'
    | 'merge-conflicts'
    | 'gitflow-finish'
    | 'checkout-protected'
    | null
  >(null)
  const pendingBranch = ref('')
  const syncPreview = ref<SyncPlan | null>(null),
    syncError = ref('')
  const pullMethod = ref<'ff-only' | 'merge'>('ff-only')
  const syncTarget = ref<Branch | null>(null)
  const activeOperation = ref('')
  const operationLabel = computed(
    () =>
      ({
        'stash-checkout': '贮藏并切换',
        'gitflow-finish': '完成 GitFlow 分支',
        'gitflow-finish-continue': '继续完成 GitFlow',
        'gitflow-finish-stop': '停止 GitFlow 后续步骤',
        'merge-resolve': '保存冲突解决结果',
        'merge-finish': '完成合并',
        'merge-abort': '中止合并',
        'stash-create': '贮藏修改',
        'stash-apply': '恢复贮藏',
        'stash-pop': '恢复并移除贮藏',
        'stash-drop': '删除贮藏',
        'gitflow-save': '保存 GitFlow 配置',
        'gitflow-init': '初始化 GitFlow',
        'gitflow-start': '开始 GitFlow 分支',
        'gitflow-preview': '读取初始化计划',
        fetch: '获取远程分支',
        pull: '拉取远程分支',
        push: '推送指定分支',
        'prepare-sync': '读取同步目标',
        refresh: '刷新仓库',
        stage: '暂存文件',
        unstage: '取消暂存',
        commit: '创建提交',
        checkout: '切换分支',
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
  const tabs = ref<WorkspaceTab[]>([{ id: 1, kind: 'new', name: '新标签页' }])
  const activeTabId = ref(1)
  const pendingCloseId = ref<number | null>(null)
  const isNewTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value)?.kind === 'new',
  )
  const commitContextBlocked = computed(() =>
    isNewTab.value
      ? '请先打开仓库工作区'
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
          (mergeDraftTabs.value.has(tab.id) ||
            (tab.id === activeTabId.value
              ? !!(commitMessage.value.trim() || commitDescription.value.trim())
              : !!(tab.state?.commitMessage.trim() || tab.state?.commitDescription.trim()))),
      )
      .map((tab) => ({ id: tab.id, name: tab.name })),
  )

  function saveTab() {
    const tab = tabs.value.find((tab) => tab.id === activeTabId.value)
    if (!tab || tab.kind === 'new') return
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
    if (
      busy.value ||
      modal.value ||
      id === activeTabId.value ||
      !tabs.value.some((tab) => tab.id === id)
    )
      return
    saveTab()
    restoreTab(id)
  }

  function restoreTab(id: number) {
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
      clearBranchFilter()
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
    // A selection whose detail fetch was interrupted is reloaded on return.
    if (selectedCommit.value && !commitBody.value && !commitError.value)
      void selectCommit(selectedCommit.value)
  }

  function newTab() {
    if (busy.value || modal.value) return
    saveTab()
    const id = ++nextTabId
    tabs.value.push({ id, kind: 'new', name: '新标签页' })
    restoreTab(id)
  }

  function closeTab(id: number, confirmed = false) {
    if (busy.value || (modal.value && modal.value !== 'close')) return
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index < 0) return
    if (id === activeTabId.value) saveTab()
    const state = tabs.value[index]?.state
    if (
      !confirmed &&
      (mergeDraftTabs.value.has(id) ||
        state?.commitMessage.trim() ||
        state?.commitDescription.trim())
    ) {
      pendingCloseId.value = id
      modal.value = 'close'
      return
    }
    mergeDraftTabs.value.delete(id)
    tabs.value.splice(index, 1)
    modal.value = null
    pendingCloseId.value = null
    if (!tabs.value.length) {
      const nextId = ++nextTabId
      tabs.value.push({ id: nextId, kind: 'new', name: '新标签页' })
      restoreTab(nextId)
    } else if (activeTabId.value === id) {
      restoreTab(tabs.value[Math.min(index, tabs.value.length - 1)].id)
    }
  }

  async function acceptRepository(next: Snapshot) {
    saveTab()
    const existing = tabs.value.find((tab) => tab.kind === 'repository' && tab.path === next.path)
    if (existing) {
      modal.value = null
      restoreTab(existing.id)
      await applySnapshot(next)
      return
    }
    let tab = tabs.value.find((tab) => tab.id === activeTabId.value && tab.kind === 'new')
    if (!tab) {
      tab = { id: ++nextTabId, kind: 'repository', name: next.name }
      tabs.value.push(tab)
    }
    Object.assign(tab, { kind: 'repository', name: next.name, path: next.path })
    activeTabId.value = tab.id
    repo.value = next
    query.value = ''
    clearBranchFilter()
    sidebarQuery.value = ''
    commitMessage.value = ''
    commitDescription.value = ''
    clearSelection()
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
    let list = repo.value.commits
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
    return q
      ? list.filter((c) =>
          `${c.subject} ${c.author} ${c.hash} ${c.refs.join(' ')}`.toLowerCase().includes(q),
        )
      : list
  })

  function notify(text: string, error = false) {
    const id = ++noticeId
    // Preserve error feedback when a stream of successful actions arrives.
    if (notices.value.length >= 3) {
      const oldestSuccess = notices.value.findIndex((notice) => !notice.error)
      if (oldestSuccess >= 0) notices.value.splice(oldestSuccess, 1)
      else if (!error) return
      else notices.value.shift()
    }
    notices.value.push({ id, text, error })
    setTimeout(
      () => {
        notices.value = notices.value.filter((n) => n.id !== id)
      },
      error ? 9000 : 4500,
    )
  }

  async function init() {
    if (!isDesktop() && !canConnectLocalCore()) return
    try {
      await ensureSession()
      if (!runtime.value?.gitAvailable)
        notify(runtime.value?.gitError || '未找到 Git，请安装 Git 后重新启动应用。', true)
    } catch (error) {
      connected.value = false
      if (isDesktop()) notify((error as Error).message, true)
    }
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

  async function open(path: string) {
    if (busy.value) return false
    busy.value = true
    try {
      await ensureSession()
      const next = await desktop.snapshot(path)
      await acceptRepository(next)
      remember(next.path)
      modal.value = null
      notify(`已打开 ${next.name}`)
      return true
    } catch (error) {
      notify((error as Error).message, true)
      return false
    } finally {
      await finishOperation()
    }
  }

  async function createRepository(kind: 'clone' | 'init', path: string, url = '') {
    if (busy.value) return false
    busy.value = true
    try {
      await ensureSession()
      const result = await desktop.create(kind, path, url)
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
      notify((error as Error).message, true)
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

  async function applySnapshot(next: Snapshot) {
    repo.value = next
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
      if (fileDiffSource.value) await selectWorktreeFile((present || moved)!, fileDiffSource.value)
      else await selectFile((present || moved)!, present ? fileStaged.value : !fileStaged.value)
    } else clearSelection()
  }

  async function refresh() {
    if (isNewTab.value) return
    if (busy.value) return
    const intent = captureOperation()
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

  async function prepareSync(
    kind: 'pull' | 'push',
    source?: Branch,
    origin = captureOperation(),
    method: 'ff-only' | 'merge' = 'ff-only',
  ) {
    if (busy.value) return
    if (isNewTab.value) {
      modal.value = 'open'
      return
    }
    if (!sameContext(origin)) {
      notify('仓库上下文已变化，请重新打开菜单。', true)
      return
    }
    pullMethod.value = method
    syncIntent = { ...origin }
    const attempt = ++syncAttempt
    const selected =
      source || repo.value.branches.find((b) => b.kind === 'local' && b.name === repo.value.branch)
    syncTarget.value = selected ? { ...selected } : null
    syncPreview.value = null
    syncError.value = ''
    modal.value = kind
    busy.value = true
    activeOperation.value = 'prepare-sync'
    try {
      if (selected && selected.kind !== 'local') throw new Error('请选择本地分支。')
      const plan = await desktop.syncPlan(syncIntent.repo, kind, {
        ...syncIntent,
        method,
        ...(selected
          ? {
              sourceRef: selected.fullRef || `refs/heads/${selected.name}`,
              sourceOid: selected.hash,
            }
          : {}),
      })
      if (attempt !== syncAttempt || !sameContext(origin)) return
      // A renderer hot update can temporarily talk to an older Electron core.
      if (method === 'merge' && plan.method !== 'merge')
        throw new Error('本机核心尚不支持合并拉取，请重启开发服务或桌面应用。')
      if (
        plan.kind !== kind ||
        (selected &&
          (plan.sourceRef !== (selected.fullRef || `refs/heads/${selected.name}`) ||
            plan.head !== selected.hash ||
            plan.branch !== selected.name))
      )
        throw new Error('同步计划与所选分支不一致，请重启桌面应用后重新确认。')
      syncPreview.value = plan
    } catch (error) {
      if (attempt === syncAttempt) {
        const message = (error as Error).message
        syncError.value =
          kind === 'push' && /尚无明确上游/.test(message)
            ? `分支 ${selected?.name || repo.value.branch} 尚未关联远端分支，无法确定推送目标。请先设置推送目标。`
            : message
      }
    } finally {
      await finishOperation()
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
    return run(syncPreview.value.kind, { planId: syncPreview.value.id }, syncIntent)
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

  async function run(
    action: string,
    extra: Record<string, unknown> = {},
    intent = captureOperation(),
  ) {
    if (isNewTab.value) {
      modal.value = 'open'
      return false
    }
    if (busy.value) return false
    if (['commit', 'commit-selected'].includes(action) && commitContextBlocked.value) {
      notify(commitContextBlocked.value, true)
      return false
    }
    if (!sameContext(intent)) {
      notify('仓库上下文已变化，请重新确认操作。', true)
      return false
    }
    busy.value = true
    activeOperation.value = action
    lastActionResult.value = null
    const isSync = ['fetch', 'pull', 'push'].includes(action)
    const wasSyncModal = modal.value === 'push' || modal.value === 'pull'
    const operationModal = modal.value
    const startedAt = cancellationEpoch
    try {
      const request = {
        expectedHead: intent.expectedHead,
        expectedBranch: intent.expectedBranch,
        ...extra,
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
      lastActionResult.value = result
      if (!sameContext(intent)) return false
      if (result.snapshot) await applySnapshot(result.snapshot)
      if (action === 'checkout' && result.checkoutProtection) {
        checkoutProtection.value = { ...result.checkoutProtection, intent }
        modal.value = 'checkout-protected'
      }
      const outcome = result.outcome || 'succeeded'
      if (['commit', 'commit-selected'].includes(action) && outcome === 'succeeded') {
        commitMessage.value = ''
        commitDescription.value = ''
      }
      if (
        (['checkout', 'stash-checkout', 'branch'].includes(action) || extra.switchAfter) &&
        outcome === 'succeeded'
      )
        clearSelection()
      if (
        (['checkout', 'stash-checkout', 'branch', 'rename-branch', 'delete-branch'].includes(
          action,
        ) ||
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
        'stash-create': '修改已贮藏，提交说明草稿保留',
        'stash-apply': '贮藏已恢复，记录保留',
        'stash-pop': '贮藏已恢复并移除',
        'stash-drop': '贮藏已删除',
        stage: '文件已暂存',
        unstage: '已取消暂存',
        commit: '提交成功',
        branch: '分支已创建并切换',
        checkout: '已切换分支',
        fetch: '远程分支已获取（不含标签，不清理引用）',
        pull: '拉取已完成（仅快进）',
        push: '指定分支已推送',
        'create-branch': extra.switchAfter ? '分支创建操作已完成，请检查当前分支' : '分支已创建',
        'track-branch': '本地跟踪分支已创建',
        'rename-branch': '分支已重命名',
        'delete-branch': '本地分支已删除',
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
        notify(`${outcome === 'partial' ? '操作已部分完成。' : ''}${result.error}`, true)
        if (wasSyncModal) syncError.value = result.error
      }
      if (result.warning && !(action === 'pull' && result.snapshot?.merge?.active))
        notify(result.warning, true)
      if (result.cleanupError)
        notify(`操作临时引用清理失败：${result.cleanupError}，请检查仓库。`, true)
      if (result.refreshError)
        notify(
          `操作结果：${{ succeeded: '已完成', failed: '未正常完成', partial: '部分完成', cancelled: '已取消' }[outcome]}；状态刷新失败：${result.refreshError}。请刷新确认，不要重复执行。`,
          true,
        )
      if (!result.error && !result.warning)
        notify(
          action === 'commit-selected'
            ? '所选文件已提交'
            : messages[action] || result.output || '操作完成',
        )
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
    cancelling.value = false
  }

  async function cancelOperation() {
    if (!busy.value || cancelling.value) return
    cancellationEpoch++
    const preparing =
      (modal.value === 'push' || modal.value === 'pull') &&
      ['prepare-sync', 'refresh'].includes(activeOperation.value)
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
    checkoutProtection,
    mergeDraftTabs,
    pullMethod,
    setPullMethod,
    fetchBeforePull,
    draftTabs,
    operationLabel,
    captureOperation,
    prepareSync,
    retrySync,
    confirmSync,
    prepareSelectedCommit,
    commitSelected,
    syncTarget,
    syncPreview,
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
    pendingBranch,
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
