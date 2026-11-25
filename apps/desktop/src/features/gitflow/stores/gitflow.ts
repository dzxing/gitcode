import { flowTypes, flowKind } from '../rules'
import { parseJsonObject } from '../../../infrastructure/json'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useGitFlowFinishStore } from './gitflowFinish'
import { desktop } from '../../../infrastructure/desktop'
import type {
  ActionResult,
  GitFlowConfig,
  GitFlowInitPlan,
  GitFlowType,
} from '../../../shared/contracts'
import { flowConfigError, flowNameError } from '../gitflowValidation'
import { flowConfigKeys, mergeFlowConfig, readFlowConfig } from '../gitflowDraft'

type Panel = 'overview' | 'settings' | 'start' | 'finish'
type FlowAction = 'gitflow-save' | 'gitflow-init' | 'gitflow-start'

export const useGitFlowStore = defineStore('gitflow', () => {
  const repo = useRepositoryStore()
  const finishStore = useGitFlowFinishStore()
  const defaults: GitFlowConfig = {
    production: 'main',
    develop: 'develop',
    feature: 'feature/',
    release: 'release/',
    hotfix: 'hotfix/',
    versionTag: '',
  }
  const panel = computed<Panel | null>({
    get: () => repo.gitflowPanel,
    set: (value) => {
      repo.gitflowPanel = value
    },
  })
  const settingsTarget = ref<'rules' | 'initialization'>('rules'),
    settingsFocusRequest = ref(0)
  const config = ref<GitFlowConfig>({ ...defaults }),
    configBase = ref<GitFlowConfig>({ ...defaults })
  const configConflicts = ref<(keyof GitFlowConfig)[]>([]),
    legacyConfig = ref<GitFlowConfig | null>(null)
  const restartNotice = ref(false)
  const type = ref<GitFlowType>('feature'),
    name = ref(''),
    switchAfter = ref(true)
  const sourceChoices = ref<Record<string, string>>(Object.create(null) as Record<string, string>),
    capturedOids = ref<Record<string, string>>({})
  const finishName = ref(''),
    search = ref(''),
    signature = ref(''),
    sourceOid = ref('')
  const capturedHead = ref(''),
    capturedBranch = ref('')
  const plan = ref<GitFlowInitPlan | null>(null),
    error = ref(''),
    planExpired = ref(false)
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const result = ref<ActionResult | null>(null),
    resultAction = ref<FlowAction | null>(null)
  const resultFocusRequest = ref(0)
  const uncertainPaths = ref(new Set<string>())
  const requiresRecheck = computed({
    get: () => uncertainPaths.value.has(repo.repo.path),
    set: (value: boolean) => {
      if (value) uncertainPaths.value.add(repo.repo.path)
      else uncertainPaths.value.delete(repo.repo.path)
    },
  })
  const draftWarning = ref(''),
    draftRestored = ref(false)
  let intent: ReturnType<typeof repo.captureOperation> | null = null
  let loadingDraft = false
  const state = computed(() => repo.repo.gitflow)
  const localBranches = computed(() => repo.repo.branches.filter((b) => b.kind === 'local'))
  const remoteBases = computed(() => state.value?.remoteBases || [])
  const remoteSourcesFor = (name: string) =>
    remoteBases.value.filter((source) => source.remoteRef === `refs/heads/${name}`)
  function suggestRemoteSources() {
    if (panel.value !== 'settings') return
    for (const name of missing.value) {
      const sources = remoteSourcesFor(name)
      if (!sourceChoices.value[name] && sources.length === 1)
        sourceChoices.value[name] = sources[0].fullRef
    }
  }
  const candidates = computed(() =>
    localBranches.value.filter(
      (b) =>
        state.value?.ready &&
        flowTypes.includes(flowKind(state.value.config, b.name) as GitFlowType),
    ),
  )
  const sourceName = computed(() =>
    type.value === 'hotfix' ? state.value?.config.production : state.value?.config.develop,
  )
  const fullName = computed(
    () => (state.value?.config[type.value] || config.value[type.value]) + name.value,
  )
  const missing = computed(() =>
    [...new Set([config.value.production, config.value.develop])].filter(
      (n) => !localBranches.value.some((b) => b.name === n),
    ),
  )
  watch([missing, remoteBases, panel], suggestRemoteSources, { flush: 'sync' })
  const sameConfig = (a: GitFlowConfig, b?: GitFlowConfig) =>
    !!b && flowConfigKeys.every((key) => a[key] === b[key])
  const dirtyConfig = computed(() => !sameConfig(config.value, state.value?.config))
  const configError = computed(() => flowConfigError(config.value))
  const stale = computed(
    () =>
      capturedHead.value !== repo.repo.head ||
      capturedBranch.value !== repo.repo.branch ||
      (!!state.value && signature.value !== state.value.signature) ||
      (panel.value === 'start' &&
        sourceOid.value !==
          (localBranches.value.find((b) => b.name === sourceName.value)?.hash || '')) ||
      (!!plan.value &&
        (plan.value.references?.some(
          (ref) =>
            !repo.repo.branches.some(
              (b) =>
                (b.fullRef || `refs/${b.kind === 'remote' ? 'remotes' : 'heads'}/${b.name}`) ===
                  ref.fullRef && b.hash === ref.oid,
            ),
        ) ||
          plan.value.creates.some((item) =>
            localBranches.value.some((b) => b.name === item.name),
          ))),
  )
  const accessBlocked = computed(() =>
    repo.isNewTab || !state.value
      ? '请先打开并读取本地仓库。'
      : !repo.connected
        ? '本地 Git 服务未连接，请先连接并核对仓库状态。'
        : !repo.repoGitAvailable
          ? '本机 Git 不可用，请安装或升级 Git 后重新连接。'
          : repo.busy
            ? 'Git 操作正在执行，请等待完成。'
            : repo.fetching
              ? '远端分支正在获取，请等待完成后再操作。'
              : repo.modal
                ? '请先关闭当前弹窗。'
                : '',
  )
  const readinessBlocked = computed(
    () =>
      accessBlocked.value ||
      (requiresRecheck.value ? '上次操作需要核实，请先刷新核对。' : '') ||
      state.value?.error ||
      (!state.value?.configured
        ? '请先配置并保存 GitFlow 规则。'
        : !state.value.ready
          ? `本地缺少基础分支：${state.value.missing.join('、') || '请检查规则'}。请获取远端状态，并前往设置补齐本地分支。`
          : ''),
  )
  // Entry gates deliberately exclude form fields and the worktree's dirty state.
  const startEntryBlocked = computed(
    () =>
      readinessBlocked.value ||
      (state.value?.finish ? '请先继续或停止当前 GitFlow 完成流程。' : ''),
  )
  const finishEntryBlocked = computed(
    () =>
      readinessBlocked.value ||
      (state.value?.finish ? '请先继续或停止当前 GitFlow 完成流程。' : '') ||
      (!candidates.value.length ? '暂无可完成的 GitFlow 分支。' : ''),
  )
  const baseBlocked = computed(
    () =>
      accessBlocked.value ||
      (requiresRecheck.value ? '上次操作需要核实，请先刷新核对。' : '') ||
      (stale.value ? '仓库状态已变化，请先刷新核对。' : ''),
  )
  const writable = computed(() => !baseBlocked.value)
  const namespaceCollision = (name: string) =>
    localBranches.value.find((b) => b.name.startsWith(name + '/') || name.startsWith(b.name + '/'))
  const conflictBlocked = computed(() =>
    configConflicts.value.length ? '配置草稿与仓库规则冲突，请先选择要保留的值。' : '',
  )
  const saveBlocked = computed(
    () =>
      (state.value?.finish ? '请先继续或停止当前 GitFlow 完成流程。' : '') ||
      baseBlocked.value ||
      conflictBlocked.value ||
      state.value?.writeError ||
      configError.value ||
      (state.value?.configured && !state.value.error && !dirtyConfig.value ? '规则没有变化。' : ''),
  )
  const previewBlocked = computed(
    () =>
      baseBlocked.value ||
      conflictBlocked.value ||
      state.value?.writeError ||
      configError.value ||
      state.value?.operationError ||
      (!repo.repo.head ? '仓库尚无提交，请先完成首次提交。' : '') ||
      (!missing.value.length ? '基础分支已存在，无需创建；如需更新规则，请直接保存。' : '') ||
      (missing.value.some(namespaceCollision)
        ? '基础分支名称与现有分支形成目录冲突，请修改规则。'
        : '') ||
      (missing.value.some((n) => {
        // Read the key even before it exists so Vue tracks the first selection.
        const selected = sourceChoices.value[n]
        return (
          !Object.hasOwn(sourceChoices.value, n) ||
          (!localBranches.value.some((b) => (b.fullRef || `refs/heads/${b.name}`) === selected) &&
            !remoteSourcesFor(n).some((source) => source.fullRef === selected))
        )
      })
        ? '请为缺失分支选择本地起点或远端同名分支；多个远端候选需明确选择。'
        : ''),
  )
  const confirmBlocked = computed(
    () =>
      previewBlocked.value ||
      (!plan.value
        ? '请先预览初始化。'
        : planExpired.value
          ? '初始化计划已过期，请重新预览。'
          : ''),
  )
  const startBlocked = computed(
    () =>
      baseBlocked.value ||
      readinessBlocked.value ||
      state.value?.operationError ||
      flowNameError(state.value?.config[type.value] || config.value[type.value], name.value) ||
      (localBranches.value.some((b) => b.name === fullName.value)
        ? '同名本地分支已存在，请修改名称或在侧栏查看该分支。'
        : namespaceCollision(fullName.value)
          ? '分支名称与现有分支形成目录冲突，请修改名称。'
          : !sourceOid.value
            ? '起点分支不可用，请刷新核对。'
            : ''),
  )
  const resultPanel = computed(() =>
    resultAction.value === 'gitflow-start' ? 'start' : 'settings',
  )
  const visibleResult = computed(() =>
    result.value && panel.value === resultPanel.value ? result.value : null,
  )
  function storageKey() {
    return `gitcode.gitflow-draft:${repo.repo.path}`
  }
  function capture() {
    intent = repo.captureOperation()
    signature.value = state.value?.signature || ''
    capturedHead.value = intent.expectedHead
    capturedBranch.value = intent.expectedBranch
    capturedOids.value = Object.fromEntries(localBranches.value.map((b) => [b.name, b.hash]))
    sourceOid.value = localBranches.value.find((b) => b.name === sourceName.value)?.hash || ''
  }
  function persist() {
    if (loadingDraft || !intent || intent.repo !== repo.repo.path) return
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          version: 2,
          baseConfig: configBase.value,
          config: config.value,
          conflicts: configConflicts.value,
          legacyConfig: legacyConfig.value,
          type: type.value,
          name: name.value,
          switchAfter: switchAfter.value,
        }),
      )
      draftWarning.value = ''
    } catch {
      draftWarning.value = '无法保存到本机存储，草稿仅在本次会话中保留。'
    }
  }
  function mergeLatest() {
    if (!state.value || !intent || intent.repo !== repo.repo.path) return
    const wasLoading = loadingDraft
    loadingDraft = true
    const merged = mergeFlowConfig(
      configBase.value,
      config.value,
      state.value.config,
      configConflicts.value,
    )
    config.value = merged.config
    configBase.value = { ...state.value.config }
    configConflicts.value = merged.conflicts
    loadingDraft = wasLoading
    if (!loadingDraft) persist()
  }
  function sessionData() {
    return {
      intent,
      config: config.value,
      base: configBase.value,
      conflicts: configConflicts.value,
      legacy: legacyConfig.value,
      type: type.value,
      name: name.value,
      switchAfter: switchAfter.value,
      capturedOids: capturedOids.value,
      head: capturedHead.value,
      branch: capturedBranch.value,
      signature: signature.value,
      result: result.value,
      resultAction: resultAction.value,
      error: error.value,
      restored: draftRestored.value,
      warning: draftWarning.value,
      restart: restartNotice.value,
    }
  }
  const sessions = new Map<string, ReturnType<typeof sessionData>>()
  function saveSession() {
    if (intent)
      sessions.set(
        intent.repo,
        JSON.parse(JSON.stringify(sessionData())) as ReturnType<typeof sessionData>,
      )
  }
  function open(
    mode: Panel = 'overview',
    branch?: string,
    target: 'rules' | 'initialization' = 'rules',
  ) {
    if (mode === 'finish') {
      if (finishEntryBlocked.value) {
        error.value = finishEntryBlocked.value
        panel.value = panel.value || 'overview'
        return
      }
      finishStore.open(branch)
      return
    }
    if (repo.isNewTab || repo.busy || repo.modal) return
    if (!panel.value && intent?.repo === repo.repo.path)
      draftRestored.value = !!name.value || dirtyConfig.value || !!legacyConfig.value
    if (intent?.repo !== repo.repo.path) {
      loadingDraft = true
      const session = sessions.get(repo.repo.path)
      if (session?.intent) {
        intent = { ...session.intent, tabId: repo.activeTabId }
        config.value = session.config
        configBase.value = session.base
        configConflicts.value = session.conflicts
        legacyConfig.value = session.legacy
        type.value = session.type
        name.value = session.name
        switchAfter.value = session.switchAfter
        capturedOids.value = session.capturedOids
        capturedHead.value = session.head
        capturedBranch.value = session.branch
        signature.value = session.signature
        sourceOid.value = capturedOids.value[sourceName.value || ''] || ''
        result.value = session.result
        resultAction.value = session.resultAction
        error.value = session.error
        draftRestored.value = session.restored
        draftWarning.value = session.warning
        restartNotice.value = session.restart
        mergeLatest()
      } else {
        const initial = {
          ...(state.value?.config || {
            ...defaults,
            production:
              localBranches.value.some((b) => b.name === 'master') &&
              !localBranches.value.some((b) => b.name === 'main')
                ? 'master'
                : 'main',
          }),
        }
        config.value = initial
        configBase.value = { ...initial }
        configConflicts.value = []
        legacyConfig.value = null
        name.value = ''
        type.value = 'feature'
        switchAfter.value = true
        draftRestored.value = false
        draftWarning.value = ''
        result.value = null
        resultAction.value = null
        error.value = ''
        restartNotice.value = false
        capture()
        try {
          const raw = localStorage.getItem(storageKey()),
            draft = raw ? parseJsonObject(raw) : null
          if (draft) {
            type.value = flowTypes.find((type) => type === draft.type) || 'feature'
            name.value = typeof draft.name === 'string' ? draft.name.slice(0, 200) : ''
            switchAfter.value = draft.switchAfter !== false
            const saved = readFlowConfig(draft.config),
              base = readFlowConfig(draft.baseConfig)
            if (draft.version === 2 && saved && base) {
              config.value = saved
              configBase.value = base
              const conflicts: unknown[] = Array.isArray(draft.conflicts) ? draft.conflicts : []
              configConflicts.value = conflicts.filter((key): key is keyof GitFlowConfig =>
                flowConfigKeys.some((field) => field === key),
              )
              legacyConfig.value = readFlowConfig(draft.legacyConfig)
              mergeLatest()
            } else if (saved && !sameConfig(saved, state.value?.config)) legacyConfig.value = saved
            draftRestored.value = !!name.value || dirtyConfig.value || !!legacyConfig.value
            restartNotice.value = draftRestored.value
          }
        } catch {
          /* Invalid optional storage never authorizes a write. */
        }
        // Persistent drafts contain no executable token or prior Git context.
        capture()
      }
      sourceChoices.value = Object.create(null) as Record<string, string>
      plan.value = null
      loadingDraft = false
    }
    const viewingResult = !!result.value && mode === resultPanel.value
    if (!viewingResult && mode === 'start' && startEntryBlocked.value) {
      error.value = startEntryBlocked.value
      panel.value = panel.value || 'overview'
      return
    }
    panel.value = mode
    if (mode === 'settings') suggestRemoteSources()
    if (mode === 'settings') {
      settingsTarget.value = target
      settingsFocusRequest.value++
    }
    if (mode !== 'settings') plan.value = null
  }
  function acknowledgeFinish(receipt: ActionResult) {
    const snapshot = receipt.snapshot
    if (
      !snapshot ||
      receipt.outcome !== 'succeeded' ||
      receipt.refreshError ||
      intent?.repo !== repo.repo.path ||
      snapshot.path !== repo.repo.path ||
      snapshot.head !== repo.repo.head ||
      snapshot.branch !== repo.repo.branch ||
      name.value.trim() ||
      dirtyConfig.value ||
      legacyConfig.value ||
      configConflicts.value.length ||
      requiresRecheck.value ||
      snapshot.gitflow?.finish
    )
      return
    // Only an acknowledged result of our own completed Finish renews an empty
    // Start form. Navigation and external changes still require explicit reread.
    result.value = null
    resultAction.value = null
    plan.value = null
    error.value = ''
    capture()
    persist()
    saveSession()
  }
  watch(
    () => finishStore.completedReceipt,
    (receipt) => {
      if (receipt) acknowledgeFinish(receipt)
    },
    { flush: 'sync' },
  )
  function openInitialization() {
    open('settings', undefined, 'initialization')
  }
  function close() {
    persist()
    saveSession()
    plan.value = null
    panel.value = null
  }
  async function recheck() {
    if (repo.busy || repo.modal) return
    error.value = ''
    plan.value = null
    if (!repo.connected) {
      await repo.init()
      if (!repo.connected) {
        error.value = '本地 Git 服务未连接，请检查连接后重试。'
        return
      }
    }
    if (await repo.refresh()) {
      mergeLatest()
      capture()
      requiresRecheck.value = false
      restartNotice.value = false
    } else error.value = '未能重新读取仓库状态，请检查连接后再刷新。'
  }
  async function fetchRemoteBases() {
    if (repo.busy || repo.fetching || repo.modal || !intent) return
    const original = repo.captureOperation()
    error.value = ''
    plan.value = null
    const success = await repo.run('fetch', {}, original)
    if (repo.repo.path !== original.repo || repo.activeTabId !== original.tabId) return
    if (!success) {
      error.value = '未能完整获取远端分支，不能据此认定服务器不存在基础分支。请检查操作结果后重试。'
      return
    }
    await recheck()
    suggestRemoteSources()
  }
  async function previewInit() {
    if (previewBlocked.value || !intent) {
      error.value = previewBlocked.value
      return
    }
    error.value = ''
    plan.value = null
    const original = intent
    repo.busy = true
    repo.activeOperation = 'gitflow-preview'
    try {
      plan.value = await desktop.gitflowPlan(original.repo, {
        ...original,
        config: { ...config.value },
        signature: signature.value,
        sources: { ...sourceChoices.value },
      })
    } catch (failure) {
      error.value = (failure as Error).message
    } finally {
      repo.busy = false
      repo.activeOperation = ''
    }
  }
  async function execute(action: FlowAction) {
    if (action === 'gitflow-init' && plan.value && plan.value.expiresAt <= Date.now())
      planExpired.value = true
    const blocked =
      action === 'gitflow-save'
        ? saveBlocked.value
        : action === 'gitflow-init'
          ? confirmBlocked.value
          : startBlocked.value
    if (blocked || !intent) {
      error.value = blocked || '请重新打开 GitFlow 面板。'
      return false
    }
    const extra =
      action === 'gitflow-save'
        ? { signature: signature.value, config: { ...config.value } }
        : action === 'gitflow-init'
          ? { planId: plan.value?.id }
          : {
              signature: signature.value,
              type: type.value,
              name: name.value,
              sourceOid: sourceOid.value,
              switchAfter: switchAfter.value,
            }
    error.value = ''
    const ok = await repo.run(action, extra, intent)
    result.value = repo.lastActionResult
    resultAction.value = action
    requiresRecheck.value = !ok || !!result.value?.refreshError
    if (!ok)
      error.value =
        result.value?.error || result.value?.warning || '操作未完成，请刷新检查状态后重新核对。'
    plan.value = null
    if (ok) {
      if (action !== 'gitflow-start' && result.value?.snapshot?.gitflow) {
        config.value = { ...result.value.snapshot.gitflow.config }
        configBase.value = { ...config.value }
        configConflicts.value = []
        legacyConfig.value = null
      } else if (action === 'gitflow-start') {
        name.value = ''
        if (switchAfter.value) repo.clearSelection()
      }
      capture()
      persist()
      draftRestored.value = false
      restartNotice.value = false
    }
    if (result.value) resultFocusRequest.value++
    saveSession()
    return ok
  }
  function resetConfig() {
    if (repo.busy || !state.value) return
    loadingDraft = true
    config.value = { ...state.value.config }
    configBase.value = { ...config.value }
    configConflicts.value = []
    legacyConfig.value = null
    sourceChoices.value = Object.create(null) as Record<string, string>
    loadingDraft = false
    persist()
  }
  function resetDraft() {
    if (repo.busy) return
    resetConfig()
    name.value = ''
    plan.value = null
    draftRestored.value = false
    restartNotice.value = false
    persist()
  }
  function resolveConflict(key: keyof GitFlowConfig, choice: 'repository' | 'draft') {
    if (repo.busy || !state.value || !configConflicts.value.includes(key)) return
    loadingDraft = true
    configBase.value[key] = state.value.config[key]
    if (choice === 'repository') config.value[key] = state.value.config[key]
    configConflicts.value = configConflicts.value.filter((item) => item !== key)
    loadingDraft = false
    persist()
  }
  function resolveLegacy(keep: boolean) {
    if (repo.busy || !state.value || !legacyConfig.value) return
    loadingDraft = true
    if (keep) {
      config.value = { ...legacyConfig.value }
      configBase.value = { ...state.value.config }
      configConflicts.value = []
    }
    legacyConfig.value = null
    loadingDraft = false
    persist()
  }
  watch(
    [config, name, type, switchAfter],
    () => {
      if (!loadingDraft)
        configConflicts.value = configConflicts.value.filter(
          (key) => config.value[key] !== configBase.value[key],
        )
      persist()
    },
    { deep: true, flush: 'sync' },
  )
  watch(
    [config, sourceChoices],
    () => {
      plan.value = null
    },
    { deep: true, flush: 'sync' },
  )
  watch(
    type,
    () => {
      sourceOid.value = capturedOids.value[sourceName.value || ''] || ''
    },
    { flush: 'sync' },
  )
  watch(
    () => state.value,
    () => mergeLatest(),
    { deep: true, flush: 'sync' },
  )
  watch(
    plan,
    (value) => {
      clearTimeout(expiryTimer)
      planExpired.value = !!value && value.expiresAt <= Date.now()
      if (value && !planExpired.value) {
        expiryTimer = setTimeout(() => {
          planExpired.value = true
        }, value.expiresAt - Date.now())
        ;(expiryTimer as unknown as { unref?: () => void }).unref?.()
      }
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => clearTimeout(expiryTimer))
  watch(
    () => repo.connected,
    (connected) => {
      if (!connected && state.value) {
        requiresRecheck.value = true
        plan.value = null
      }
    },
    { flush: 'sync' },
  )
  watch(
    () => repo.activeTabId,
    () => {
      saveSession()
      panel.value = null
      intent = null
      plan.value = null
      result.value = null
      resultAction.value = null
      error.value = ''
    },
    { flush: 'sync' },
  )
  return {
    panel,
    settingsTarget,
    settingsFocusRequest,
    resultFocusRequest,
    config,
    configBase,
    configConflicts,
    legacyConfig,
    restartNotice,
    type,
    name,
    switchAfter,
    sourceChoices,
    finishName,
    search,
    signature,
    sourceOid,
    capturedHead,
    capturedBranch,
    plan,
    error,
    result,
    resultAction,
    resultPanel,
    visibleResult,
    requiresRecheck,
    draftWarning,
    draftRestored,
    state,
    localBranches,
    remoteSourcesFor,
    fetchRemoteBases,
    candidates,
    sourceName,
    fullName,
    missing,
    dirtyConfig,
    writable,
    configError,
    stale,
    accessBlocked,
    startEntryBlocked,
    finishEntryBlocked,
    saveBlocked,
    previewBlocked,
    confirmBlocked,
    planExpired,
    startBlocked,
    open,
    openInitialization,
    acknowledgeFinish,
    close,
    recheck,
    previewInit,
    execute,
    resetDraft,
    resetConfig,
    resolveConflict,
    resolveLegacy,
  }
})
