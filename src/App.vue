<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from './stores/repository'
import Sidebar from './components/Sidebar.vue'
import CommitHistory from './components/CommitHistory.vue'
import Inspector from './components/Inspector.vue'
import Dialogs from './components/Dialogs.vue'
import RepositoryDialog from './components/RepositoryDialog.vue'
import RecoveryPanel from './components/RecoveryPanel.vue'
import OperationFeedback from './components/OperationFeedback.vue'
import ActivityLog from './components/ActivityLog.vue'
import StartupScreen from './components/StartupScreen.vue'
import RepositoryTrustDialog from './components/RepositoryTrustDialog.vue'
import Icon from './components/Icon.vue'
import AppBrand from './components/AppBrand.vue'
import NewTab from './components/NewTab.vue'
import WindowControls from './components/WindowControls.vue'
import ContextMenu from './components/ContextMenu.vue'
import CommitActionsDialog from './components/CommitActionsDialog.vue'
import NavigationDialog from './components/NavigationDialog.vue'
import ApplicationMenu from './components/ApplicationMenu.vue'
import GitFlowPanel from './components/GitFlowPanel.vue'
import ProtectedCheckoutDialog from './components/ProtectedCheckoutDialog.vue'
import GitFlowFinishDialog from './components/GitFlowFinishDialog.vue'
import GitFlowFinishStatus from './components/GitFlowFinishStatus.vue'
import MergeStatus from './components/MergeStatus.vue'
import MergeEditor from './components/MergeEditor.vue'
import { useMergeStore } from './stores/merge'
import RebasePanel from './components/RebasePanel.vue'
import { useRebaseStore } from './stores/rebase'
import StashToolbar from './components/StashToolbar.vue'
import StashDeleteDialog from './components/StashDeleteDialog.vue'
import { useContextMenuStore } from './stores/contextMenu'
import { useGitFlowStore } from './stores/gitflow'
import { useDesktopWindow } from './composables/useDesktopWindow'
import { isDesktop } from './services/desktop'
import { branchTracking } from './branchTracking'
import { fetchFailureSummary } from './activityLogPresentation'
import WorkbenchMenu, { type WorkbenchMenuItem } from './components/WorkbenchMenu.vue'
import { applicationBridge } from './services/application'

const store = useRepositoryStore()
const applicationMenu = ref<InstanceType<typeof ApplicationMenu>>()
const rebase = useRebaseStore()
const merge = useMergeStore()
const mergeEditing = computed(() => merge.session.editor && !!merge.session.file)
const chrome = useDesktopWindow()
const contextMenu = useContextMenuStore()
const flow = useGitFlowStore()
watch(
  () => merge.panelRequest,
  () => {
    if (merge.panelVisible && flow.panel) flow.close()
  },
)
const history = ref<{ focusSearch(): void }>()
const sidebar = ref<{ focusFilter(): void }>()
const inspector = ref<{ submit(): Promise<void> }>()
const panelWidthsKey = 'gitcode.panel-widths'
const savedPanelWidths: { sidebar?: number; inspector?: number } = {}
try {
  const saved: unknown = JSON.parse(localStorage.getItem(panelWidthsKey) || 'null')
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const values = saved as Record<string, unknown>
    if (typeof values.sidebar === 'number' && Number.isFinite(values.sidebar))
      savedPanelWidths.sidebar = Math.max(190, Math.min(330, values.sidebar))
    if (typeof values.inspector === 'number' && Number.isFinite(values.inspector))
      savedPanelWidths.inspector = Math.max(290, Math.min(540, values.inspector))
  }
} catch {
  /* Width preferences are optional. */
}
const sidebarWidth = ref(savedPanelWidths.sidebar ?? 250)
const inspectorWidth = ref(savedPanelWidths.inspector ?? 330)
const narrowPanels = ref(false)
const dragging = ref(false)
const branchMenu = ref<HTMLDetailsElement>()
const syncOptions = ref<HTMLDetailsElement>()
const branchTrigger = ref<HTMLElement>()
const branchFilterInput = ref<HTMLInputElement>()
const branchDropdown = ref<HTMLElement>()
const branchQuery = ref('')
let branchReturnFocus: HTMLElement | null = null
const branchChoices = computed(() =>
  store.repo.branches.filter(
    (branch) =>
      branch.kind === 'local' &&
      branch.name.toLocaleLowerCase().includes(branchQuery.value.trim().toLocaleLowerCase()),
  ),
)
const appBridge = applicationBridge()
const workbenchMenu = ref<{
  kind: 'tab' | 'path'
  tabId?: number
  repo: string
  x: number
  y: number
  trigger: HTMLElement | null
} | null>(null)
const workbenchItems = computed<WorkbenchMenuItem[]>(() => {
  const target = workbenchMenu.value
  if (!target) return []
  if (target.kind === 'path')
    return [
      { id: 'copy-path', label: '复制仓库路径' },
      {
        id: 'show-folder',
        label: '在文件管理器中显示',
        disabled: typeof appBridge?.repositoryLocation !== 'function',
        hint:
          typeof appBridge?.repositoryLocation !== 'function'
            ? '请在桌面应用中使用文件管理器'
            : undefined,
      },
    ]
  const index = store.tabs.findIndex((tab) => tab.id === target.tabId)
  return [
    { id: 'close-tab', label: '关闭标签', disabled: index < 0 },
    { id: 'close-others', label: '关闭其他标签', disabled: index < 0 || store.tabs.length < 2 },
    {
      id: 'close-right',
      label: '关闭右侧标签',
      disabled: index < 0 || index === store.tabs.length - 1,
    },
  ]
})
const currentTracking = computed(() => branchTracking(store.repo.branches.find((b) => b.current)))
const coreLabel = computed(() =>
  store.runtime?.transport === 'local'
    ? store.runtime.environment === 'wsl'
      ? 'WSL Git 服务'
      : '本地 Git 服务'
    : '本地 Git 服务',
)
const connectionStatus = computed(() =>
  store.starting
    ? store.startupPhase === 'core'
      ? '正在连接本地 Git 服务…'
      : '正在恢复仓库工作区…'
    : store.isWorking
      ? store.cancelling || store.fetchCancelling
        ? '正在取消操作并核对结果…'
        : `正在${store.busy ? store.operationLabel : '获取远程分支'}…`
      : store.connecting
        ? '正在连接本地 Git 服务…'
        : store.connected
          ? `${coreLabel.value}已连接 · ${store.runtime?.gitAvailable ? store.runtime.gitVersion : '未找到 Git'}`
          : '本地 Git 服务未连接',
)
function beforeUnload(event: BeforeUnloadEvent) {
  if (!isDesktop() && (store.isWorking || store.draftTabs.length)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function closeBranchMenu(restoreFocus = false) {
  if (!branchMenu.value?.open) return
  const target = branchReturnFocus || branchTrigger.value
  branchMenu.value.open = false
  branchReturnFocus = null
  if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true })
}
async function openBranchPicker(event?: Event) {
  if (store.blocksTabs || rebase.active || store.modal || !branchMenu.value) return
  branchReturnFocus =
    event?.currentTarget instanceof HTMLElement ? event.currentTarget : branchTrigger.value || null
  branchQuery.value = ''
  branchMenu.value.open = true
  await nextTick()
  if (!branchMenu.value?.open) return
  branchDropdown.value?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  branchFilterInput.value?.focus({ preventScroll: true })
}
function branchPickerKey(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  const input = event.target === branchFilterInput.value
  if (input && event.key === 'Enter') {
    event.preventDefault()
    if (branchChoices.value[0]) void chooseBranch(branchChoices.value[0].name)
    return
  }
  if (
    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
    (input && ['Home', 'End'].includes(event.key))
  )
    return
  event.preventDefault()
  const buttons = Array.from(
    branchDropdown.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
  )
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : index < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  buttons[next]?.focus({ preventScroll: true })
  buttons[next]?.scrollIntoView({ block: 'nearest' })
}
function closeWorkbenchMenu(restore = false) {
  const target = workbenchMenu.value
  workbenchMenu.value = null
  if (restore)
    void nextTick(() => {
      if (target?.trigger?.isConnected) target.trigger.focus({ preventScroll: true })
    })
}
function openWorkbenchMenu(
  event: MouseEvent | KeyboardEvent,
  kind: 'tab' | 'path',
  tabId?: number,
) {
  if (event instanceof KeyboardEvent && !['ContextMenu', 'F10'].includes(event.key)) return
  if (event instanceof KeyboardEvent && event.key === 'F10' && !event.shiftKey) return
  if (store.blocksTabs || rebase.active || store.modal || document.querySelector('dialog[open]'))
    return
  event.preventDefault()
  event.stopPropagation()
  const element = event.currentTarget as HTMLElement
  const bounds = element.getBoundingClientRect()
  contextMenu.close(false)
  dismissToolMenus()
  workbenchMenu.value = {
    kind,
    tabId,
    repo: store.repo.path,
    x: event instanceof MouseEvent ? event.clientX : bounds.left,
    y: event instanceof MouseEvent ? event.clientY : bounds.bottom,
    trigger: kind === 'tab' ? element.querySelector('.tab-select') : element,
  }
}
async function repositoryLocation(action: 'copy-path' | 'show-folder', repo = store.repo.path) {
  if (store.isNewTab || !repo) return
  try {
    if (appBridge?.repositoryLocation) await appBridge.repositoryLocation(repo, action)
    else if (action === 'copy-path') await navigator.clipboard.writeText(repo)
    else throw new Error('此入口需要桌面应用。')
    if (action === 'copy-path' && store.repo.path === repo) store.notify('仓库路径已复制')
  } catch (error) {
    store.notify((error as Error).message, true)
  }
}
function selectWorkbenchItem(id: string) {
  const target = workbenchMenu.value
  closeWorkbenchMenu()
  if (!target || store.blocksTabs || rebase.active) return
  if (target.kind === 'path') {
    if (target.repo === store.repo.path && (id === 'copy-path' || id === 'show-folder'))
      void repositoryLocation(id, target.repo)
    return
  }
  const index = store.tabs.findIndex((tab) => tab.id === target.tabId)
  if (index < 0) return
  const ids =
    id === 'close-tab'
      ? [target.tabId!]
      : id === 'close-others'
        ? store.tabs.filter((tab) => tab.id !== target.tabId).map((tab) => tab.id)
        : id === 'close-right'
          ? store.tabs.slice(index + 1).map((tab) => tab.id)
          : []
  store.closeTabs(ids)
  void nextTick(() =>
    document
      .querySelector<HTMLButtonElement>('.repo-tab.active .tab-select')
      ?.focus({ preventScroll: true }),
  )
}
function closeSyncOptions(restoreFocus = false) {
  if (!syncOptions.value?.open) return
  syncOptions.value.open = false
  if (restoreFocus) syncOptions.value.querySelector('summary')?.focus({ preventScroll: true })
}
function dismissToolMenus() {
  closeBranchMenu()
  closeSyncOptions()
  closeWorkbenchMenu()
}
function dismissBranchMenu(event: Event) {
  if (event.target instanceof Node && !syncOptions.value?.contains(event.target)) closeSyncOptions()
  // Context menus and modal confirmations may temporarily take focus from this popup.
  if (
    document.querySelector('dialog[open]') ||
    (contextMenu.target &&
      (event.type === 'focusin' || (event.target as Element)?.closest?.('.context-menu')))
  )
    return
  if (branchMenu.value?.open && !branchMenu.value.contains(event.target as Node)) closeBranchMenu()
}
watch(() => [store.activeTabId, store.busy], dismissToolMenus)
watch(
  () => store.modal,
  (value) => {
    if (value) dismissToolMenus()
  },
)
let manualSidebar = savedPanelWidths.sidebar !== undefined
let manualInspector = savedPanelWidths.inspector !== undefined
let widthStorageWarning = false
function persistPanelWidths() {
  if (narrowPanels.value) return
  try {
    localStorage.setItem(
      panelWidthsKey,
      JSON.stringify({
        ...(manualSidebar ? { sidebar: sidebarWidth.value } : {}),
        ...(manualInspector ? { inspector: inspectorWidth.value } : {}),
      }),
    )
    widthStorageWarning = false
  } catch {
    if (!widthStorageWarning) store.notify('面板宽度仅在本次会话保留，无法写入本机存储。', true)
    widthStorageWarning = true
  }
}
function fitPanels() {
  store.updateViewport(window.innerWidth)
  narrowPanels.value = window.innerWidth <= 1000
  if (!manualSidebar) sidebarWidth.value = window.innerWidth >= 1600 ? 260 : 250
  if (!manualInspector) inspectorWidth.value = window.innerWidth >= 1600 ? 400 : 330
}
let endDrag: (() => void) | undefined
function resetView() {
  endDrag?.()
  manualSidebar = false
  manualInspector = false
  fitPanels()
  try {
    localStorage.removeItem(panelWidthsKey)
    widthStorageWarning = false
    store.notify('已恢复默认面板宽度')
  } catch {
    store.notify('已恢复默认宽度，但无法清除本机保存的宽度设置。', true)
  }
}

function resetPanel(side: 'left' | 'right') {
  if (narrowPanels.value) return
  endDrag?.()
  if (side === 'left') {
    manualSidebar = false
    sidebarWidth.value = window.innerWidth >= 1600 ? 260 : 250
  } else {
    manualInspector = false
    inspectorWidth.value = window.innerWidth >= 1600 ? 400 : 330
  }
  persistPanelWidths()
}
function resizeByKeyboard(side: 'left' | 'right', delta: number) {
  if (narrowPanels.value) return
  if (side === 'left') {
    manualSidebar = true
    sidebarWidth.value = Math.max(190, Math.min(330, sidebarWidth.value + delta))
  } else {
    manualInspector = true
    inspectorWidth.value = Math.max(290, Math.min(540, inspectorWidth.value + delta))
  }
  persistPanelWidths()
}

function resize(event: PointerEvent, side: 'left' | 'right') {
  if (event.button !== 0 || narrowPanels.value) return
  event.preventDefault()
  let changed = false
  const start = event.clientX
  const width = side === 'left' ? sidebarWidth.value : inspectorWidth.value
  dragging.value = true
  const move = (e: PointerEvent) => {
    if (narrowPanels.value) return
    const delta = e.clientX - start
    const next =
      side === 'left'
        ? Math.max(190, Math.min(330, width + delta))
        : Math.max(290, Math.min(540, width - delta))
    if (next === (side === 'left' ? sidebarWidth.value : inspectorWidth.value)) return
    changed = true
    if (side === 'left') {
      manualSidebar = true
      sidebarWidth.value = next
    } else {
      manualInspector = true
      inspectorWidth.value = next
    }
  }
  const end = () => {
    if (changed) persistPanelWidths()
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
    endDrag = undefined
  }
  endDrag = end
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
}

function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (store.starting || store.startupPhase === 'error') return
  if ((event.target as HTMLElement)?.closest?.('.gitflow-panel')) return
  const command = event.ctrlKey || event.metaKey
  if (
    contextMenu.target ||
    workbenchMenu.value ||
    store.modal ||
    document.querySelector('dialog[open]')
  )
    return
  if (event.ctrlKey && event.key === 'Tab') {
    event.preventDefault()
    const index = store.tabs.findIndex((tab) => tab.id === store.activeTabId)
    const tab =
      store.tabs[(index + (event.shiftKey ? -1 : 1) + store.tabs.length) % store.tabs.length]
    if (tab) store.activateTab(tab.id)
    return
  }
  if (event.ctrlKey && event.key === 'F4' && chrome.platform.value !== 'macos') {
    event.preventDefault()
    store.closeTab(store.activeTabId)
    return
  }
  if (
    event.key === '/' &&
    !command &&
    !event.altKey &&
    !event.isComposing &&
    !store.isNewTab &&
    !store.busy &&
    !rebase.active &&
    !(event.target as HTMLElement)?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    event.preventDefault()
    sidebar.value?.focusFilter()
    return
  }
  if (command && event.key === 'Enter') {
    event.preventDefault()
    void inspector.value?.submit()
  }
  if (event.key === 'Escape') {
    if (branchMenu.value?.open) {
      event.preventDefault()
      closeBranchMenu(true)
      return
    }
    store.closeDiff()
  }
  if (event.key === '?' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName))
    store.modal = 'help'
}

async function focusHistorySearch() {
  if (flow.panel) flow.close()
  await nextTick()
  history.value?.focusSearch()
}

function branchContext(event: MouseEvent | KeyboardEvent) {
  const branch = store.repo.branches.find((b) => b.kind === 'local' && b.current)
  contextMenu.open(event, branch ? { kind: 'branch', branch } : { kind: 'worktree' })
}
function branchContextKeyboard(event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) branchContext(event)
}

async function chooseBranch(name: string) {
  if (store.busy) return
  const targetFocus = branchReturnFocus || branchTrigger.value
  const intent = store.captureOperation()
  closeBranchMenu()
  if (name === store.repo.branch) {
    targetFocus?.focus({ preventScroll: true })
    return
  }
  const target = store.repo.branches.find(
    (branch) => branch.kind === 'local' && branch.name === name,
  )
  if (target) await store.checkoutBranch(target, intent)
  if (
    store.activeTabId === intent.tabId &&
    store.repo.path === intent.repo &&
    !document.querySelector('dialog[open]') &&
    document.activeElement === document.body &&
    targetFocus?.isConnected
  )
    targetFocus.focus({ preventScroll: true })
}
let stopAutomaticFetch = () => {}
let stopRepositoryObservation = () => {}
onMounted(() => {
  stopRepositoryObservation = store.startRepositoryObservation()
  stopAutomaticFetch = store.startAutomaticFetch()
  fitPanels()
  window.addEventListener('resize', fitPanels)
  void store.init()
  window.addEventListener('keydown', keydown)
  window.addEventListener('blur', dismissToolMenus)
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('pointerdown', dismissBranchMenu, true)
  document.addEventListener('focusin', dismissBranchMenu)
})
onUnmounted(() => {
  stopRepositoryObservation()
  stopAutomaticFetch()
  window.removeEventListener('resize', fitPanels)
  window.removeEventListener('keydown', keydown)
  window.removeEventListener('blur', dismissToolMenus)
  window.removeEventListener('beforeunload', beforeUnload)
  document.removeEventListener('pointerdown', dismissBranchMenu, true)
  document.removeEventListener('focusin', dismissBranchMenu)
  endDrag?.()
})
</script>

<template>
  <div
    class="app-shell"
    :class="{
      resizing: dragging,
      'native-shell': chrome.customFrame.value,
      'native-window-controls': chrome.nativeControls.value,
      'platform-macos': chrome.nativeWindow.value && chrome.platform.value === 'macos',
      'window-maximized': chrome.maximized.value,
      'window-unfocused': !chrome.focused.value,
    }"
    :style="{ '--sidebar-width': `${sidebarWidth}px`, '--inspector-width': `${inspectorWidth}px` }"
  >
    <header class="titlebar">
      <button
        class="brand"
        :disabled="store.blocksTabs || rebase.active"
        aria-label="GitCode 首页"
        @click="store.newTab()"
      >
        <AppBrand />
      </button>
      <ApplicationMenu
        ref="applicationMenu"
        :platform="chrome.platform.value"
        @search="focusHistorySearch"
        @reset-view="resetView"
      />
      <span class="titlebar-divider"></span>
      <nav
        class="workspace-tabs"
        aria-label="仓库标签"
      >
        <div
          v-for="tab in store.tabs"
          :key="tab.id"
          class="repo-tab"
          @pointerdown.middle.prevent
          @auxclick.middle.prevent="store.closeTab(tab.id)"
          @contextmenu="openWorkbenchMenu($event, 'tab', tab.id)"
          @keydown="openWorkbenchMenu($event, 'tab', tab.id)"
          :class="{ active: tab.id === store.activeTabId, 'new-page-tab': tab.kind === 'new' }"
        >
          <button
            class="tab-select"
            :disabled="store.blocksTabs || rebase.active"
            :aria-current="tab.id === store.activeTabId ? 'page' : undefined"
            :title="tab.path || '新标签页'"
            @click="store.activateTab(tab.id)"
          >
            <Icon
              :name="tab.kind === 'new' ? 'Plus' : 'FolderGit2'"
              :size="14"
            /><span>{{ tab.name }}</span></button
          ><button
            class="icon-button tab-close"
            :disabled="store.blocksTabs || rebase.active"
            :aria-label="`关闭标签 ${tab.name}`"
            title="关闭标签"
            @click="store.closeTab(tab.id)"
          >
            <Icon
              name="X"
              :size="12"
            />
          </button>
        </div>
      </nav>
      <button
        class="icon-button new-repo"
        :disabled="store.blocksTabs || rebase.active"
        title="新标签页 (Alt+T)"
        aria-label="新建标签页"
        @click="store.newTab()"
      >
        <Icon name="Plus" />
      </button>
      <div
        class="window-drag-space"
        aria-hidden="true"
      ></div>
      <div class="titlebar-right">
        <span class="local-badge"
          ><Icon
            name="Monitor"
            :size="12"
          />本地工作台</span
        ><button
          class="icon-button"
          title="快捷键与帮助"
          aria-label="快捷键与帮助"
          @click="store.modal = 'help'"
        >
          <Icon
            name="Keyboard"
            :size="17"
          />
        </button>
        <div
          class="profile"
          title="GitCode 本地工作台"
        >
          G
        </div>
      </div>
      <WindowControls
        v-if="chrome.customFrame.value"
        :maximized="chrome.maximized.value"
        @action="chrome.action"
      />
    </header>
    <StartupScreen @configure-git="applicationMenu?.openGitSettings()" />
    <NewTab
      v-if="store.isNewTab"
      :key="store.activeTabId"
      :inert="store.starting || store.startupPhase === 'error'"
    />
    <template v-else>
      <div
        class="toolbar"
        :inert="rebase.active || store.starting || store.startupPhase === 'error'"
      >
        <button
          class="repo-selector"
          :disabled="store.busy || rebase.active"
          aria-haspopup="dialog"
          :aria-label="`打开本地仓库，当前仓库 ${store.repo.name}`"
          :title="`打开本地仓库：${store.repo.path}`"
          @click="store.requestOpen()"
        >
          <span class="toolbar-folder"
            ><Icon
              name="FolderOpen"
              :size="19" /></span
          ><span
            ><small>当前仓库</small><strong>{{ store.repo.name }}</strong></span
          >
        </button>
        <span class="toolbar-divider"></span>
        <details
          ref="branchMenu"
          class="branch-selector"
          :inert="store.busy"
        >
          <summary
            ref="branchTrigger"
            :aria-label="`选择本地分支，当前 ${store.repo.branch}`"
            :aria-disabled="store.busy"
            :title="store.repo.branch"
            aria-haspopup="dialog"
            @click.prevent="branchMenu?.open ? closeBranchMenu(true) : openBranchPicker($event)"
            @keydown.down.prevent="openBranchPicker"
            @keydown.esc.stop.prevent="closeBranchMenu(true)"
            @contextmenu="branchContext"
            @keydown="branchContextKeyboard"
          >
            <Icon
              name="GitBranch"
              :size="18"
            /><span
              ><small>当前分支</small><strong>{{ store.repo.branch }}</strong></span
            ><span
              v-if="currentTracking.label"
              class="tracking"
              :title="currentTracking.description"
              >{{ currentTracking.label }}</span
            ><Icon
              name="ChevronDown"
              class="disclosure-chevron"
              :size="13"
            />
          </summary>
          <div
            ref="branchDropdown"
            class="branch-dropdown"
            role="dialog"
            aria-label="切换本地分支"
            @keydown="branchPickerKey"
            @keydown.esc.stop.prevent="closeBranchMenu(true)"
          >
            <small>切换本地分支</small>
            <label class="branch-picker-filter"
              ><Icon
                name="Search"
                :size="14" /><input
                ref="branchFilterInput"
                v-model="branchQuery"
                type="search"
                autocomplete="off"
                spellcheck="false"
                aria-label="筛选本地分支"
                placeholder="筛选本地分支…"
            /></label>
            <button
              v-for="branch in branchChoices"
              :key="branch.name"
              :title="branch.name"
              :aria-current="branch.current ? 'true' : undefined"
              :disabled="store.busy || rebase.active"
              @contextmenu="contextMenu.open($event, { kind: 'branch', branch })"
              @keydown="contextMenu.keyboard($event, { kind: 'branch', branch })"
              @click="chooseBranch(branch.name)"
            >
              <Icon
                name="GitBranch"
                :size="14"
              /><span>{{ branch.name }}</span
              ><Icon
                v-if="branch.current"
                name="Check"
                :size="14"
              />
            </button>
            <p v-if="!branchChoices.length">
              {{ branchQuery ? '没有匹配的本地分支' : '首次提交后即可创建分支' }}
            </p>
          </div>
        </details>
        <div class="toolbar-actions">
          <button
            :disabled="store.busy || store.fetching || rebase.active"
            :aria-describedby="store.isWorking ? 'operation-status' : undefined"
            :title="
              store.isWorking
                ? '请等待当前操作完成'
                : '获取远程更新并清理获取范围内的失效引用；分支范围可在“仓库 → 当前仓库设置”调整'
            "
            @click="store.run('fetch')"
          >
            <span class="toolbar-action-icon"
              ><Icon
                v-if="!store.fetching"
                name="Cloud"
                :size="19" /><Icon
                v-else
                name="LoaderCircle"
                :size="19"
                class="spin" /></span
            ><span>获取</span>
          </button>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="
              store.busy
                ? '请等待当前操作完成'
                : store.pullMethod === 'ff-only'
                  ? '拉取远程更新（仅快进）'
                  : '拉取远程更新（快进或合并）'
            "
            @click="store.sync('pull')"
          >
            <span class="toolbar-action-icon"
              ><Icon
                :name="
                  store.busy && store.activeOperation === 'pull'
                    ? 'LoaderCircle'
                    : 'ArrowDownToLine'
                "
                :class="{ spin: store.busy && store.activeOperation === 'pull' }"
                :size="19" /></span
            ><span>拉取</span>
          </button>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '推送本地提交'"
            @click="store.sync('push')"
          >
            <span class="toolbar-action-icon"
              ><Icon
                :name="
                  store.busy && store.activeOperation === 'push'
                    ? 'LoaderCircle'
                    : 'ArrowUpFromLine'
                "
                :class="{ spin: store.busy && store.activeOperation === 'push' }"
                :size="19" /></span
            ><span>推送</span>
          </button>
          <details
            class="sync-options"
            ref="syncOptions"
            @keydown.esc.stop.prevent="closeSyncOptions(true)"
            :inert="store.busy"
          >
            <summary
              aria-label="同步选项"
              title="选择拉取方式或核对同步目标"
            >
              <Icon
                name="ChevronDown"
                :size="12"
              />
            </summary>
            <div
              class="sync-options-menu"
              @click="syncOptions?.removeAttribute('open')"
            >
              <button
                :aria-pressed="store.pullMethod === 'merge'"
                @click="store.sync('pull', undefined, store.captureOperation(), 'merge')"
              >
                拉取（快进或合并）
              </button>
              <button
                :aria-pressed="store.pullMethod === 'ff-only'"
                @click="store.sync('pull', undefined, store.captureOperation(), 'ff-only')"
              >
                仅快进拉取
              </button>
              <button @click="store.prepareSync('pull')">核对拉取目标…</button>
              <button @click="store.prepareSync('push')">核对推送目标…</button>
            </div>
          </details>
          <span class="toolbar-divider"></span>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '创建新分支'"
            @click="store.modal = 'branch'"
          >
            <span class="toolbar-action-icon"
              ><Icon
                name="GitBranch"
                :size="19" /></span
            ><span>分支</span>
          </button>
          <StashToolbar />
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="
              store.busy ? '请等待当前操作完成' : '刷新本地状态 (Ctrl+R)；更新远程分支请点击获取'
            "
            @click="store.refresh()"
          >
            <span class="toolbar-action-icon"
              ><Icon
                name="RefreshCw"
                :size="18"
                :class="{ spin: store.busy && store.activeOperation === 'refresh' }" /></span
            ><span>刷新</span>
          </button>
        </div>
        <button
          class="open-button secondary-button"
          aria-label="打开仓库"
          title="打开仓库"
          :disabled="store.busy || rebase.active"
          @click="store.requestOpen()"
        >
          <Icon
            name="FolderOpen"
            :size="15"
          /><span>打开仓库</span
          ><kbd>{{ chrome.platform.value === 'macos' ? '⌘ O' : 'Ctrl O' }}</kbd>
        </button>
      </div>
      <GitFlowFinishStatus />
      <MergeStatus />
      <div
        class="workbench"
        :inert="store.starting || store.startupPhase === 'error' || store.unloadedRepository"
      >
        <MergeEditor v-if="mergeEditing" />
        <RebasePanel
          v-if="rebase.active"
          :inert="mergeEditing"
        />
        <Sidebar
          v-else
          ref="sidebar"
          :inert="mergeEditing"
        />
        <div
          v-if="!rebase.active"
          class="resize-handle left"
          :inert="mergeEditing"
          role="separator"
          :tabindex="narrowPanels ? -1 : 0"
          :aria-disabled="narrowPanels"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          :aria-valuenow="narrowPanels ? 190 : sidebarWidth"
          :aria-valuemin="190"
          :aria-valuemax="330"
          @pointerdown="resize($event, 'left')"
          @dblclick.stop.prevent="resetPanel('left')"
          title="拖动调整宽度；双击恢复此侧默认宽度"
          @keydown.left.prevent="resizeByKeyboard('left', -10)"
          @keydown.right.prevent="resizeByKeyboard('left', 10)"
        ></div>
        <CommitHistory
          v-if="!rebase.active"
          ref="history"
          :inert="!!flow.panel || mergeEditing"
          :aria-hidden="flow.panel || mergeEditing ? 'true' : undefined"
        />
        <div
          class="resize-handle right"
          :inert="mergeEditing"
          role="separator"
          :tabindex="narrowPanels ? -1 : 0"
          :aria-disabled="narrowPanels"
          aria-label="调整详情面板宽度"
          aria-orientation="vertical"
          :aria-valuenow="narrowPanels ? 290 : inspectorWidth"
          :aria-valuemin="290"
          :aria-valuemax="540"
          @pointerdown="resize($event, 'right')"
          @dblclick.stop.prevent="resetPanel('right')"
          title="拖动调整宽度；双击恢复此侧默认宽度"
          @keydown.left.prevent="resizeByKeyboard('right', 10)"
          @keydown.right.prevent="resizeByKeyboard('right', -10)"
        ></div>
        <Inspector
          ref="inspector"
          :inert="store.inspectorCovered || mergeEditing"
          :aria-hidden="store.inspectorCovered || mergeEditing ? 'true' : undefined"
        />
        <GitFlowPanel />
      </div>
    </template>
    <footer class="statusbar">
      <div class="statusbar-primary">
        <span
          class="connection-dot"
          :class="{ online: store.connected }"
        ></span
        ><span
          id="operation-status"
          role="status"
          :title="store.isWorking ? connectionStatus : store.runtime?.gitPath"
          >{{ connectionStatus }}</span
        ><button
          v-if="store.runtime && !store.runtime.gitAvailable"
          class="status-cancel"
          @click="applicationMenu?.openGitSettings()"
        >
          配置 Git</button
        ><button
          v-if="!store.connected"
          class="status-cancel"
          :disabled="store.connecting || store.busy"
          :title="store.connectionError || '连接本地 Git 服务'"
          @click="store.init()"
        >
          {{ store.connecting ? '连接中…' : '连接本地 Git 服务' }}</button
        ><button
          v-if="store.isWorking"
          class="status-cancel"
          :disabled="store.cancelling || store.fetchCancelling"
          @click="store.cancelOperation()"
        >
          {{ store.cancelling || store.fetchCancelling ? '正在取消…' : '取消' }}</button
        ><template v-if="!store.isNewTab"
          ><span class="status-divider"></span
          ><Icon
            name="GitBranch"
            :size="12"
          /><button
            class="status-branch"
            :title="`切换分支：${store.repo.branch}；右键查看分支操作`"
            :aria-label="`切换当前分支，当前 ${store.repo.branch}`"
            :disabled="store.blocksTabs || rebase.active || !store.repo.path"
            @click="openBranchPicker"
            @contextmenu="branchContext"
            @keydown="branchContextKeyboard"
          >
            <span>{{ store.repo.branch }}</span></button
          ><span
            v-if="store.changes"
            class="status-changes"
            >{{ store.changes }} 项更改</span
          ></template
        >
      </div>
      <div class="statusbar-secondary">
        <button
          v-if="store.externalRefreshError"
          class="external-refresh-status"
          :title="store.externalRefreshError"
          @click="store.requestExternalRefresh()"
        >
          仓库状态刷新失败，重试
        </button>
        <span
          v-else-if="store.externalRefreshDeferred"
          role="status"
          aria-label="仓库状态刷新"
          >等待其他 Git 操作完成</span
        >
        <span
          v-else-if="store.externalRefreshing"
          role="status"
          aria-label="仓库状态刷新"
          >正在核对工作区…</span
        >
        <button
          v-if="!store.isNewTab && store.connected"
          class="fetch-status-button"
          :class="{ 'has-error': !!store.currentFetchStatus?.error }"
          :title="
            (store.currentFetchStatus?.error
              ? fetchFailureSummary(store.currentFetchStatus.error)
              : '') ||
            (store.currentFetchStatus?.lastSuccess
              ? `最后成功获取：${new Date(store.currentFetchStatus.lastSuccess).toLocaleString()}`
              : '尚无成功获取记录')
          "
          @click="store.openFetchLog()"
        >
          <Icon
            :name="
              store.automaticFetching
                ? 'LoaderCircle'
                : store.currentFetchStatus?.error
                  ? 'AlertCircle'
                  : 'Cloud'
            "
            :size="13"
            :class="{ spin: store.automaticFetching }"
          />
          {{
            store.automaticFetching
              ? '后台获取中'
              : store.currentFetchStatus?.error
                ? '获取失败'
                : store.currentFetchStatus?.lastSuccess
                  ? `已获取 ${new Date(store.currentFetchStatus.lastSuccess).toLocaleTimeString()}`
                  : '远端状态'
          }}
        </button>
        <button
          v-if="!store.isNewTab"
          class="status-path"
          :title="`${store.repo.path}；单击复制，右键显示位置操作`"
          aria-label="复制仓库路径"
          :disabled="store.blocksTabs || !store.repo.path"
          @click="repositoryLocation('copy-path')"
          @contextmenu="openWorkbenchMenu($event, 'path')"
          @keydown="openWorkbenchMenu($event, 'path')"
        >
          <span>{{ store.repo.path }}</span></button
        ><span
          v-else
          class="status-path"
          >打开仓库以查看分支和工作区状态</span
        ><button
          title="活动日志与自动获取设置"
          aria-label="活动日志"
          :disabled="!store.connected"
          @click="store.openActivityLog()"
        >
          <Icon
            name="History"
            :size="14"
          /></button
        ><button
          title="快捷键"
          aria-label="查看快捷键"
          @click="store.modal = 'help'"
        >
          <Icon
            name="Keyboard"
            :size="13"
          />
        </button>
      </div>
    </footer>
    <ActivityLog v-if="store.activityPanelOpen" />
    <WorkbenchMenu
      v-if="workbenchMenu"
      :key="`${workbenchMenu.kind}:${workbenchMenu.tabId || workbenchMenu.repo}`"
      :label="workbenchMenu.kind === 'tab' ? '标签页操作' : '仓库位置操作'"
      :x="workbenchMenu.x"
      :y="workbenchMenu.y"
      :items="workbenchItems"
      @select="selectWorkbenchItem"
      @close="closeWorkbenchMenu"
    />
    <RecoveryPanel v-if="store.modal === 'recovery'" />
    <Dialogs /><RepositoryDialog />
    <RepositoryTrustDialog />
    <StashDeleteDialog />
    <ProtectedCheckoutDialog /><GitFlowFinishDialog />
    <ContextMenu /><NavigationDialog /><CommitActionsDialog />
    <div
      class="toast-stack"
      aria-live="polite"
    >
      <OperationFeedback />
      <div
        v-for="notice in store.notices"
        :key="notice.id"
        class="toast"
        :class="{ error: notice.error }"
      >
        <Icon
          :name="notice.error ? 'AlertCircle' : 'Check'"
          :size="16"
        />
        <div class="toast-content">
          {{ notice.text
          }}<button
            v-if="notice.logId"
            class="text-button toast-log-link"
            @click="store.openActivityLog(notice.logId)"
          >
            查看日志
          </button>
          <details
            v-if="notice.details && !notice.logId"
            class="toast-details"
            :open="!!notice.expanded"
          >
            <summary @click.prevent="notice.expanded = !notice.expanded">查看详情</summary>
            <pre>{{ notice.details }}</pre>
          </details>
        </div>
        <button
          class="icon-button"
          aria-label="关闭提示"
          @click="store.notices = store.notices.filter((n) => n.id !== notice.id)"
        >
          <Icon
            name="X"
            :size="13"
          />
        </button>
      </div>
    </div>
  </div>
</template>
