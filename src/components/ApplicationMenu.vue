<script setup lang="ts">
import { focusMenuItem } from '../menuFocus'
import AppBrand from './AppBrand.vue'
import { version as appVersion } from '../../package.json'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { useGraphViewStore } from '../stores/graphView'
import { useContextMenuStore } from '../stores/contextMenu'
import {
  applicationBridge,
  type ApplicationMenuState,
  type EditCommand,
} from '../services/application'
import { buildMenus, shortcutLabel, type MenuItem } from '../menu'
import { pathName } from '../services/desktop'
import Icon from './Icon.vue'
import { useAppearanceStore } from '../stores/appearance'
import { isThemePreference, themePresets } from '../themePresets'
import PreferencesDialog from './PreferencesDialog.vue'

const props = defineProps<{ platform: string }>()
const emit = defineEmits<{ search: []; resetView: [] }>()
const graphView = useGraphViewStore()
const appearance = useAppearanceStore()
const store = useRepositoryStore(),
  context = useContextMenuStore(),
  bridge = applicationBridge()
const nativeMac = computed(() => !!bridge && props.platform === 'macos')
const menuEnglishNames: Record<string, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  repository: 'Repository',
  help: 'Help',
}
const navigation = ref<HTMLElement>(),
  dropdown = ref<HTMLElement>()
const active = ref<string | null>(null),
  submenuOpen = ref<string | null>(null)
const left = ref(0),
  top = ref(0),
  submenuLeft = ref(0),
  submenuTop = ref(0)
const settingsOpen = ref(false)
const settingsSection = ref<'appearance' | 'repository' | 'git'>('appearance')
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
let submenuHoverTimer: ReturnType<typeof setTimeout> | undefined
let submenuPointerOrigin: { x: number; y: number } | null = null
function cancelSubmenuHover() {
  clearTimeout(submenuHoverTimer)
  submenuHoverTimer = undefined
}
let observer: MutationObserver | undefined
const unsubscribers: (() => void)[] = []
let mounted = false,
  publishing = false,
  publishAgain = false
const blocked = computed(
  () =>
    store.starting ||
    store.startupPhase === 'error' ||
    !!store.modal ||
    store.rebasePlanning ||
    layerOpen.value ||
    quitId.value !== null ||
    settingsOpen.value,
)
const state = computed<ApplicationMenuState>(() => {
  const enabled: string[] = ['file.quit']
  if (!blocked.value) {
    enabled.push('file.settings')
    enabled.push(
      'view.theme',
      ...Object.keys(themePresets).map((id) => `view.theme.${id}`),
      'view.theme.system',
    )
    enabled.push('view.activityLog', 'help.shortcuts', 'help.gitDocs', 'help.gitBook', 'help.about')
    if (!store.busy && !store.choosingRepository) {
      enabled.push(
        'file.newTab',
        'file.open',
        'file.clone',
        'file.create',
        'file.closeTab',
        'view.resetLayout',
      )
      store.recent.forEach((_, i) => enabled.push(`file.recent.${i}`))
      if (store.connected && !store.isNewTab && !store.fetchCancelling) {
        enabled.push(
          'repository.pull',
          'repository.push',
          'repository.recovery',
          'repository.settings',
        )
        if (!store.fetching) enabled.push('repository.fetch')
      }
      if (!store.isNewTab) enabled.push('view.refresh', 'view.search')
    }
    if (!store.isNewTab)
      enabled.push(
        'view.author',
        'view.time',
        'view.sha',
        'view.longEdges',
        'view.mergeCommits',
        'view.labelPosition',
        'view.labelPosition.before',
        'view.labelPosition.after',
        'view.labelStyle',
        'view.labelStyle.current',
        'view.labelStyle.gitkraken',
        'view.labelStyle.idea',
        'view.resetColumns',
      )
  }
  for (const key of Object.keys(editing.value) as EditCommand[])
    if (editing.value[key]) enabled.push(`edit.${key}`)
  return {
    enabled,
    recent: store.recent.map((path) => `${pathName(path)} — ${path}`),
    author: store.showAuthor,
    time: store.showTime,
    sha: store.showSha,
    longEdges: graphView.showLongEdges,
    mergeCommits: graphView.dimMergeCommits,
    labelsAfterMessage: graphView.labelsAfterMessage,
    labelStyle: graphView.labelStyle,
    theme: appearance.themeSource,
    themePreference: appearance.theme,
    palette: appearance.palette,
    resolvedTheme: appearance.resolvedTheme,
  }
})
const groups = computed(() => buildMenus(state.value))
const group = computed(() => groups.value.find((item) => item.id === active.value))
function hasMenuMarks(items: MenuItem[]) {
  return items.some((item) => !item.separator && (item.checkbox || item.radio))
}
const groupHasMarks = computed(() => !!group.value && hasMenuMarks(group.value.items))
function focusTop(id: string) {
  navigation.value
    ?.querySelector<HTMLButtonElement>(`[data-top-menu="${id}"]`)
    ?.focus({ preventScroll: true })
}
function close(restore = true) {
  cancelSubmenuHover()
  submenuPointerOrigin = null
  active.value = null
  submenuOpen.value = null
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
  cancelSubmenuHover()
  if (!active.value && !keyboardEntry) {
    captureEditing()
    lastFocus = document.activeElement as HTMLElement
  }
  keyboardEntry = false
  context.close(false)
  active.value = id
  submenuOpen.value = null
  await nextTick()
  if (active.value !== id) return
  const button = navigation.value?.querySelector<HTMLElement>(`[data-top-menu="${id}"]`)
  if (!button || !dropdown.value) return
  const rect = button.getBoundingClientRect()
  left.value = Math.max(8, Math.min(rect.left, window.innerWidth - dropdown.value.offsetWidth - 8))
  top.value = Math.max(
    8,
    Math.min(rect.bottom + 3, window.innerHeight - dropdown.value.offsetHeight - 8),
  )
  if (focus && !dropdown.value.contains(document.activeElement))
    dropdown.value
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true })
}
function closeSubmenu() {
  cancelSubmenuHover()
  submenuPointerOrigin = null
  const id = submenuOpen.value
  submenuOpen.value = null
  if (id)
    focusMenuItem(
      dropdown.value?.querySelector<HTMLButtonElement>(`[data-submenu-trigger="${id}"]`),
    )
}
let submenuAnchorTop = 0
function menuScrolled() {
  if (!submenuOpen.value) return
  const button = dropdown.value?.querySelector<HTMLElement>(
    `[data-submenu-trigger="${submenuOpen.value}"]`,
  )
  // A queued focus-scroll event must not close a submenu that was just opened.
  if (!button || Math.abs(button.getBoundingClientRect().top - submenuAnchorTop) > 0.5) {
    cancelSubmenuHover()
    submenuOpen.value = null
    submenuPointerOrigin = null
  }
}
async function openSubmenu(id: string, focus = true) {
  cancelSubmenuHover()
  const item = group.value?.items.find((item) => item.id === id)
  if (!item?.enabled || !item.children) return
  submenuAnchorTop =
    dropdown.value
      ?.querySelector<HTMLElement>(`[data-submenu-trigger="${id}"]`)
      ?.getBoundingClientRect().top || 0
  submenuOpen.value = id
  await nextTick()
  if (submenuOpen.value !== id) return
  const button = dropdown.value?.querySelector<HTMLElement>(`[data-submenu-trigger="${id}"]`)
  const submenu = dropdown.value?.querySelector<HTMLElement>('[data-submenu-menu]')
  if (button && submenu) {
    const rect = button.getBoundingClientRect()
    submenuPointerOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    submenuAnchorTop = rect.top
    const width = submenu.offsetWidth
    submenuLeft.value =
      rect.right + width + 3 <= window.innerWidth - 8
        ? rect.right + 3
        : Math.max(8, rect.left - width - 3)
    submenuTop.value = Math.max(
      8,
      Math.min(rect.top, window.innerHeight - submenu.offsetHeight - 8),
    )
  }
  if (focus && !submenu?.contains(document.activeElement))
    focusMenuItem(
      submenu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ||
        submenu?.querySelector<HTMLButtonElement>('button:not(:disabled)'),
    )
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
    else if (id === 'file.open') await store.requestOpen()
    else if (id === 'file.clone') store.modal = 'clone'
    else if (id === 'file.create') store.modal = 'create'
    else if (id === 'file.settings' || id === 'repository.settings') {
      settingsSection.value = id === 'repository.settings' ? 'repository' : 'appearance'
      settingsOpen.value = true
    } else if (id === 'file.closeTab') store.closeTab(store.activeTabId)
    else if (/^file\.recent\.[0-5]$/.test(id)) {
      const path = store.recent[Number(id.at(-1))]
      if (path) await store.open(path)
    } else if (id === 'file.quit') {
      if (bridge) await bridge.requestQuit()
      else store.notify('请关闭当前浏览器标签页；本地 Git 服务会继续服务其他页面。')
    } else if (id === 'view.refresh') await store.refresh()
    else if (id === 'view.search') emit('search')
    else if (id.startsWith('view.theme.')) {
      const theme = id.slice('view.theme.'.length)
      if (isThemePreference(theme)) appearance.setTheme(theme)
    } else if (id === 'view.author') store.showAuthor = !store.showAuthor
    else if (id === 'view.time') store.showTime = !store.showTime
    else if (id === 'view.sha') store.showSha = !store.showSha
    else if (id === 'view.longEdges') graphView.toggleLongEdges()
    else if (id === 'view.mergeCommits') graphView.toggleMergeCommits()
    else if (id === 'view.labelPosition.before' || id === 'view.labelPosition.after') {
      if (graphView.labelsAfterMessage !== id.endsWith('.after'))
        graphView.toggleLabelsAfterMessage()
    } else if (id === 'view.labelStyle.current') graphView.setLabelStyle('current')
    else if (id === 'view.labelStyle.gitkraken') graphView.setLabelStyle('gitkraken')
    else if (id === 'view.labelStyle.idea') graphView.setLabelStyle('idea')
    else if (id === 'view.resetColumns') store.resetColumns()
    else if (id === 'view.resetLayout') emit('resetView')
    else if (id === 'repository.fetch') await store.run('fetch')
    else if (id === 'repository.pull') await store.sync('pull')
    else if (id === 'repository.push') await store.sync('push')
    else if (id === 'repository.recovery') store.modal = 'recovery'
    else if (id === 'view.activityLog') store.openActivityLog()
    else if (id === 'help.shortcuts') store.modal = 'help'
    else if (id === 'help.gitDocs') await store.openResource('git-docs')
    else if (id === 'help.gitBook') await store.openResource('git-book')
    else if (id === 'help.about') {
      info.value = bridge
        ? await bridge.info()
        : {
            name: 'GitCode',
            version: appVersion,
            electron: store.connected ? '浏览器 + 本地 Git 服务' : '浏览器模式（未连接）',
            platform: props.platform,
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
  if (!store.isWorking && !store.draftTabs.length) {
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
    store.isWorking ||
    (store.draftTabs.length && !discardDrafts.value)
  )
    return
  approving.value = true
  try {
    if (discardDrafts.value) await store.discardCommitDrafts()
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
  if (mode === 'cancel' && store.isWorking) await store.cancelOperation()
  if (!store.isWorking) await finishQuit()
}
watch(
  () => store.isWorking,
  (busy) => {
    if (!busy && quitMode.value) void finishQuit()
  },
)
watch(
  () => [store.activeTabId, store.modal, context.target, store.isWorking],
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
  cancelSubmenuHover()
  if (
    ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Tab'].includes(
      event.key,
    )
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (submenuOpen.value) {
      closeSubmenu()
    } else close()
    return
  }
  if (
    event.key === 'ArrowRight' &&
    (document.activeElement as HTMLElement)?.hasAttribute('data-submenu-trigger')
  ) {
    void openSubmenu((document.activeElement as HTMLElement).dataset.submenuTrigger!)
    return
  }
  if (event.key === 'ArrowLeft' && submenuOpen.value) {
    closeSubmenu()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (submenuOpen.value) return
    const index = groups.value.findIndex((g) => g.id === active.value)
    void open(
      groups.value[
        (index + (event.key === 'ArrowLeft' ? -1 : 1) + groups.value.length) % groups.value.length
      ].id,
    )
    return
  }
  const scope =
    (document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-submenu-menu]') ||
    dropdown.value
  const buttons = [
    ...(scope?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') || []),
  ]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Home') focusMenuItem(buttons[0])
  if (event.key === 'End') focusMenuItem(buttons.at(-1))
  if (event.key === 'ArrowDown') focusMenuItem(buttons[(index + 1) % buttons.length])
  if (event.key === 'ArrowUp') focusMenuItem(buttons[(index - 1 + buttons.length) % buttons.length])
}
function globalKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
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
          ',': 'file.settings',
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
  if (item.children) void openSubmenu(item.id)
  else void run(item.id)
}
function hoverItem(item: MenuItem, event: PointerEvent) {
  // Layout changes can move a row under a stationary pointer during keyboard navigation.
  if (!event.movementX && !event.movementY) return
  cancelSubmenuHover()
  if (submenuOpen.value === item.id) {
    submenuPointerOrigin = { x: event.clientX, y: event.clientY }
    return
  }
  const change = () => {
    if (item.children && item.enabled) void openSubmenu(item.id, false)
    else submenuOpen.value = null
  }
  const submenu = dropdown.value?.querySelector<HTMLElement>('[data-submenu-menu]')
  const origin = submenuPointerOrigin
  if (submenu && origin) {
    const rect = submenu.getBoundingClientRect()
    const right = rect.left >= origin.x
    const edge = right ? rect.left : rect.right
    const distance = edge - origin.x
    const progress = (event.clientX - origin.x) / distance
    // Keep the current submenu while crossing neighbouring rows toward it.
    // A pause on a different row still switches the menu after a short delay.
    if (
      distance &&
      progress >= 0 &&
      progress <= 1 &&
      (right ? event.movementX >= 0 : event.movementX <= 0)
    ) {
      const upper = origin.y + (rect.top - 8 - origin.y) * progress
      const lower = origin.y + (rect.bottom + 8 - origin.y) * progress
      if (event.clientY >= upper && event.clientY <= lower) {
        submenuHoverTimer = setTimeout(change, 300)
        return
      }
    }
  }
  change()
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
  cancelSubmenuHover()
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
function openGitSettings() {
  if (store.modal || settingsOpen.value || quitId.value !== null || layerOpen.value) return
  settingsSection.value = 'git'
  settingsOpen.value = true
}
defineExpose({ openGitSettings })
</script>

<template>
  <PreferencesDialog
    v-if="settingsOpen"
    :initial-section="settingsSection"
    @close="settingsOpen = false"
  />
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
      :aria-label="`${entry.label} ${menuEnglishNames[entry.id]}`"
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
      @scroll="menuScrolled"
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
          :aria-expanded="item.children ? submenuOpen === item.id : undefined"
          :data-submenu-trigger="item.children ? item.id : undefined"
          :disabled="!item.enabled"
          tabindex="-1"
          @click="activate(item)"
          @pointermove="hoverItem(item, $event)"
        >
          <span class="application-item-label"
            ><span
              v-if="groupHasMarks"
              class="menu-check"
              aria-hidden="true"
              >{{ item.checked ? (item.radio ? '●' : '✓') : '' }}</span
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
          v-if="item.children && submenuOpen === item.id"
          data-app-menu
          data-submenu-menu
          class="context-menu application-submenu"
          role="menu"
          :aria-label="item.label"
          :style="{ left: `${submenuLeft}px`, top: `${submenuTop}px` }"
          @pointerenter="cancelSubmenuHover"
        >
          <button
            v-for="recent in item.children"
            :key="recent.id"
            :role="recent.radio ? 'menuitemradio' : 'menuitem'"
            :aria-checked="recent.radio ? recent.checked : undefined"
            tabindex="-1"
            :disabled="!recent.enabled"
            :title="recent.label"
            @click="run(recent.id)"
          >
            <span class="application-item-label"
              ><span
                v-if="hasMenuMarks(item.children)"
                class="menu-check"
                aria-hidden="true"
                >{{ recent.checked ? (recent.radio ? '●' : '✓') : '' }}</span
              >{{ recent.label }}</span
            >
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
        <AppBrand
          :size="48"
          class="about-brand"
        />
        <h2 id="about-title">关于 {{ info?.name || 'GitCode' }}</h2>
        <p>本地 Git 工作台</p>
        <dl>
          <dt>应用版本</dt>
          <dd>{{ info?.version }}</dd>
          <dt>Git</dt>
          <dd>{{ store.runtime?.gitVersion || '尚未连接本机 Git' }}</dd>
          <dt>运行环境</dt>
          <dd>{{ info?.electron }} / {{ info?.platform }}</dd>
          <template v-if="store.runtime">
            <dt>Git 执行环境</dt>
            <dd>
              {{ store.runtime.environment === 'wsl' ? 'WSL / ' : '' }}{{ store.runtime.platform }}
            </dd>
          </template>
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
      class="dialog dialog-confirmation application-quit"
      aria-labelledby="quit-title"
      @cancel.prevent="cancelQuit"
    >
      <div class="dialog-content">
        <h2 id="quit-title">退出 GitCode？</h2>
        <p v-if="approving">正在退出…</p>
        <p v-if="store.isWorking">
          {{
            quitMode
              ? quitMode === 'wait'
                ? '正在等待操作和状态读取完成…'
                : '正在取消操作并读取仓库状态…'
              : `正在${store.operationLabel}。请选择等待完成，或取消操作后退出。取消不等于回滚。`
          }}
        </p>
        <p v-if="store.draftTabs.length">
          以下
          {{ store.draftTabs.length }} 个标签有尚未完成的草稿（提交说明、变基编排或冲突处理结果）：
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
          />{{
            store.mergeDraftTabs.size || store.rebasePlanning
              ? '确认丢弃这些草稿'
              : '确认丢弃这些说明草稿'
          }}</label
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
              v-if="store.isWorking"
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
              {{ store.isWorking ? '取消操作并退出' : '退出 GitCode' }}
            </button></template
          >
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.about-brand {
  --brand-type-size: calc(28px + var(--ui-font-delta, 0px));
  --brand-mark-gap: 12px;
  margin: 2px 0 22px;
}
</style>
