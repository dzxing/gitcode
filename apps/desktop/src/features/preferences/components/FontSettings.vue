<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useFontStore } from '../stores/fonts'
import {
  bundledFonts,
  commonSystemFonts,
  canonicalFontFamily,
  fontDefaults,
  fontStack,
  normalizeFonts,
  validFontFamily,
  type FontPreferences,
} from '../fontPreferences'
import { getFontAccess, fontReadError } from '../../../infrastructure/fonts'
import FontPicker from './FontPicker.vue'

const props = withDefaults(defineProps<{ deferred?: boolean }>(), { deferred: false })
const fonts = useFontStore()
const root = ref<HTMLElement>()
const activeGroup = ref<'ui' | 'code'>('ui')
function setFont(group: 'ui' | 'code', patch: Partial<FontPreferences['code']>) {
  fonts.set(group, patch, !props.deferred)
}
function fontTabKey(event: KeyboardEvent) {
  if (event.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  activeGroup.value =
    event.key === 'Home'
      ? 'ui'
      : event.key === 'End'
        ? 'code'
        : activeGroup.value === 'ui'
          ? 'code'
          : 'ui'
  void nextTick(() => document.getElementById(`font-${activeGroup.value}-tab`)?.focus())
}
const groups = ['ui', 'code'] as const
const draft = reactive(normalizeFonts(fonts.settings))
const installed = ref<string[] | null>(null)
const loading = ref(false),
  listError = ref(''),
  inputError = ref('')
const choices = computed(() =>
  [
    ...new Set(
      [...bundledFonts, ...commonSystemFonts, ...(installed.value || [])].map(canonicalFontFamily),
    ),
  ].sort((a, b) => a.localeCompare(b)),
)
watch(
  () => fonts.settings,
  (value, previous) => {
    for (const group of groups) {
      for (const field of ['family', 'fallback'] as const) {
        const label = `${group === 'ui' ? '界面' : '编辑器'}${field === 'family' ? '主字体' : '后备字体'}`
        if (
          value[group][field] !== previous[group][field] &&
          document.activeElement?.getAttribute('aria-label') !== label
        )
          draft[group][field] = value[group][field]
      }
    }
  },
  { deep: true },
)
const access = computed(getFontAccess)
const denied = ref(false)
async function loadFonts() {
  if (loading.value || installed.value !== null || denied.value || access.value.limitation) return
  loading.value = true
  listError.value = ''
  try {
    installed.value = [
      ...new Set((await access.value.read()).filter(validFontFamily).map(canonicalFontFamily)),
    ]
  } catch (error) {
    denied.value = error instanceof DOMException && error.name === 'NotAllowedError'
    listError.value = fontReadError(error, access.value.source)
  } finally {
    loading.value = false
  }
}
function saveFamily(group: 'ui' | 'code', field: 'family' | 'fallback', validate = true) {
  const value = draft[group][field].trim()
  if (!validFontFamily(value)) {
    if (validate) inputError.value = '请输入有效的字体名称（最多 120 个字符）。'
    return
  }
  inputError.value = ''
  setFont(group, { [field]: value })
}
function numeric(
  event: Event,
  group: 'ui' | 'code',
  field: 'size' | 'lineHeight',
  validate = true,
) {
  const input = event.target as HTMLInputElement,
    value = input.valueAsNumber
  if (!input.validity.valid || !Number.isFinite(value)) {
    if (!validate) return
    inputError.value =
      field === 'size'
        ? group === 'ui'
          ? '界面字号范围为 11–16px，使用整数。'
          : '编辑器字号范围为 10–24px，使用整数。'
        : '行高范围为 1.2–2.2。'
    input.value = String(
      field === 'lineHeight' ? fonts.settings.code.lineHeight : fonts.settings[group].size,
    )
    return
  }
  inputError.value = ''
  setFont(group, { [field]: value })
}
function missing(group: 'ui' | 'code') {
  return (
    fonts.settings[group].enabled &&
    installed.value !== null &&
    ![...bundledFonts, ...installed.value].some(
      (name) =>
        canonicalFontFamily(name).toLocaleLowerCase() ===
        canonicalFontFamily(fonts.settings[group].family).toLocaleLowerCase(),
    )
  )
}
function preview(group: 'ui' | 'code') {
  const ui = fonts.settings.ui.enabled ? fonts.settings.ui : fontDefaults.ui
  const code = fonts.settings.code.enabled ? fonts.settings.code : fontDefaults.code
  return group === 'code'
    ? {
        fontFamily: fontStack(code, true),
        fontSize: `${code.size}px`,
        lineHeight: code.lineHeight,
        fontVariantLigatures: code.ligatures ? 'normal' : 'none',
      }
    : {
        fontFamily: fontStack(ui),
        fontSize: `${ui.size}px`,
        lineHeight: 1.5,
      }
}
function reset(group: 'ui' | 'code') {
  inputError.value = ''
  fonts.reset(group, !props.deferred)
  draft[group].family = fonts.settings[group].family
  draft[group].fallback = fonts.settings[group].fallback
}
function validate() {
  for (const group of groups) {
    if (!fonts.settings[group].enabled) continue
    for (const field of ['family', 'fallback'] as const) {
      if (!validFontFamily(draft[group][field].trim())) {
        activeGroup.value = group
        inputError.value = '请输入有效的字体名称（最多 120 个字符）。'
        const label = `${group === 'ui' ? '界面' : '编辑器'}${field === 'family' ? '主字体' : '后备字体'}`
        void nextTick(() =>
          root.value?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.focus(),
        )
        return false
      }
    }
  }
  const invalid = root.value?.querySelector<HTMLInputElement>('input:invalid')
  if (invalid) {
    activeGroup.value =
      invalid.closest<HTMLElement>('[data-font-group]')?.dataset.fontGroup === 'code'
        ? 'code'
        : 'ui'
    inputError.value = '请检查字号或行高，输入范围内的数值。'
    void nextTick(() => invalid.focus())
    return false
  }
  inputError.value = ''
  return true
}
defineExpose({ validate })
onMounted(() => {
  if (access.value.source === 'desktop') void loadFonts()
})
</script>

<template>
  <div
    ref="root"
    class="font-settings"
  >
    <p
      v-if="listError"
      class="directory-error"
      role="status"
    >
      {{ listError }}
    </p>
    <nav
      class="font-tabs"
      role="tablist"
      aria-label="字体用途"
      @keydown="fontTabKey"
    >
      <button
        v-for="group in groups"
        :id="`font-${group}-tab`"
        :key="group"
        role="tab"
        :aria-controls="`font-${group}-panel`"
        :aria-selected="activeGroup === group"
        :tabindex="activeGroup === group ? 0 : -1"
        @click="activeGroup = group"
      >
        {{ group === 'ui' ? '界面' : '编辑器' }}
      </button>
    </nav>
    <section
      v-for="group in groups"
      v-show="activeGroup === group"
      :id="`font-${group}-panel`"
      role="tabpanel"
      :aria-labelledby="`font-${group}-tab`"
      :data-font-group="group"
      :key="group"
      :aria-label="group === 'ui' ? '界面字体' : '编辑器字体'"
      class="font-group"
    >
      <div class="font-controls">
        <header>
          <h3>{{ group === 'ui' ? '界面字体' : '编辑器字体' }}</h3>
          <button
            class="text-button"
            @click="reset(group)"
          >
            恢复{{ group === 'ui' ? '界面' : '编辑器' }}字体默认值
          </button>
        </header>
        <p>
          {{
            group === 'ui'
              ? '用于菜单、导航、文件列表等界面文字。'
              : '用于代码、差异、提交说明和关系图分支标签。'
          }}
        </p>
        <label class="font-enable"
          ><input
            type="checkbox"
            :checked="fonts.settings[group].enabled"
            @change="setFont(group, { enabled: ($event.target as HTMLInputElement).checked })"
          />使用自定义{{ group === 'ui' ? '界面' : '编辑器' }}字体</label
        >
        <p
          v-if="!fonts.settings[group].enabled"
          class="font-hint"
        >
          勾选“使用自定义{{ group === 'ui' ? '界面' : '编辑器' }}字体”后，可选择字体并调整字号。
        </p>
        <fieldset :disabled="!fonts.settings[group].enabled">
          <legend class="gitflow-sr-only">
            {{ group === 'ui' ? '界面字体配置' : '编辑器字体配置' }}
          </legend>
          <label
            >主字体<FontPicker
              v-model="draft[group].family"
              :label="`${group === 'ui' ? '界面' : '编辑器'}主字体`"
              :choices="choices"
              :disabled="!fonts.settings[group].enabled"
              @open="loadFonts"
              @input="saveFamily(group, 'family', false)"
              @change="saveFamily(group, 'family')"
          /></label>
          <label
            >后备字体<FontPicker
              v-model="draft[group].fallback"
              :label="`${group === 'ui' ? '界面' : '编辑器'}后备字体`"
              :choices="choices"
              :disabled="!fonts.settings[group].enabled"
              @open="loadFonts"
              @input="saveFamily(group, 'fallback', false)"
              @change="saveFamily(group, 'fallback')"
          /></label>
          <label
            >字号（px）<input
              type="number"
              :value="fonts.settings[group].size"
              :min="group === 'ui' ? 11 : 10"
              :max="group === 'ui' ? 16 : 24"
              step="1"
              required
              :aria-label="`${group === 'ui' ? '界面' : '编辑器'}字号`"
              @input="numeric($event, group, 'size', false)"
              @change="numeric($event, group, 'size')"
          /></label>
          <template v-if="group === 'code'">
            <label
              >行高（倍）<input
                type="number"
                :value="fonts.settings.code.lineHeight"
                min="1.2"
                max="2.2"
                step="0.05"
                required
                aria-label="编辑器行高"
                @input="numeric($event, 'code', 'lineHeight', false)"
                @change="numeric($event, 'code', 'lineHeight')"
            /></label>
            <label class="font-enable"
              ><input
                type="checkbox"
                :checked="fonts.settings.code.ligatures"
                @change="
                  setFont('code', { ligatures: ($event.target as HTMLInputElement).checked })
                "
              />启用编辑器连字</label
            >
          </template>
        </fieldset>
        <p
          v-if="missing(group)"
          class="directory-error"
          role="status"
        >
          读取的字体列表中未包含所选主字体；若无法显示，将使用后备字体。可保留设置，安装字体后重新启动应用。
        </p>
        <p class="font-hint">后备字体用于补充主字体缺少的字符，例如中文。</p>
      </div>
      <div
        v-if="group === 'ui'"
        class="font-preview"
        :style="preview('ui')"
        aria-label="界面字体预览"
      >
        文件 编辑 视图 · 仓库导航 Repository · 工作区变更 · 提交历史 Commit history · 0123456789
      </div>
      <pre
        v-else-if="fonts.settings.code.enabled"
        class="font-preview"
        :style="preview('code')"
        aria-label="编辑器字体预览"
      >
const branch = 'feature/login';
// 中文注释 · 0123456789 · O0 Il1
if (local !== remote) return merge(local);</pre>
      <p
        v-else
        class="font-preview font-hint font-default-state"
      >
        当前沿用各区域默认显示。启用自定义编辑器字体后，可统一设置并预览。
      </p>
    </section>
    <p
      v-if="inputError || fonts.warning"
      class="directory-error"
      role="alert"
    >
      {{ inputError || fonts.warning }}
    </p>
  </div>
</template>

<style scoped>
.font-settings {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.font-settings > p,
.font-tabs {
  flex-shrink: 0;
}
.font-controls {
  min-height: 0;
}
.font-tabs {
  display: flex;
  gap: 4px;
  margin-top: 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line);
}
.font-tabs button {
  min-height: 30px;
  padding: 5px 16px;
  border-radius: 4px;
}
.font-tabs button[aria-selected='true'] {
  background: var(--view-selection-bg);
  color: var(--view-selection-color);
}
.font-controls > p {
  font-size: var(--dialog-font-help);
  color: var(--muted);
  line-height: 1.5;
  margin: 6px 0 12px;
}
.font-group {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 16px;
  padding-top: 0;
}
.font-group header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  font-size: var(--dialog-font-body);
  margin: 0;
}
.font-group header button {
  flex-shrink: 0;
  font-size: var(--dialog-font-help);
}
.font-enable {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}
.font-enable input {
  width: auto;
  margin: 0;
  accent-color: var(--accent);
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
fieldset > label:not(.font-enable) {
  display: grid;
  grid-template-columns: var(--settings-label-width, 96px) minmax(
      0,
      var(--settings-field-width, 320px)
    );
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
fieldset input:not([type='checkbox']) {
  min-width: 0;
  width: 100%;
  min-height: var(--settings-control-height, 28px);
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--settings-input-bg, var(--panel));
  color: var(--text);
  font: inherit;
}
fieldset:disabled {
  color: var(--control-disabled-color);
}
fieldset input:disabled {
  opacity: 1;
  color: var(--control-disabled-color);
}
fieldset input[type='number'] {
  width: 80px;
  max-width: 100%;
}
.font-preview {
  flex-shrink: 0;
  height: 120px;
  margin: 16px 0 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  overflow: auto;
  min-height: 72px;
  max-height: 160px;
}
.font-preview:not(pre) {
  height: auto;
  min-height: 72px;
  overflow-wrap: anywhere;
}
pre {
  height: clamp(120px, calc(var(--code-font-size) * var(--code-line-height) * 4 + 26px), 240px);
  max-height: 240px;
  margin-bottom: 0;
  tab-size: 4;
}
input:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
</style>
