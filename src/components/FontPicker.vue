<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'
import {
  bundledFonts,
  commonSystemFonts,
  canonicalFontFamily,
  fontDisplayName,
} from '../fontPreferences'

const bundled = new Set(bundledFonts)
const system = new Set(commonSystemFonts)

const props = defineProps<{
  modelValue: string
  label: string
  choices: string[]
  disabled: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  input: []
  change: []
  open: []
}>()
const root = ref<HTMLElement>(),
  input = ref<HTMLInputElement>(),
  popup = ref<HTMLElement>(),
  search = ref<HTMLInputElement>()
const open = ref(false),
  query = ref(''),
  active = ref(-1)
const popupStyle = ref<Record<string, string>>({})
let anchor: DOMRect | undefined
const id = useId(),
  listId = `font-list-${id}`
const filtered = computed(() => {
  const value = query.value.trim().toLocaleLowerCase()
  return value
    ? props.choices.filter((name) => fontDisplayName(name).toLocaleLowerCase().includes(value))
    : props.choices
})
function close(restore = false) {
  open.value = false
  if (restore)
    void nextTick(() => {
      if (!props.disabled) input.value?.focus({ preventScroll: true })
    })
}
async function reveal() {
  if (props.disabled || !root.value) return
  emit('open')
  query.value = ''
  active.value = props.choices.findIndex(
    (name) =>
      canonicalFontFamily(name).toLocaleLowerCase() ===
      canonicalFontFamily(props.modelValue).toLocaleLowerCase(),
  )
  if (active.value < 0 && props.choices.length) active.value = 0
  const rect = root.value.getBoundingClientRect(),
    below = innerHeight - rect.bottom - 8,
    above = rect.top - 8
  anchor = rect
  const upwards = below < 220 && above > below
  const height = Math.min(300, Math.max(100, upwards ? above : below))
  const width = Math.min(Math.max(240, rect.width), innerWidth - 16)
  popupStyle.value = {
    left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
    ...(upwards ? { bottom: `${innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` }),
  }
  open.value = true
  await nextTick()
  search.value?.focus({ preventScroll: true })
  scrollActive()
}
function toggle() {
  if (open.value) close(true)
  else void reveal()
}
function scrollActive() {
  const option = document.getElementById(`${listId}-${active.value}`),
    list = option?.parentElement
  if (!option || !list) return
  const a = option.getBoundingClientRect(),
    b = list.getBoundingClientRect()
  if (a.top < b.top) list.scrollTop += a.top - b.top
  else if (a.bottom > b.bottom) list.scrollTop += a.bottom - b.bottom
}
function triggerKey(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    void reveal()
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}
function choose(name: string) {
  if (props.disabled) return
  close()
  emit('update:modelValue', name)
  emit('change')
  void nextTick(() => input.value?.focus({ preventScroll: true }))
}
function edit(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  emit('input')
}
async function filterInput() {
  active.value = filtered.value.length ? 0 : -1
  await nextTick()
  if (open.value) scrollActive()
}
function key(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
    return
  }
  if (event.key === 'Tab') {
    close()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (filtered.value[active.value]) choose(filtered.value[active.value])
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  active.value = Math.max(
    0,
    Math.min(filtered.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)),
  )
  scrollActive()
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
function scroll(event: Event) {
  if (!open.value || popup.value?.contains(event.target as Node)) return
  const rect = root.value?.getBoundingClientRect()
  // A scroll queued before opening may arrive after the popup is visible.
  // Close only when its anchor actually moved; scrolling the option list stays local.
  if (
    !rect ||
    !anchor ||
    Math.abs(rect.top - anchor.top) > 0.5 ||
    Math.abs(rect.left - anchor.left) > 0.5 ||
    Math.abs(rect.width - anchor.width) > 0.5 ||
    Math.abs(rect.height - anchor.height) > 0.5
  )
    close()
}
function dismiss() {
  close()
}
// System fonts may arrive after the list opens; preserve the highlighted family.
watch(filtered, (names, previous) => {
  if (!open.value) return
  const family = previous[active.value] || canonicalFontFamily(props.modelValue)
  const index = names.indexOf(family)
  active.value = index >= 0 ? index : names.length ? 0 : -1
  void nextTick(scrollActive)
})
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', dismiss)
})
</script>

<template>
  <div
    ref="root"
    class="font-picker"
  >
    <div class="font-picker-control">
      <input
        ref="input"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="label"
        role="combobox"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="open ? `font-popup-${id}` : undefined"
        autocomplete="off"
        maxlength="120"
        @input="edit"
        @change="emit('change')"
        @keydown="triggerKey"
      />
      <button
        type="button"
        :disabled="disabled"
        :aria-label="`${open ? '关闭' : '展开'}${label}列表`"
        :aria-expanded="open"
        title="选择字体"
        @click="toggle"
      >
        <Icon
          name="ChevronDown"
          :size="14"
        />
      </button>
    </div>
    <div
      v-if="open"
      :id="`font-popup-${id}`"
      ref="popup"
      class="font-picker-popup"
      role="dialog"
      :aria-label="`选择${label}`"
      :style="popupStyle"
      @keydown="key"
    >
      <input
        ref="search"
        v-model="query"
        type="search"
        autocomplete="off"
        :aria-label="`搜索${label}`"
        placeholder="搜索字体名称…"
        role="combobox"
        :aria-controls="listId"
        aria-expanded="true"
        :aria-activedescendant="active >= 0 ? `${listId}-${active}` : undefined"
        @input="filterInput"
      />
      <div
        :id="listId"
        class="font-picker-options"
        role="listbox"
        :aria-label="`${label}候选字体`"
      >
        <button
          v-for="(name, index) in filtered"
          :id="`${listId}-${index}`"
          :key="name"
          type="button"
          role="option"
          tabindex="-1"
          :aria-selected="
            canonicalFontFamily(name).toLocaleLowerCase() ===
            canonicalFontFamily(modelValue).toLocaleLowerCase()
          "
          :class="{ active: index === active }"
          v-overflow-title="{ text: fontDisplayName(name), target: '.font-picker-name' }"
          :aria-label="fontDisplayName(name)"
          @pointermove="active = index"
          @click="choose(name)"
        >
          <span class="font-picker-name">{{ fontDisplayName(name) }}</span>
          <small
            v-if="bundled.has(name)"
            aria-hidden="true"
            >内置</small
          ><small
            v-else-if="system.has(canonicalFontFamily(name))"
            aria-hidden="true"
            >系统</small
          >
        </button>
      </div>
      <p
        v-if="!filtered.length"
        role="status"
      >
        没有匹配的字体；也可关闭列表后直接输入字体名称。
      </p>
    </div>
  </div>
</template>

<style scoped>
.font-picker {
  width: 100%;
  min-width: 0;
}
.font-picker-control {
  display: flex;
  align-items: center;
  gap: 0;
  min-height: var(--settings-control-height, 32px);
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--settings-input-bg, var(--panel));
  color: var(--text);
}
.font-picker-control input {
  flex: 1;
  width: 0;
  min-width: 0;
  padding: 3px 8px;
  min-height: calc(var(--settings-control-height, 32px) - 2px);
  border: 0;
  border-radius: 4px 0 0 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  outline: none;
}
.font-picker-control button {
  flex: 0 0 28px;
  width: 28px;
  min-height: 30px;
  align-self: stretch;
  border-left: 1px solid var(--line);
  border-radius: 0 4px 4px 0;
}
.font-picker-control:has(input:disabled) {
  color: var(--control-disabled-color);
}
.font-picker-control input:disabled {
  opacity: 1;
}
.font-picker-control:focus-within {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.font-picker-control button:hover:not(:disabled) {
  background: var(--control-hover-bg);
}
.font-picker-popup {
  position: fixed;
  z-index: 160;
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 6px;
  overflow: hidden;
  background: var(--settings-input-bg, var(--panel));
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 5px;
  box-shadow: 0 8px 24px var(--popup-shadow-color);
}
.font-picker-popup > input {
  flex-shrink: 0;
  width: 100%;
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
.font-picker-options {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.font-picker-options button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 30px;
  padding: 5px 8px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 3px;
  font: inherit;
}
.font-picker-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.font-picker-options small {
  flex-shrink: 0;
  color: var(--muted);
  font-size: var(--dialog-font-help);
}
.font-picker-options button[aria-selected='true'] {
  color: var(--text);
  font-weight: 500;
}
.font-picker-options button.active {
  background: var(--view-selection-hover-bg);
  color: var(--view-selection-color);
}
.font-picker-options button.active small {
  color: inherit;
}
.font-picker-popup p {
  margin: 6px;
  color: var(--muted);
  line-height: 1.6;
}
</style>
