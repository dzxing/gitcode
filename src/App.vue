<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from './stores/repository'
import Sidebar from './components/Sidebar.vue'
import CommitHistory from './components/CommitHistory.vue'
import Inspector from './components/Inspector.vue'
import Dialogs from './components/Dialogs.vue'
import Icon from './components/Icon.vue'
import NewTab from './components/NewTab.vue'
import WindowControls from './components/WindowControls.vue'
import ContextMenu from './components/ContextMenu.vue'
import NavigationDialog from './components/NavigationDialog.vue'
import ApplicationMenu from './components/ApplicationMenu.vue'
import GitFlowPanel from './components/GitFlowPanel.vue'
import ProtectedCheckoutDialog from './components/ProtectedCheckoutDialog.vue'
import GitFlowFinishDialog from './components/GitFlowFinishDialog.vue'
import GitFlowFinishStatus from './components/GitFlowFinishStatus.vue'
import MergeStatus from './components/MergeStatus.vue'
import MergeDialog from './components/MergeDialog.vue'
import RebasePanel from './components/RebasePanel.vue'
import { useRebaseStore } from './stores/rebase'
import StashToolbar from './components/StashToolbar.vue'
import StashDeleteDialog from './components/StashDeleteDialog.vue'
import { useContextMenuStore } from './stores/contextMenu'
import { useGitFlowStore } from './stores/gitflow'
import { useDesktopWindow } from './composables/useDesktopWindow'
import { isDesktop } from './services/desktop'
import { branchTracking } from './branchTracking'

const store = useRepositoryStore()
const rebase = useRebaseStore()
const chrome = useDesktopWindow()
const contextMenu = useContextMenuStore()
const flow = useGitFlowStore()
const history = ref<{ focusSearch(): void }>()
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
const branchTrigger = ref<HTMLElement>()
const currentTracking = computed(() => branchTracking(store.repo.branches.find((b) => b.current)))
const coreLabel = computed(() =>
  store.runtime?.transport === 'local'
    ? store.runtime.environment === 'wsl'
      ? 'WSL 本机核心'
      : '本机核心'
    : '桌面核心',
)
const connectionStatus = computed(() =>
  store.busy
    ? store.cancelling
      ? '正在取消操作并核对结果…'
      : `正在${store.operationLabel}…`
    : store.connecting
      ? '正在连接本机核心…'
      : store.connected
        ? `${coreLabel.value}已连接 · ${store.runtime?.gitAvailable ? store.runtime.gitVersion : '未找到 Git'}`
        : '本机核心未连接 · 界面体验',
)
function beforeUnload(event: BeforeUnloadEvent) {
  if (!isDesktop() && (store.busy || store.draftTabs.length)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function closeBranchMenu(restoreFocus = false) {
  if (!branchMenu.value?.open) return
  branchMenu.value.open = false
  if (restoreFocus) branchTrigger.value?.focus({ preventScroll: true })
}
function dismissBranchMenu(event: Event) {
  // Context menus and modal confirmations may temporarily take focus from this popup.
  if (
    document.querySelector('dialog[open]') ||
    (contextMenu.target &&
      (event.type === 'focusin' || (event.target as Element)?.closest?.('.context-menu')))
  )
    return
  if (branchMenu.value?.open && !branchMenu.value.contains(event.target as Node)) closeBranchMenu()
}
watch(
  () => store.activeTabId,
  () => closeBranchMenu(),
)
watch(
  () => store.modal,
  (value) => {
    if (value) closeBranchMenu()
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
  if ((event.target as HTMLElement)?.closest?.('.gitflow-panel')) return
  const command = event.ctrlKey || event.metaKey
  if (contextMenu.target || store.modal || document.querySelector('dialog[open]')) return
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

function chooseBranch(name: string) {
  if (store.busy) return
  closeBranchMenu(true)
  if (name === store.repo.branch) return
  const target = store.repo.branches.find(
    (branch) => branch.kind === 'local' && branch.name === name,
  )
  if (target) void store.checkoutBranch(target)
}
onMounted(() => {
  fitPanels()
  window.addEventListener('resize', fitPanels)
  void store.init()
  window.addEventListener('keydown', keydown)
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('pointerdown', dismissBranchMenu, true)
  document.addEventListener('focusin', dismissBranchMenu)
})
onUnmounted(() => {
  window.removeEventListener('resize', fitPanels)
  window.removeEventListener('keydown', keydown)
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
      'platform-macos': chrome.platform.value === 'macos',
      'window-maximized': chrome.maximized.value,
      'window-unfocused': !chrome.focused.value,
    }"
    :style="{ '--sidebar-width': `${sidebarWidth}px`, '--inspector-width': `${inspectorWidth}px` }"
  >
    <header class="titlebar">
      <button
        class="brand"
        aria-label="GitCode 首页"
        @click="store.newTab()"
      >
        <span class="brand-symbol"
          ><Icon
            name="GitBranch"
            :size="20" /></span
        ><span>Git<span class="brand-accent">Code</span></span>
      </button>
      <ApplicationMenu
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
          :class="{ active: tab.id === store.activeTabId, 'new-page-tab': tab.kind === 'new' }"
        >
          <button
            class="tab-select"
            :disabled="store.busy || rebase.active"
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
            :disabled="store.busy || rebase.active"
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
        :disabled="store.busy || rebase.active"
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
          title="使用本机 Git 身份"
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
    <NewTab
      v-if="store.isNewTab"
      :key="store.activeTabId"
    />
    <template v-else>
      <div
        class="toolbar"
        :inert="rebase.active"
      >
        <button
          class="repo-selector"
          :disabled="store.busy || rebase.active"
          aria-haspopup="dialog"
          :aria-label="`打开本地仓库，当前仓库 ${store.repo.name}`"
          :title="`打开本地仓库：${store.repo.path}`"
          @click="store.modal = 'open'"
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
        >
          <summary
            ref="branchTrigger"
            :aria-label="`选择本地分支，当前 ${store.repo.branch}`"
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
            class="branch-dropdown"
            @keydown.esc.stop.prevent="closeBranchMenu(true)"
          >
            <small>切换本地分支</small
            ><button
              v-for="branch in store.repo.branches.filter((b) => b.kind === 'local')"
              :key="branch.name"
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
            <p v-if="!store.repo.branches.some((b) => b.kind === 'local')">
              首次提交后即可创建分支
            </p>
          </div>
        </details>
        <div class="toolbar-actions">
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="
              store.busy
                ? '请等待当前操作完成'
                : '获取远程分支（遵循远程跳过配置，不含标签，不清理引用）'
            "
            @click="store.run('fetch')"
          >
            <Icon
              name="Cloud"
              :size="19"
            /><span>获取</span>
          </button>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '拉取远程更新（仅快进）'"
            @click="store.prepareSync('pull')"
          >
            <Icon
              name="ArrowDownToLine"
              :size="19"
            /><span>拉取</span>
          </button>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '推送本地提交'"
            @click="store.prepareSync('push')"
          >
            <Icon
              name="ArrowUpFromLine"
              :size="19"
            /><span>推送</span>
          </button>
          <span class="toolbar-divider"></span>
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '创建新分支'"
            @click="store.modal = 'branch'"
          >
            <Icon
              name="GitBranch"
              :size="19"
            /><span>分支</span>
          </button>
          <StashToolbar />
          <button
            :disabled="store.busy || rebase.active"
            :aria-describedby="store.busy ? 'operation-status' : undefined"
            :title="store.busy ? '请等待当前操作完成' : '刷新仓库 (Ctrl+R)'"
            @click="store.refresh()"
          >
            <Icon
              name="RefreshCw"
              :size="18"
              :class="{ spin: store.busy }"
            /><span>刷新</span>
          </button>
        </div>
        <button
          class="open-button secondary-button"
          :disabled="store.busy || rebase.active"
          @click="store.modal = 'open'"
        >
          <Icon
            name="FolderOpen"
            :size="15"
          /><span>打开仓库</span><kbd>Ctrl O</kbd>
        </button>
      </div>
      <GitFlowFinishStatus />
      <MergeStatus />
      <div class="workbench">
        <RebasePanel v-if="rebase.active" />
        <Sidebar v-else />
        <div
          v-if="!rebase.active"
          class="resize-handle left"
          role="separator"
          :tabindex="narrowPanels ? -1 : 0"
          :aria-disabled="narrowPanels"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          :aria-valuenow="narrowPanels ? 190 : sidebarWidth"
          :aria-valuemin="190"
          :aria-valuemax="330"
          @pointerdown="resize($event, 'left')"
          @keydown.left.prevent="resizeByKeyboard('left', -10)"
          @keydown.right.prevent="resizeByKeyboard('left', 10)"
        ></div>
        <CommitHistory
          v-if="!rebase.active"
          ref="history"
          :inert="!!flow.panel"
          :aria-hidden="flow.panel ? 'true' : undefined"
        />
        <div
          class="resize-handle right"
          role="separator"
          :tabindex="narrowPanels ? -1 : 0"
          :aria-disabled="narrowPanels"
          aria-label="调整详情面板宽度"
          aria-orientation="vertical"
          :aria-valuenow="narrowPanels ? 290 : inspectorWidth"
          :aria-valuemin="290"
          :aria-valuemax="540"
          @pointerdown="resize($event, 'right')"
          @keydown.left.prevent="resizeByKeyboard('right', 10)"
          @keydown.right.prevent="resizeByKeyboard('right', -10)"
        ></div>
        <Inspector
          ref="inspector"
          :inert="store.inspectorCovered"
          :aria-hidden="store.inspectorCovered ? 'true' : undefined"
        />
        <GitFlowPanel />
      </div>
    </template>
    <footer class="statusbar">
      <div>
        <span
          class="connection-dot"
          :class="{ online: store.connected }"
        ></span
        ><span
          id="operation-status"
          role="status"
          :title="store.runtime?.gitPath"
          >{{ connectionStatus }}</span
        ><button
          v-if="!store.connected"
          class="status-cancel"
          :disabled="store.connecting || store.busy"
          :title="store.connectionError || '连接本机 Git 核心'"
          @click="store.init()"
        >
          {{ store.connecting ? '连接中…' : '连接本机核心' }}</button
        ><button
          v-if="store.busy"
          class="status-cancel"
          :disabled="store.cancelling"
          @click="store.cancelOperation()"
        >
          {{ store.cancelling ? '正在取消…' : '取消' }}</button
        ><template v-if="!store.isNewTab"
          ><span class="status-divider"></span
          ><Icon
            name="GitBranch"
            :size="12"
          /><span>{{ store.repo.branch }}</span
          ><span
            v-if="store.changes"
            class="status-changes"
            >{{ store.changes }} 项更改</span
          ></template
        >
      </div>
      <div>
        <span
          class="status-path"
          :title="store.isNewTab ? undefined : store.repo.path"
          >{{ store.isNewTab ? 'GitCode · 每一次更改，清晰可见' : store.repo.path }}</span
        ><button
          title="快捷键"
          aria-label="查看快捷键"
          @click="store.modal = 'help'"
        >
          <Icon
            name="Keyboard"
            :size="13"
          /></button
        ><span class="status-divider"></span><span>UTF-8</span>
      </div>
    </footer>
    <Dialogs />
    <StashDeleteDialog />
    <MergeDialog />
    <ProtectedCheckoutDialog /><GitFlowFinishDialog /> <ContextMenu /><NavigationDialog />
    <div
      class="toast-stack"
      aria-live="polite"
    >
      <div
        v-for="notice in store.notices"
        :key="notice.id"
        class="toast"
        :class="{ error: notice.error }"
      >
        <Icon
          :name="notice.error ? 'AlertCircle' : 'Check'"
          :size="17"
        /><span>{{ notice.text }}</span
        ><button
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
