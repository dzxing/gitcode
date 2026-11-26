<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useGraphViewStore } from '../../history/stores/graphView'
import Icon from '../../../shared/ui/Icon.vue'
import { useAppearanceStore } from '../stores/appearance'
import { useRepositoryStore } from '../../repository/stores/repository'
import RepositoryFetchSettings from '../../repository/components/RepositoryFetchSettings.vue'
import ThemePicker from './ThemePicker.vue'
import GitRuntimeSettings from './GitRuntimeSettings.vue'
import FontSettings from './FontSettings.vue'
import { useFontStore } from '../stores/fonts'
import { normalizeFonts } from '../fontPreferences'
import { commitPreferences } from '../preferencesSession'
import { isThemePreference } from '../../../shared/lib/themePresets'
import { getUIPlatform } from '../../../infrastructure/uiPlatform'
import { canConnectLocalCore } from '../../../infrastructure/coreBridge'

const props = defineProps<{ initialSection?: 'appearance' | 'fonts' | 'repository' | 'git' }>()
const emit = defineEmits<{ close: [] }>()
const store = useRepositoryStore()
const section = ref<'appearance' | 'fonts' | 'repository' | 'git'>(
  props.initialSection || 'appearance',
)
const canConfigureGit = computed(
  () =>
    typeof window.gitcode?.gitSettings === 'function' || (store.connected && canConnectLocalCore()),
)
const gitSettings = ref<InstanceType<typeof GitRuntimeSettings>>()
const gitVisited = ref(section.value === 'git')
const applying = ref(false)
const pending = computed(() => applying.value || !!gitSettings.value?.pending)
const footerActions =
  getUIPlatform() === 'macos' ? ['cancel', 'apply', 'confirm'] : ['confirm', 'cancel', 'apply']
const footerLabels: Record<string, string> = { confirm: '确定', cancel: '取消', apply: '应用' }
const sections = ['appearance', 'fonts', 'repository', 'git'] as const
const graph = useGraphViewStore()
const appearance = useAppearanceStore()
const theme = computed({ get: () => appearance.theme, set: appearance.previewTheme })
const dialog = ref<HTMLDialogElement>()
const hasMoreBelow = ref(false)
let scrollResize: ResizeObserver | undefined
let scrollMutation: MutationObserver | undefined
function updateScrollHint() {
  const panel = [
    ...(dialog.value?.querySelectorAll<HTMLElement>('.preferences-body > [role="tabpanel"]') || []),
  ].find((element) => element.getClientRects().length)
  hasMoreBelow.value = !!panel && panel.scrollHeight - panel.clientHeight - panel.scrollTop > 2
  if (panel) {
    scrollResize?.observe(panel)
    for (const child of panel.children) scrollResize?.observe(child)
  }
}
const style = computed({
  get: () => graph.labelStyle,
  set: (value) => {
    graph.labelStyle = value
  },
})
const afterMessage = computed({
  get: () => graph.labelsAfterMessage,
  set: (value: boolean) => {
    graph.labelsAfterMessage = value
  },
})
const longEdges = computed({
  get: () => graph.showLongEdges,
  set: (value: boolean) => {
    graph.showLongEdges = value
  },
})
const dimMerges = computed({
  get: () => graph.dimMergeCommits,
  set: (value: boolean) => {
    graph.dimMergeCommits = value
  },
})
function tabKey(event: KeyboardEvent) {
  if (event.isComposing || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = sections.indexOf(section.value)
  section.value =
    event.key === 'Home'
      ? 'appearance'
      : event.key === 'End'
        ? 'git'
        : sections[
            (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length
          ]
  void nextTick(() => document.getElementById(`settings-${section.value}-tab`)?.focus())
}
const fonts = useFontStore()
const fontSettings = ref<InstanceType<typeof FontSettings>>()
const fontsVisited = ref(section.value === 'fonts')
watch(section, (value) => {
  if (value === 'fonts') fontsVisited.value = true
  if (value === 'git') gitVisited.value = true
  void nextTick(updateScrollHint)
})
function capture() {
  return {
    theme: appearance.theme,
    fonts: normalizeFonts(fonts.settings),
    labelStyle: graph.labelStyle,
    labelsAfterMessage: graph.labelsAfterMessage,
    showLongEdges: graph.showLongEdges,
    dimMergeCommits: graph.dimMergeCommits,
  }
}
function entries(value: ReturnType<typeof capture>) {
  return {
    'gitcode.theme': value.theme,
    'gitcode.fonts': JSON.stringify(value.fonts),
    'gitcode.graph-label-style': value.labelStyle,
    'gitcode.graph-labels-after-message': String(value.labelsAfterMessage),
    'gitcode.graph-long-edges': String(value.showLongEdges),
    'gitcode.graph-dim-merges': String(value.dimMergeCommits),
  }
}
const applied = ref(capture())
const dirty = computed(
  () =>
    JSON.stringify(capture()) !== JSON.stringify(applied.value) ||
    !!gitSettings.value?.dirty ||
    !!appearance.warning ||
    !!fonts.warning,
)
const error = ref('')
const saved = ref(false)
const saveState = computed(() =>
  applying.value
    ? '正在保存…'
    : pending.value
      ? '正在处理…'
      : dirty.value
        ? '有未应用的修改'
        : saved.value
          ? '设置已应用'
          : '',
)
let expected: Record<string, string | null> = {}
try {
  expected = Object.fromEntries(
    Object.keys(entries(applied.value)).map((key) => [key, localStorage.getItem(key)]),
  )
} catch {
  /* Apply reports unavailable storage; preview and cancel remain usable. */
}
function restore() {
  const value = { ...applied.value, fonts: normalizeFonts(applied.value.fonts) }
  try {
    // Cancel must not undo preferences saved by another window while this preview was open.
    const saved = Object.fromEntries(
      Object.keys(entries(value)).map((key) => [key, localStorage.getItem(key)]),
    )
    if (saved['gitcode.theme'] !== expected['gitcode.theme'])
      value.theme = isThemePreference(saved['gitcode.theme']) ? saved['gitcode.theme'] : 'dark'
    if (saved['gitcode.fonts'] !== expected['gitcode.fonts']) {
      try {
        value.fonts = normalizeFonts(JSON.parse(saved['gitcode.fonts'] || 'null'))
      } catch {
        value.fonts = normalizeFonts(null)
      }
    }
    if (saved['gitcode.graph-label-style'] !== expected['gitcode.graph-label-style']) {
      const label = saved['gitcode.graph-label-style']
      value.labelStyle = label === 'idea' || label === 'current' ? label : 'gitkraken'
    }
    if (
      saved['gitcode.graph-labels-after-message'] !== expected['gitcode.graph-labels-after-message']
    )
      value.labelsAfterMessage = saved['gitcode.graph-labels-after-message'] !== 'false'
    if (saved['gitcode.graph-long-edges'] !== expected['gitcode.graph-long-edges'])
      value.showLongEdges = saved['gitcode.graph-long-edges'] === 'true'
    if (saved['gitcode.graph-dim-merges'] !== expected['gitcode.graph-dim-merges'])
      value.dimMergeCommits = saved['gitcode.graph-dim-merges'] !== 'false'
  } catch {
    /* The last applied in-memory state still permits cancel when storage is unavailable. */
  }
  appearance.previewTheme(value.theme)
  fonts.preview(value.fonts)
  graph.labelStyle = value.labelStyle
  graph.labelsAfterMessage = value.labelsAfterMessage
  graph.showLongEdges = value.showLongEdges
  graph.dimMergeCommits = value.dimMergeCommits
}
async function apply() {
  if (pending.value) return false
  error.value = ''
  if (fontSettings.value && !fontSettings.value.validate()) {
    section.value = 'fonts'
    return false
  }
  if (gitSettings.value?.dirty && !gitSettings.value.validate()) {
    section.value = 'git'
    return false
  }
  const current = capture()
  const changes = Object.fromEntries(
    Object.entries(entries(current)).filter(([key, value]) => value !== expected[key]),
  )
  applying.value = true
  try {
    commitPreferences(localStorage, changes, expected)
    expected = { ...expected, ...changes }
    applied.value = current
    appearance.warning = fonts.warning = ''
    // Local appearance preferences are committed atomically. Git runtime settings
    // are saved separately; a runtime error must not imply they were rolled back.
    if (gitSettings.value?.dirty && !(await gitSettings.value.apply())) {
      error.value = 'Git 设置未保存，请检查配置。已应用的外观和字体设置会保留。'
      section.value = 'git'
      return false
    }
    saved.value = true
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法保存设置，请重试。'
    return false
  } finally {
    applying.value = false
  }
}
let returnFocus: HTMLElement | null = null
let finished = false
onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  dialog.value
    ?.querySelector<HTMLElement>('.preferences-tabs [aria-selected="true"]')
    ?.focus({ preventScroll: true })
  const body = dialog.value?.querySelector('.preferences-body')
  if (body) {
    scrollResize = new ResizeObserver(updateScrollHint)
    scrollResize.observe(body)
    scrollMutation = new MutationObserver(updateScrollHint)
    scrollMutation.observe(body, { childList: true, subtree: true, characterData: true })
  }
  dialog.value?.addEventListener('scroll', updateScrollHint, true)
  updateScrollHint()
})
function close() {
  if (pending.value) return
  restore()
  finished = true
  dialog.value?.close()
  emit('close')
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
}
async function confirm() {
  if (await apply()) close()
}
function dialogKey(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.key !== 'Enter' ||
    event.altKey
  )
    return
  const target = event.target as HTMLElement
  const popup = target.closest('dialog, [role="dialog"], [role="listbox"], [role="menu"]')
  if (popup && popup !== dialog.value) return
  const command = event.ctrlKey || event.metaKey
  if (!command && (target.isContentEditable || target.closest('button, select, summary, textarea')))
    return
  event.preventDefault()
  void confirm()
}
onUnmounted(() => {
  scrollResize?.disconnect()
  scrollMutation?.disconnect()
  dialog.value?.removeEventListener('scroll', updateScrollHint, true)
  if (!finished) restore()
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="dialog preferences-dialog"
      aria-labelledby="preferences-title"
      @cancel.prevent="close"
      @keydown="dialogKey"
      :aria-busy="pending"
    >
      <div class="dialog-content">
        <header class="preferences-header">
          <h2 id="preferences-title">设置</h2>
          <button
            class="icon-button"
            aria-label="关闭设置"
            :disabled="pending"
            @click="close"
          >
            <Icon
              name="X"
              :size="16"
            />
          </button>
        </header>
        <div
          class="preferences-body"
          :class="{ 'has-more-below': hasMoreBelow }"
          :inert="applying"
        >
          <nav
            class="preferences-tabs"
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
            @keydown="tabKey"
          >
            <button
              id="settings-appearance-tab"
              role="tab"
              :aria-selected="section === 'appearance'"
              :tabindex="section === 'appearance' ? 0 : -1"
              aria-controls="settings-appearance-panel"
              @click="section = 'appearance'"
            >
              外观
            </button>
            <button
              id="settings-fonts-tab"
              role="tab"
              :aria-selected="section === 'fonts'"
              :tabindex="section === 'fonts' ? 0 : -1"
              aria-controls="settings-fonts-panel"
              @click="section = 'fonts'"
            >
              字体
            </button>
            <button
              id="settings-repository-tab"
              role="tab"
              :aria-selected="section === 'repository'"
              :tabindex="section === 'repository' ? 0 : -1"
              aria-controls="settings-repository-panel"
              @click="section = 'repository'"
            >
              当前仓库
            </button>
            <button
              id="settings-git-tab"
              role="tab"
              :aria-selected="section === 'git'"
              :tabindex="section === 'git' ? 0 : -1"
              aria-controls="settings-git-panel"
              @click="section = 'git'"
            >
              Git
            </button>
          </nav>
          <div
            v-show="section === 'appearance'"
            id="settings-appearance-panel"
            role="tabpanel"
            aria-labelledby="settings-appearance-tab"
          >
            <section aria-labelledby="preferences-appearance-title">
              <h3 id="preferences-appearance-title">外观</h3>
              <ThemePicker v-model="theme" />
              <p
                v-if="appearance.warning"
                class="directory-error"
                role="alert"
              >
                {{ appearance.warning }}
              </p>
            </section>
            <section
              class="preferences-graph"
              aria-labelledby="preferences-graph-title"
            >
              <h3 id="preferences-graph-title">提交关系图</h3>
              <label class="preferences-row"
                ><span>标签样式</span
                ><select
                  v-model="style"
                  aria-label="标签样式"
                >
                  <option value="current">GitCode 风格</option>
                  <option value="gitkraken">GitKraken 风格</option>
                  <option value="idea">IDEA 风格</option>
                </select></label
              >
              <label class="preferences-row"
                ><span>标签位置</span
                ><select
                  v-model="afterMessage"
                  aria-label="标签位置"
                >
                  <option :value="false">关系图左侧</option>
                  <option :value="true">提交说明后 · 靠右</option>
                </select></label
              >
              <label class="preferences-check"
                ><input
                  v-model="longEdges"
                  type="checkbox"
                /><span>展开长连线</span></label
              >
              <label class="preferences-check"
                ><input
                  v-model="dimMerges"
                  type="checkbox"
                /><span>淡化合并提交</span></label
              >
            </section>
            <p
              v-if="graph.warning"
              class="directory-error"
              role="alert"
            >
              {{ graph.warning }}
            </p>
          </div>
          <div
            v-show="section === 'fonts'"
            id="settings-fonts-panel"
            role="tabpanel"
            aria-labelledby="settings-fonts-tab"
          >
            <FontSettings
              v-if="fontsVisited"
              ref="fontSettings"
              deferred
            />
          </div>
          <div
            v-show="section === 'repository'"
            id="settings-repository-panel"
            role="tabpanel"
            aria-labelledby="settings-repository-tab"
          >
            <template v-if="section === 'repository' && !store.isNewTab && store.connected">
              <p class="preferences-intro repository-identity">
                当前仓库：<strong>{{ store.repo.name }}</strong
                ><br />{{ store.repo.path }}
              </p>
              <p class="preferences-hint">
                此页的保存与仓库操作立即生效，不随外观或字体预览的取消而撤销。
              </p>
              <RepositoryFetchSettings />
            </template>
            <p
              v-else
              class="preferences-intro"
            >
              打开并连接仓库后，可调整该仓库的分支获取范围与历史深度。
            </p>
          </div>
          <div
            v-show="section === 'git'"
            id="settings-git-panel"
            role="tabpanel"
            aria-labelledby="settings-git-tab"
          >
            <GitRuntimeSettings
              v-if="gitVisited && canConfigureGit"
              ref="gitSettings"
            />
            <p
              v-if="!canConfigureGit"
              class="preferences-intro"
            >
              连接本地 Git 服务后可配置 Git 运行环境。
            </p>
          </div>
        </div>
        <p
          v-if="error"
          class="directory-error preferences-feedback"
          role="alert"
        >
          {{ error }}
        </p>
        <footer class="dialog-actions">
          <span
            class="preferences-save-state"
            aria-live="polite"
            >{{ saveState }}</span
          >
          <button
            v-for="action in footerActions"
            :key="action"
            type="button"
            :class="action === 'confirm' ? 'primary-button' : 'secondary-button'"
            :disabled="pending || (action === 'apply' && !dirty)"
            @click="action === 'confirm' ? confirm() : action === 'apply' ? apply() : close()"
          >
            {{ footerLabels[action] }}
          </button>
        </footer>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.preferences-dialog {
  inset: 38px 0 0;
  width: min(920px, calc(100vw - 32px));
  height: min(740px, calc(100dvh - 54px));
  max-height: calc(100dvh - 54px);
  overflow: hidden;
}
.preferences-dialog > .dialog-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: calc(100dvh - 34px);
  min-height: 0;
  padding: 0;
}
.preferences-header,
.dialog-actions {
  flex-shrink: 0;
}
.preferences-body > [role='tabpanel'] {
  min-height: 0;
  overflow: auto;
  padding: 20px;
}
#settings-fonts-panel {
  overflow: auto;
}
.repository-identity {
  overflow-wrap: anywhere;
}
.preferences-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--line);
}
.preferences-body {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.preferences-header h2 {
  margin: 0;
}
.preferences-header .icon-button {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
}
.preferences-tabs {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 12px 8px;
  border-right: 1px solid var(--line);
  background: var(--panel);
}
.preferences-tabs button {
  justify-content: flex-start;
  min-height: max(30px, calc(var(--ui-font-size) * 1.5 + 8px));
  padding: 4px 12px;
  border-radius: 4px;
  color: var(--text-secondary);
}
.preferences-tabs button[aria-selected='true'] {
  color: var(--view-selection-color);
  background: var(--view-selection-bg);
}
.preferences-intro {
  font-size: var(--dialog-font-help);
  color: var(--muted);
  line-height: 1.5;
  margin: 8px 0 16px;
}
h3 {
  font-size: var(--dialog-font-body);
  margin: 0 0 16px;
}
.preferences-graph {
  border-top: 1px solid var(--line);
  margin-top: 24px;
  padding-top: 24px;
}
.preferences-row {
  display: grid;
  grid-template-columns: var(--settings-label-width) minmax(0, var(--settings-field-width));
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
.preferences-row select {
  width: 100%;
  min-width: 0;
  min-height: var(--settings-control-height);
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface-input);
  color: var(--text);
  font: inherit;
  color-scheme: inherit;
}
.preferences-row select:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.preferences-check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  margin-top: 8px;
}
.preferences-check input {
  width: auto;
  margin: 0;
  accent-color: var(--accent);
}
.preferences-hint {
  font-size: var(--dialog-font-help);
  color: var(--muted);
  margin: 6px 0 0 22px;
  line-height: 1.6;
}
.dialog-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--button-gap);
  padding: 10px 20px;
  margin: 0;
  border-top: 1px solid var(--line);
}
.preferences-save-state {
  flex: 1;
  min-width: 150px;
  color: var(--muted);
  font-size: var(--dialog-font-help);
}
.preferences-feedback {
  margin: 8px 20px;
}
@media (max-width: 760px) {
  .preferences-body {
    grid-template-columns: 112px minmax(0, 1fr);
  }
  .preferences-body > [role='tabpanel'] {
    padding: 12px;
  }
  .preferences-tabs button {
    padding: 4px 8px;
  }
}
</style>
