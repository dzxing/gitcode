<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { useContextMenuStore } from '../stores/contextMenu'
import {
  applicationBridge,
  type ApplicationMenuState,
  type EditCommand,
} from '../services/application'
import { buildMenus, shortcutLabel, type MenuItem } from '../menu'
import { pathName } from '../services/desktop'
import Icon from './Icon.vue'

const props = defineProps<{ platform: string }>()
const emit = defineEmits<{ search: [] }>()
const store = useRepositoryStore(),
  context = useContextMenuStore(),
  bridge = applicationBridge()
const nativeMac = computed(() => !!bridge && props.platform === 'macos')
const navigation = ref<HTMLElement>(),
  dropdown = ref<HTMLElement>()
const active = ref<string | null>(null),
  recentOpen = ref(false)
const left = ref(0),
  top = ref(0),
  recentLeft = ref(0),
  recentTop = ref(0)
const about = ref<HTMLDialogElement>(),
  quitDialog = ref<HTMLDialogElement>()
const info = ref<{ name: string; version: string; electron: string; platform: string } | null>(null)
const quitId = ref<number | null>(null),
  quitMode = ref<'wait' | 'cancel' | null>(null)
const discardDrafts = ref(false),
  quitError = ref(''),
  approving = ref(false)
const layerOpen = ref(false)
const editing = ref({
  undo: false,
  redo: false,
  cut: false,
  copy: false,
  paste: false,
  selectAll: false,
})
let editor: HTMLInputElement | HTMLTextAreaElement | null = null
let selectionStart: number | null = null,
  selectionEnd: number | null = null
let selectionRange: Range | null = null,
  lastFocus: HTMLElement | null = null
let keyboardEntry = false
let observer: MutationObserver | undefined
const unsubscribers: (() => void)[] = []
let mounted = false,
  publishing = false,
  publishAgain = false
const blocked = computed(() => !!store.modal || layerOpen.value || quitId.value !== null)
const state = computed<ApplicationMenuState>(() => {
  const enabled: string[] = ['file.quit']
  if (!blocked.value) {
    enabled.push('help.shortcuts', 'help.gitDocs', 'help.gitBook', 'help.about')
    if (!store.busy) {
      enabled.push('file.newTab', 'file.open', 'file.clone', 'file.create', 'file.closeTab')
      store.recent.forEach((_, i) => enabled.push(`file.recent.${i}`))
      if (!store.isNewTab)
        enabled.push(
          'view.refresh',
          'view.search',
          'view.author',
          'view.time',
          'view.sha',
          'view.resetColumns',
        )
    }
  }
  for (const key of Object.keys(editing.value) as EditCommand[])
    if (editing.value[key]) enabled.push(`edit.${key}`)
  return {
    enabled,
    recent: store.recent.map((path) => `${pathName(path)} — ${path}`),
    author: store.showAuthor,
    time: store.showTime,
    sha: store.showSha,
  }
})
const groups = computed(() => buildMenus(state.value))
const group = computed(() => groups.value.find((item) => item.id === active.value))
function focusTop(id: string) {
  navigation.value
    ?.querySelector<HTMLButtonElement>(`[data-top-menu="${id}"]`)
    ?.focus({ preventScroll: true })
}
function close(restore = true) {
  active.value = null
  recentOpen.value = false
  keyboardEntry = false
  if (restore && lastFocus?.isConnected) lastFocus.focus({ preventScroll: true })
}
function captureEditing() {
  const focused = document.activeElement
  if (focused instanceof Element && focused.closest('[data-app-menu]')) return
  const candidate =
    focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLInputElement &&
      ['text', 'search', 'url', 'tel', 'email', 'password', ''].includes(focused.type))
      ? focused
      : null
  editor = candidate
  selectionStart = candidate?.selectionStart ?? null
  selectionEnd = candidate?.selectionEnd ?? null
  const selection = window.getSelection()
  selectionRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
  const selected = candidate
    ? selectionStart !== null &&
      selectionEnd !== null &&
      selectionStart !== selectionEnd &&
      candidate.type !== 'password'
    : !!selection?.toString()
  const changeable = !!candidate && !candidate.disabled && !candidate.readOnly
  const query = (id: string) => {
    try {
      return document.queryCommandEnabled(id)
    } catch {
      return false
    }
  }
  const next = {
    undo: changeable && query('undo'),
    redo: changeable && query('redo'),
    cut: changeable && selected,
    copy: selected,
    paste: changeable && !!bridge,
    selectAll: !!candidate && !candidate.disabled && !!candidate.value.length,
  }
  if (JSON.stringify(next) !== JSON.stringify(editing.value)) editing.value = next
}
function restoreEditing() {
  const target = editor,
    start = selectionStart,
    end = selectionEnd,
    range = selectionRange
  if (target) {
    if (!target.isConnected) return false
    target.focus({ preventScroll: true })
    if (start !== null && end !== null) {
      try {
        target.setSelectionRange(start, end)
      } catch {
        /* Email fields have no selection API. */
      }
    }
  } else if (range) {
    if (!range.startContainer.isConnected) return false
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  captureEditing()
  return true
}
async function open(id: string, focus = true) {
  if (blocked.value) return
  if (!active.value && !keyboardEntry) {
    captureEditing()
    lastFocus = document.activeElement as HTMLElement
  }
  keyboardEntry = false
  context.close(false)
  active.value = id
  recentOpen.value = false
  await nextTick()
  const button = navigation.value?.querySelector<HTMLElement>(`[data-top-menu="${id}"]`)
  if (!button || !dropdown.value) return
  const rect = button.getBoundingClientRect()
  left.value = Math.max(6, Math.min(rect.left, window.innerWidth - dropdown.value.offsetWidth - 6))
  top.value = Math.max(
    6,
    Math.min(rect.bottom + 3, window.innerHeight - dropdown.value.offsetHeight - 6),
  )
  if (focus)
    dropdown.value
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true })
}
async function openRecent() {
  recentOpen.value = true
  await nextTick()
  const button = dropdown.value?.querySelector<HTMLElement>('[data-recent-trigger]')
  if (button) {
    const rect = button.getBoundingClientRect()
    recentLeft.value =
      rect.right + 260 < window.innerWidth ? rect.right + 3 : Math.max(6, rect.left - 260)
    recentTop.value = Math.max(
      6,
      Math.min(rect.top, window.innerHeight - store.recent.length * 32 - 16),
    )
  }
  dropdown.value
    ?.querySelector<HTMLButtonElement>('[data-recent-menu] button:not(:disabled)')
    ?.focus()
}
async function run(id: string) {
  if (!state.value.enabled.includes(id)) return
  const returnFocus = active.value ? lastFocus : (document.activeElement as HTMLElement)
  close(false)
  if (!id.startsWith('edit.') && returnFocus?.isConnected)
    returnFocus.focus({ preventScroll: true })
  try {
    if (id.startsWith('edit.')) {
      if (!restoreEditing()) {
        store.notify('原编辑位置已变化，请重新选择文本。')
        return
      }
      const command = id.slice(5) as EditCommand
      if (bridge) await bridge.edit(command)
      else if (command === 'copy')
        await navigator.clipboard.writeText(
          editor && selectionStart !== null && selectionEnd !== null
            ? editor.value.slice(selectionStart, selectionEnd)
            : window.getSelection()?.toString() || '',
        )
      else document.execCommand(command === 'selectAll' ? 'selectAll' : command)
      captureEditing()
    } else if (id === 'file.newTab') store.newTab()
    else if (id === 'file.open') store.modal = 'open'
    else if (id === 'file.clone') store.modal = 'clone'
    else if (id === 'file.create') store.modal = 'create'
    else if (id === 'file.closeTab') store.closeTab(store.activeTabId)
    else if (/^file\.recent\.[0-5]$/.test(id)) {
      const path = store.recent[Number(id.at(-1))]
      if (path) await store.open(path)
    } else if (id === 'file.quit') {
      if (bridge) await bridge.requestQuit()
      else store.notify('请关闭当前浏览器标签页；本机核心会继续服务其他页面。')
    } else if (id === 'view.refresh') await store.refresh()
    else if (id === 'view.search') emit('search')
    else if (id === 'view.author') store.showAuthor = !store.showAuthor
    else if (id === 'view.time') store.showTime = !store.showTime
    else if (id === 'view.sha') store.showSha = !store.showSha
    else if (id === 'view.resetColumns') store.resetColumns()
    else if (id === 'help.shortcuts') store.modal = 'help'
    else if (id === 'help.gitDocs') await store.openResource('git-docs')
    else if (id === 'help.gitBook') await store.openResource('git-book')
    else if (id === 'help.about') {
      info.value = bridge
        ? await bridge.info()
        : {
            name: 'GitCode',
            version: '0.1.0',
            electron: store.connected ? '浏览器 + 本机核心' : '浏览器界面体验',
            platform: store.runtime?.platform || navigator.platform,
          }
      about.value?.showModal()
    }
  } catch (error) {
    store.notify((error as Error).message, true)
  }
}
async function receiveClose(id: number) {
  if (!bridge) return
  if (!(await bridge.acknowledgeClose(id))) return
  close(false)
  context.close(false)
  if (!store.busy && !store.draftTabs.length) {
    await bridge.approveClose(id)
    return
  }
  quitId.value = id
  quitMode.value = null
  discardDrafts.value = false
  quitError.value = ''
  await nextTick()
  quitDialog.value?.showModal()
}
async function cancelQuit() {
  const id = quitId.value
  if (id === null || approving.value) return
  quitMode.value = null
  quitId.value = null
  quitDialog.value?.close()
  await bridge?.cancelClose(id)
}
async function finishQuit() {
  if (
    quitId.value === null ||
    approving.value ||
    store.busy ||
    (store.draftTabs.length && !discardDrafts.value)
  )
    return
  approving.value = true
  try {
    if (!(await bridge?.approveClose(quitId.value)))
      throw new Error('退出请求已失效，请取消后重新退出。')
  } catch (error) {
    approving.value = false
    quitError.value = (error as Error).message
  }
}
async function chooseQuit(mode: 'wait' | 'cancel') {
  if (store.draftTabs.length && !discardDrafts.value) return
  quitMode.value = mode
  if (mode === 'cancel' && store.busy) await store.cancelOperation()
  if (!store.busy) await finishQuit()
}
watch(
  () => store.busy,
  (busy) => {
    if (!busy && quitMode.value) void finishQuit()
  },
)
watch(
  () => [store.activeTabId, store.modal, context.target, store.busy],
  () => close(false),
)
watch(
  state,
  () => {
    void publishState()
  },
  { deep: true },
)
async function publishState() {
  if (!mounted || !bridge) return
  if (publishing) {
    publishAgain = true
    return
  }
  publishing = true
  try {
    do {
      publishAgain = false
      await bridge.setMenuState(state.value)
    } while (publishAgain && mounted)
  } catch (error) {
    store.notify(`菜单连接失败，请重启桌面应用：${(error as Error).message}`, true)
  } finally {
    publishing = false
  }
}
function topKey(event: KeyboardEvent, id: string) {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void open(id)
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const index = groups.value.findIndex((g) => g.id === id)
    focusTop(
      groups.value[
        (index + (event.key === 'ArrowLeft' ? -1 : 1) + groups.value.length) % groups.value.length
      ].id,
    )
  }
}
function menuKey(event: KeyboardEvent) {
  if (!active.value) return
  if (
    ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Tab'].includes(
      event.key,
    )
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (recentOpen.value) {
      recentOpen.value = false
      dropdown.value?.querySelector<HTMLButtonElement>('[data-recent-trigger]')?.focus()
    } else close()
    return
  }
  if (
    event.key === 'ArrowRight' &&
    (document.activeElement as HTMLElement)?.hasAttribute('data-recent-trigger')
  ) {
    void openRecent()
    return
  }
  if (event.key === 'ArrowLeft' && recentOpen.value) {
    recentOpen.value = false
    dropdown.value?.querySelector<HTMLButtonElement>('[data-recent-trigger]')?.focus()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const index = groups.value.findIndex((g) => g.id === active.value)
    void open(
      groups.value[
        (index + (event.key === 'ArrowLeft' ? -1 : 1) + groups.value.length) % groups.value.length
      ].id,
    )
    return
  }
  const buttons = [
    ...(dropdown.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
  ]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Home') buttons[0]?.focus()
  if (event.key === 'End') buttons.at(-1)?.focus()
  if (event.key === 'ArrowDown') buttons[(index + 1) % buttons.length]?.focus()
  if (event.key === 'ArrowUp') buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
}
function globalKey(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (active.value) {
    menuKey(event)
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey) {
      const edit = (
        {
          z: event.shiftKey ? 'redo' : 'undo',
          y: 'redo',
          x: 'cut',
          c: 'copy',
          v: 'paste',
          a: 'selectAll',
        } as Record<string, string>
      )[event.key.toLowerCase()]
      if (edit || event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (edit) void run(`edit.${edit}`)
        return
      }
    }
  }
  if (keyboardEntry && (event.key === 'Escape' || event.key === 'Tab')) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    } else keyboardEntry = false
    return
  }
  const key = event.key.toLowerCase()
  if (
    !nativeMac.value &&
    !blocked.value &&
    ((event.key === 'F10' && !event.shiftKey) ||
      (event.key === 'Alt' && !event.ctrlKey && !event.metaKey))
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (active.value || keyboardEntry) close()
    else {
      captureEditing()
      lastFocus = document.activeElement as HTMLElement
      keyboardEntry = true
      focusTop('file')
    }
    return
  }
  if (!nativeMac.value && !blocked.value && event.altKey && !event.ctrlKey && !event.metaKey) {
    const target = groups.value.find((g) => g.accessKey === key)
    if (target) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void open(target.id)
      return
    }
  }
  if (blocked.value || context.target || nativeMac.value) return
  let command = ''
  if (event.altKey && key === 't') command = 'file.newTab'
  else if (event.ctrlKey || event.metaKey)
    command =
      (
        {
          o: 'file.open',
          w: 'file.closeTab',
          r: 'view.refresh',
          k: 'view.search',
          '/': 'help.shortcuts',
        } as Record<string, string>
      )[key] || ''
  if (command) {
    event.preventDefault()
    event.stopImmediatePropagation()
    void run(command)
  }
}
function changed() {
  layerOpen.value = !!document.querySelector('dialog[open]')
  captureEditing()
}
function outside(event: Event) {
  if (active.value && !(event.target as HTMLElement)?.closest?.('[data-app-menu]')) close(false)
}
function dismiss() {
  close()
}
function activate(item: MenuItem) {
  if (item.children) void openRecent()
  else void run(item.id)
}
onMounted(() => {
  mounted = true
  if (bridge) {
    unsubscribers.push(
      bridge.onCommand((id) => {
        void run(id)
      }),
      bridge.onCloseRequested((id) => {
        void receiveClose(id).catch((error) =>
          store.notify(`无法检查退出状态：${(error as Error).message}`, true),
        )
      }),
    )
  }
  document.addEventListener('focusin', changed)
  document.addEventListener('input', changed)
  document.addEventListener('selectionchange', changed)
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', globalKey)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
  observer = new MutationObserver(changed)
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
  changed()
  void publishState()
})
onUnmounted(() => {
  mounted = false
  observer?.disconnect()
  unsubscribers.forEach((fn) => fn())
  document.removeEventListener('focusin', changed)
  document.removeEventListener('input', changed)
  document.removeEventListener('selectionchange', changed)
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('keydown', globalKey)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', dismiss)
})
</script>

<template>
  <nav
    v-if="!nativeMac"
    ref="navigation"
    data-app-menu
    class="application-menubar"
    role="menubar"
    aria-label="应用菜单"
  >
    <button
      v-for="entry in groups"
      :key="entry.id"
      :tabindex="entry.id === 'file' ? 0 : -1"
      :data-top-menu="entry.id"
      role="menuitem"
      aria-haspopup="menu"
      :aria-expanded="active === entry.id"
      :aria-label="`${entry.label} ${entry.id === 'file' ? 'File' : entry.id === 'edit' ? 'Edit' : entry.id === 'view' ? 'View' : 'Help'}`"
      :title="`${entry.label} (Alt+${entry.accessKey.toUpperCase()})`"
      :class="{ expanded: active === entry.id }"
      @pointerdown.prevent
      @click="active === entry.id ? close() : open(entry.id)"
      @mouseenter="active && active !== entry.id && open(entry.id)"
      @keydown="topKey($event, entry.id)"
    >
      {{ entry.label }}
    </button>
  </nav>
  <Teleport to="body">
    <div
      v-if="group"
      ref="dropdown"
      data-app-menu
      class="context-menu application-dropdown"
      role="menu"
      :aria-label="group.label"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @pointerdown.prevent
      @keydown="menuKey"
      @contextmenu.prevent
    >
      <template
        v-for="item in group.items"
        :key="item.id"
        ><div
          v-if="item.separator"
          class="context-menu-separator"
          role="separator"
        ></div>
        <button
          :role="item.checkbox ? 'menuitemcheckbox' : 'menuitem'"
          :aria-checked="item.checkbox ? item.checked : undefined"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :aria-expanded="item.children ? recentOpen : undefined"
          :data-recent-trigger="item.children ? '' : undefined"
          :disabled="!item.enabled"
          tabindex="-1"
          @click="activate(item)"
        >
          <span class="application-item-label"
            ><span
              class="menu-check"
              aria-hidden="true"
              >{{ item.checked ? '✓' : '' }}</span
            >{{ item.label }}</span
          ><kbd v-if="item.accelerator">{{
            shortcutLabel(item.accelerator, platform === 'macos')
          }}</kbd
          ><Icon
            v-if="item.children"
            name="ChevronRight"
            :size="13"
          />
        </button>
        <div
          v-if="item.children && recentOpen"
          data-app-menu
          data-recent-menu
          class="context-menu application-submenu"
          role="menu"
          aria-label="最近仓库"
          :style="{ left: `${recentLeft}px`, top: `${recentTop}px` }"
        >
          <button
            v-for="recent in item.children"
            :key="recent.id"
            role="menuitem"
            tabindex="-1"
            :disabled="!recent.enabled"
            :title="recent.label"
            @click="run(recent.id)"
          >
            {{ recent.label }}
          </button>
        </div>
      </template>
    </div>
    <dialog
      ref="about"
      class="dialog application-about"
      aria-labelledby="about-title"
      @click="$event.target === about && about?.close()"
    >
      <div class="dialog-content">
        <button
          class="icon-button dialog-close"
          aria-label="关闭关于窗口"
          @click="about?.close()"
        >
          <Icon
            name="X"
            :size="18"
          />
        </button>
        <h2 id="about-title">关于 {{ info?.name || 'GitCode' }}</h2>
        <p>本地 Git 工作台 · Electron + Vue</p>
        <dl>
          <dt>应用版本</dt>
          <dd>{{ info?.version }}</dd>
          <dt>Git</dt>
          <dd>{{ store.runtime?.gitVersion || '尚未连接本机 Git' }}</dd>
          <dt>运行环境</dt>
          <dd>{{ info?.electron }} / {{ info?.platform }}</dd>
        </dl>
        <button
          class="secondary-button"
          @click="about?.close()"
        >
          关闭
        </button>
      </div>
    </dialog>
    <dialog
      ref="quitDialog"
      class="dialog application-quit"
      aria-labelledby="quit-title"
      @cancel.prevent="cancelQuit"
    >
      <div class="dialog-content">
        <h2 id="quit-title">退出 GitCode？</h2>
        <p v-if="approving">正在退出…</p>
        <p v-if="store.busy">
          {{
            quitMode
              ? quitMode === 'wait'
                ? '正在等待操作和状态读取完成…'
                : '正在取消操作并读取仓库状态…'
              : `正在${store.operationLabel}。请选择等待完成，或取消操作后退出。取消不等于回滚。`
          }}
        </p>
        <p v-if="store.draftTabs.length">
          以下 {{ store.draftTabs.length }} 个标签有尚未保存的草稿（提交说明或冲突处理结果）：
        </p>
        <ul v-if="store.draftTabs.length">
          <li
            v-for="tab in store.draftTabs"
            :key="tab.id"
          >
            {{ tab.name }}
          </li>
        </ul>
        <label
          v-if="store.draftTabs.length"
          class="context-switch-option"
          ><input
            v-model="discardDrafts"
            type="checkbox"
            :disabled="!!quitMode"
          />{{ store.mergeDraftTabs.size ? '确认丢弃这些草稿' : '确认丢弃这些说明草稿' }}</label
        >
        <p
          v-if="quitError"
          role="alert"
          class="directory-error"
        >
          {{ quitError }}
        </p>
        <div class="dialog-actions">
          <button
            class="secondary-button"
            :disabled="approving"
            @click="cancelQuit"
          >
            {{ quitMode ? '取消退出' : '留在应用' }}</button
          ><template v-if="!quitMode"
            ><button
              v-if="store.busy"
              class="secondary-button"
              :disabled="store.draftTabs.length > 0 && !discardDrafts"
              @click="chooseQuit('wait')"
            >
              等待完成后退出</button
            ><button
              class="danger-button"
              :disabled="store.draftTabs.length > 0 && !discardDrafts"
              @click="chooseQuit('cancel')"
            >
              {{ store.busy ? '取消操作并退出' : '退出 GitCode' }}
            </button></template
          >
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
