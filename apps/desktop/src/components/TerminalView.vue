<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { desktop } from '../services/desktop'
import { useAppearanceStore } from '../stores/appearance'
import { useRepositoryStore } from '../stores/repository'
import { useTerminalStore, type TerminalSession } from '../stores/terminal'
import WorkbenchMenu, { type WorkbenchMenuItem } from './WorkbenchMenu.vue'

const props = defineProps<{ session: TerminalSession; active: boolean }>()
const appearance = useAppearanceStore(),
  repository = useRepositoryStore(),
  store = useTerminalStore()
const element = ref<HTMLElement>()
const menu = ref<{ x: number; y: number }>()
const hasSelection = ref(false)
const terminal = new Terminal({
  scrollback: 5000,
  cursorBlink: true,
  cursorStyle: 'bar',
  allowProposedApi: false,
  letterSpacing: 0,
})
const fit = new FitAddon()
terminal.loadAddon(fit)
let fontVersion = 0
let alive = true,
  cursor = 0,
  complete = false,
  observer: ResizeObserver | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let input = Promise.resolve()
let refreshing: ReturnType<typeof setTimeout> | undefined
function fail(reason: unknown) {
  if (!alive) return
  store.update(props.session.id, {
    error: reason instanceof Error ? reason.message : '终端连接中断。',
  })
  terminal.options.disableStdin = true
}
function refreshRepository() {
  if (repository.repo.path === props.session.repo) repository.requestExternalRefresh()
}
function write(data: string) {
  if (props.session.state !== 'running' || props.session.error) return
  if (data.length > 64 * 1024) {
    repository.notify('终端单次粘贴内容超过 64 KiB，请分段粘贴。', true)
    return
  }
  // Preserve key/paste order without exposing a raw IPC or arbitrary spawn API.
  for (let offset = 0; offset < data.length; offset += 8192) {
    const chunk = data.slice(offset, offset + 8192)
    input = input
      .then(async () => {
        if (alive && !props.session.error && props.session.state === 'running')
          await desktop.terminal(props.session.repo, {
            action: 'write',
            id: props.session.id,
            data: chunk,
          })
      })
      .catch(fail)
  }
  if (/[\r\n]/.test(data) || data.includes(String.fromCharCode(3))) {
    clearTimeout(refreshing)
    refreshing = setTimeout(refreshRepository, 500)
  }
}
async function poll() {
  clearTimeout(timer)
  if (!alive || complete || props.session.error) return
  try {
    const reply = await desktop.terminal(props.session.repo, {
      action: 'read',
      id: props.session.id,
      cursor,
    })
    if (!alive) return
    if (!reply || typeof reply.cursor !== 'number') throw Error('终端服务返回了无效响应。')
    if (reply.dropped) {
      terminal.reset()
      terminal.writeln('\x1b[33m[较早输出已超出缓存范围]\x1b[0m')
    }
    if (reply.data) await new Promise<void>((resolve) => terminal.write(reply.data!, resolve))
    if (!alive) return
    cursor = reply.cursor
    if (reply.state === 'exited' && !reply.more) {
      complete = true
      store.update(props.session.id, { state: 'exited', exitCode: reply.exitCode ?? null })
      terminal.options.disableStdin = true
      terminal.writeln(`\r\n[进程已退出，退出码 ${reply.exitCode ?? '未知'}]`)
      refreshRepository()
    }
    if (!complete) timer = setTimeout(() => void poll(), reply.more ? 0 : props.active ? 120 : 1000)
  } catch (reason) {
    fail(reason)
  }
}
function resize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!alive || !props.active || !element.value?.clientHeight) return
    fit.fit()
    if (props.session.state === 'running' && !props.session.error)
      void desktop
        .terminal(props.session.repo, {
          action: 'resize',
          id: props.session.id,
          cols: Math.min(500, Math.max(2, terminal.cols)),
          rows: Math.min(300, Math.max(1, terminal.rows)),
        })
        .catch(fail)
  }, 80)
}
function style() {
  if (!element.value) return
  const css = getComputedStyle(element.value)
  const value = (key: string) => css.getPropertyValue(key).trim()
  const family = css.fontFamily,
    size = parseFloat(value('--terminal-font-size')) || 13,
    lineHeight = parseFloat(value('--terminal-line-height')) || 1.3,
    version = ++fontVersion
  // xterm measures and caches cell sizes independently of CSS. Apply a newly selected
  // bundled font after it loads so its first measurement does not use the fallback font.
  void (async () => {
    try {
      await Promise.all([
        document.fonts.load(`${size}px ${family}`, 'Wm0123 中文'),
        document.fonts.load(`bold ${size}px ${family}`, 'Wm0123 中文'),
      ])
    } catch {
      // Missing/unavailable fonts still use the configured system fallback stack.
    }
    if (!alive || version !== fontVersion) return
    terminal.options.fontFamily = family
    terminal.options.fontSize = size
    terminal.options.lineHeight = lineHeight
    terminal.refresh(0, terminal.rows - 1)
    resize()
  })()
  const theme: ITheme = {
    background: value('--panel'),
    foreground: value('--text'),
    cursor: value('--accent'),
    selectionBackground: value('--view-selection-bg') || '#4d88ff50',
  }
  const colors =
    appearance.resolvedTheme === 'light'
      ? [
          '#1c1e23',
          '#b4232a',
          '#1b6b31',
          '#846000',
          '#1757ad',
          '#8739a2',
          '#007985',
          '#526175',
          '#647082',
          '#be2434',
          '#256f32',
          '#886100',
          '#255fc0',
          '#8b3cb0',
          '#007d88',
          '#273548',
        ]
      : [
          '#1c1e23',
          '#e06c75',
          '#98c379',
          '#e5c07b',
          '#61afef',
          '#c678dd',
          '#56b6c2',
          '#abb2bf',
          '#7f848e',
          '#f48791',
          '#b0d795',
          '#f2d694',
          '#8ac7fa',
          '#d9a2f4',
          '#7bd2dc',
          '#ffffff',
        ]
  const names = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ] as const
  names.forEach((name, index) => {
    theme[name] = colors[index]
  })
  terminal.options.theme = theme
}
async function copy() {
  try {
    await navigator.clipboard.writeText(terminal.getSelection())
  } catch {
    repository.notify('无法访问剪贴板，请使用系统复制快捷键。', true)
  }
}
async function paste() {
  try {
    terminal.paste(await navigator.clipboard.readText())
  } catch {
    repository.notify('无法读取剪贴板，请使用系统粘贴快捷键。', true)
  }
}
const items = computed<WorkbenchMenuItem[]>(() => [
  { id: 'copy', label: '复制', disabled: !hasSelection.value },
  {
    id: 'paste',
    label: '粘贴',
    disabled: props.session.state !== 'running' || !!props.session.error,
  },
  { id: 'select', label: '全选' },
  { id: 'clear', label: '清屏', separator: true },
  { id: 'hide', label: '隐藏终端', separator: true },
  { id: 'close', label: '关闭此终端' },
])
function select(action: string) {
  menu.value = undefined
  if (action === 'copy') void copy()
  if (action === 'paste') void paste()
  if (action === 'select') terminal.selectAll()
  if (action === 'clear') terminal.clear()
  if (action === 'hide') store.hide()
  if (action === 'close') void store.close(props.session.id)
  terminal.focus()
}
watch(
  () => appearance.palette,
  () => void nextTick(style),
)
watch(
  () => [props.active, store.focusVersion] as const,
  async () => {
    await nextTick()
    if (props.active) {
      resize()
      if (store.focusShell) terminal.focus()
    } else menu.value = undefined
  },
)
onMounted(() => {
  terminal.open(element.value!)
  style()
  terminal.onData(write)
  terminal.onSelectionChange(() => {
    hasSelection.value = terminal.hasSelection()
  })
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.code === 'Backquote') return false
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      terminal.hasSelection()
    ) {
      event.preventDefault()
      void copy()
      return false
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      void paste()
      return false
    }
    return true
  })
  observer = new ResizeObserver(resize)
  observer.observe(element.value!)
  if (props.active && store.focusShell) terminal.focus()
  void poll()
})
onUnmounted(() => {
  fontVersion++
  alive = false
  clearTimeout(timer)
  clearTimeout(resizeTimer)
  clearTimeout(refreshing)
  observer?.disconnect()
  terminal.dispose()
})
</script>
<template>
  <div
    class="terminal-session-view"
    @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY }"
  >
    <div
      ref="element"
      class="terminal-screen"
      :aria-label="`${session.shell} 终端`"
    ></div>
    <div
      v-if="session.error"
      class="terminal-error"
      role="alert"
    >
      {{ session.error }}
    </div>
    <WorkbenchMenu
      v-if="menu"
      label="终端操作"
      :x="menu.x"
      :y="menu.y"
      :items="items"
      @select="select"
      @close="menu = undefined"
    />
  </div>
</template>
