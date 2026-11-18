<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import { vOverflowTitle } from '../directives/overflowTitle'
const TerminalView = defineAsyncComponent(() => import('./TerminalView.vue'))
const GitConsoleView = defineAsyncComponent(() => import('./GitConsoleView.vue'))
const consoleOpened = ref(false)
function openConsole() {
  consoleOpened.value = true
  store.showConsole()
}
import Icon from './Icon.vue'
import WorkbenchMenu from './WorkbenchMenu.vue'

const store = useTerminalStore()
const shellButton = ref<HTMLButtonElement>()
const shellMenu = ref<{ x: number; y: number }>()
const shellItems = computed(() => [
  { id: 'default', label: '新建默认终端' },
  ...store.shells
    .filter((entry) => entry.id !== 'default')
    .map((entry) => ({ id: `shell:${entry.id}`, label: `新建 ${entry.label}` })),
])
function openShellMenu() {
  if (shellMenu.value) {
    shellMenu.value = undefined
    return
  }
  if (store.creating || !shellButton.value) return
  const bounds = shellButton.value.getBoundingClientRect()
  shellMenu.value = { x: bounds.left, y: bounds.bottom + 4 }
}
function closeShellMenu(restore = false) {
  shellMenu.value = undefined
  if (restore) shellButton.value?.focus()
}
function createShell(id: string) {
  closeShellMenu()
  if (id === 'default') void store.create()
  else {
    const entry = store.shells.find((shell) => `shell:${shell.id}` === id)
    if (entry) void store.create(entry.id)
  }
}
watch(
  () => [store.visible, store.shells, store.creating],
  () => closeShellMenu(),
)

watch(
  () => store.visible && store.tool === 'console',
  (active) => {
    if (active) consoleOpened.value = true
  },
  { immediate: true },
)
function navigateTab(event: KeyboardEvent, index: number) {
  const count = store.current.length + 1
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % count
  else if (event.key === 'ArrowLeft') next = (index + count - 1) % count
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else return
  event.preventDefault()
  if (next === 0) openConsole()
  else store.select(store.current[next - 1].id, false)
  void nextTick(() =>
    document
      .getElementById(
        next === 0 ? 'git-console-tab' : `terminal-tab-${store.current[next - 1]?.id}`,
      )
      ?.focus(),
  )
}
const height = ref(280),
  viewport = ref(window.innerHeight),
  expanded = ref(false)
const confirm = ref<HTMLDialogElement>()
const closeId = ref(''),
  closing = ref(false)
let resizeCleanup: (() => void) | undefined
try {
  const saved = Number(localStorage.getItem('gitcode.terminalHeight'))
  if (saved >= 120 && saved <= 900) height.value = saved
} catch {
  /* Use the default height when local settings cannot be read. */
}
const maximum = computed(() => Math.max(120, Math.floor(viewport.value * 0.65)))
const panelHeight = computed(() =>
  Math.min(expanded.value ? maximum.value : height.value, maximum.value),
)
function saveHeight() {
  try {
    localStorage.setItem('gitcode.terminalHeight', String(height.value))
  } catch {
    /* Resizing remains available without persistent storage. */
  }
}
function resize(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  resizeCleanup?.()
  expanded.value = false
  const startY = event.clientY,
    startHeight = panelHeight.value
  const move = (e: PointerEvent) => {
    height.value = Math.max(120, Math.min(maximum.value, startHeight + startY - e.clientY))
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    saveHeight()
    resizeCleanup = undefined
  }
  resizeCleanup = stop
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
}
function requestClose(id: string) {
  closeId.value = id
  // Closing is explicit; hiding the panel never kills a command.
  if (!id && store.current.filter((s) => s.state === 'running').length >= 2)
    confirm.value?.showModal()
  else void closeSessions()
}
async function closeSessions() {
  if (closing.value) return
  closing.value = true
  try {
    const ids = closeId.value ? [closeId.value] : store.current.map((s) => s.id)
    for (const id of ids) await store.close(id)
    confirm.value?.close()
  } finally {
    closing.value = false
  }
}
function keyboardResize(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
  event.preventDefault()
  expanded.value = false
  height.value =
    event.key === 'Home'
      ? 280
      : Math.max(
          120,
          Math.min(maximum.value, panelHeight.value + (event.key === 'ArrowUp' ? 20 : -20)),
        )
  saveHeight()
}
function resetHeight() {
  height.value = 280
  expanded.value = false
  saveHeight()
}
const updateViewport = () => {
  viewport.value = window.innerHeight
}
onMounted(() => window.addEventListener('resize', updateViewport))
onUnmounted(() => {
  resizeCleanup?.()
  window.removeEventListener('resize', updateViewport)
})
</script>
<template>
  <section
    v-show="store.visible"
    class="terminal-workbench"
    :aria-label="store.tool === 'terminal' ? '终端面板' : 'Git 控制台面板'"
    :style="{ height: `${panelHeight}px` }"
  >
    <div
      class="terminal-resize"
      role="separator"
      tabindex="0"
      aria-label="调整工具窗口高度"
      aria-orientation="horizontal"
      :aria-valuemin="120"
      :aria-valuemax="maximum"
      :aria-valuenow="panelHeight"
      @pointerdown="resize"
      @keydown="keyboardResize"
      @dblclick="resetHeight()"
    ></div>
    <header class="terminal-header">
      <div
        class="terminal-tabs"
        role="tablist"
        aria-label="控制台与终端会话"
      >
        <div
          class="terminal-tab terminal-console-tab"
          :class="{ selected: store.tool === 'console' }"
        >
          <button
            id="git-console-tab"
            role="tab"
            :aria-selected="store.tool === 'console'"
            aria-controls="git-console-panel"
            :tabindex="store.tool === 'console' ? 0 : -1"
            @click="openConsole"
            @keydown="navigateTab($event, 0)"
          >
            Git 控制台
          </button>
        </div>
        <div
          v-for="(session, index) in store.current"
          :key="session.id"
          class="terminal-tab"
          :class="{ selected: store.tool === 'terminal' && session.id === store.active?.id }"
        >
          <button
            :id="`terminal-tab-${session.id}`"
            role="tab"
            :aria-selected="store.tool === 'terminal' && session.id === store.active?.id"
            :aria-controls="`terminal-${session.id}`"
            :tabindex="store.tool === 'terminal' && session.id === store.active?.id ? 0 : -1"
            :aria-label="`终端 ${session.number} · ${session.shell}${session.state === 'exited' ? ' · 已退出' : ''}`"
            v-overflow-title="{
              text: `${session.shell} ${session.number}${session.state === 'exited' ? ' · 已退出' : ''}`,
              target: '.terminal-tab-label',
            }"
            @click="store.select(session.id)"
            @keydown="navigateTab($event, index + 1)"
          >
            <Icon
              name="Terminal"
              :size="14"
            /><span class="terminal-tab-label"
              >{{ session.shell }} {{ session.number
              }}{{ session.state === 'exited' ? ' · 已退出' : '' }}</span
            >
          </button>
          <button
            class="icon-button"
            :aria-label="`关闭终端 ${session.number}`"
            @click="requestClose(session.id)"
          >
            <Icon
              name="X"
              :size="12"
            />
          </button>
        </div>
      </div>
      <div class="terminal-actions">
        <button
          class="icon-button"
          aria-label="新建终端"
          title="新建终端"
          :disabled="store.creating"
          @click="store.create()"
        >
          <Icon
            name="Plus"
            :size="15"
          />
        </button>
        <button
          v-if="store.shells.length > 1"
          ref="shellButton"
          class="icon-button terminal-shell-menu-button"
          aria-label="选择 Shell 新建终端"
          aria-haspopup="menu"
          :aria-expanded="!!shellMenu"
          title="选择 Shell 新建终端"
          :disabled="store.creating"
          @click="openShellMenu"
          @keydown.down.prevent="openShellMenu"
        >
          <Icon
            name="ChevronDown"
            :size="12"
          />
        </button>
        <WorkbenchMenu
          v-if="shellMenu"
          label="新建终端类型"
          :x="shellMenu.x"
          :y="shellMenu.y"
          :anchor="shellButton"
          :items="shellItems"
          @select="createShell"
          @close="closeShellMenu"
        />
        <button
          class="icon-button"
          :aria-label="expanded ? '还原工具窗口高度' : '展开工具窗口'"
          :title="expanded ? '还原工具窗口高度' : '展开工具窗口'"
          @click="expanded = !expanded"
        >
          <Icon
            name="WindowMaximize"
            :size="14"
          />
        </button>
        <button
          class="icon-button"
          aria-label="关闭当前仓库的所有终端"
          title="关闭所有终端"
          :disabled="!store.current.length"
          @click="requestClose('')"
        >
          <Icon
            name="X"
            :size="14"
          />
        </button>
        <button
          class="icon-button"
          :aria-label="store.tool === 'terminal' ? '隐藏终端' : '隐藏 Git 控制台'"
          :title="store.tool === 'terminal' ? '隐藏终端 (Ctrl+`)' : '隐藏 Git 控制台'"
          @click="store.hide()"
        >
          <Icon
            name="Minus"
            :size="16"
          />
        </button>
      </div>
    </header>
    <div class="terminal-body">
      <GitConsoleView
        id="git-console-panel"
        role="tabpanel"
        aria-labelledby="git-console-tab"
        v-if="consoleOpened"
        v-show="store.tool === 'console'"
        :active="store.visible && store.tool === 'console'"
      />
      <TerminalView
        v-for="session in store.sessions"
        v-show="store.visible && store.tool === 'terminal' && session.id === store.active?.id"
        :id="`terminal-${session.id}`"
        role="tabpanel"
        :aria-labelledby="`terminal-tab-${session.id}`"
        :key="session.id"
        :session="session"
        :active="store.visible && store.tool === 'terminal' && session.id === store.active?.id"
      />
      <div
        v-if="store.tool === 'terminal' && !store.current.length"
        class="terminal-empty"
        role="status"
      >
        {{ store.creating ? '正在启动终端…' : store.error || '尚未打开终端'
        }}<button
          v-if="!store.creating"
          class="secondary-button"
          @click="store.create()"
        >
          {{ store.error ? '重试' : '新建终端' }}
        </button>
      </div>
      <p
        v-else-if="store.tool === 'terminal' && store.error"
        class="terminal-error"
        role="alert"
      >
        {{ store.error }}
      </p>
    </div>
  </section>
  <dialog
    ref="confirm"
    class="dialog dialog-confirmation"
    aria-label="关闭终端"
    @cancel.prevent="!closing && confirm?.close()"
  >
    <div class="dialog-content">
      <h2>关闭终端？</h2>
      <p>
        {{
          closeId
            ? '这会终止此终端及其中正在运行的命令。'
            : '这会终止当前仓库的所有终端及其中正在运行的命令。'
        }}
      </p>
      <div class="dialog-actions">
        <button
          class="secondary-button"
          :disabled="closing"
          @click="confirm?.close()"
        >
          取消</button
        ><button
          class="danger-button"
          :disabled="closing"
          @click="closeSessions"
        >
          关闭终端
        </button>
      </div>
    </div>
  </dialog>
</template>
