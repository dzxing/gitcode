<script setup lang="ts">
import { focusMenuItem } from '../menuFocus'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

export interface WorkbenchMenuItem {
  id: string
  label: string
  disabled?: boolean
  separator?: boolean
  hint?: string
}
const props = defineProps<{ label: string; x: number; y: number; items: WorkbenchMenuItem[] }>()
const emit = defineEmits<{ select: [id: string]; close: [restore: boolean] }>()
const element = ref<HTMLElement>()
const left = ref(props.x),
  top = ref(props.y)
let observer: MutationObserver | undefined
const buttons = () =>
  Array.from(element.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
function key(event: KeyboardEvent) {
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    emit('close', true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const rows = buttons(),
    index = rows.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
  focusMenuItem(rows[next])
}
function outside(event: PointerEvent) {
  if (!element.value?.contains(event.target as Node)) emit('close', false)
}
function dismiss() {
  emit('close', false)
}
function scroll(event: Event) {
  if (!element.value?.contains(event.target as Node)) dismiss()
}
onMounted(async () => {
  await nextTick()
  if (!element.value) return
  const bounds = element.value.getBoundingClientRect()
  left.value = Math.max(8, Math.min(props.x, innerWidth - bounds.width - 8))
  top.value = Math.max(8, Math.min(props.y, innerHeight - bounds.height - 8))
  buttons()[0]?.focus({ preventScroll: true })
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('blur', dismiss)
  window.addEventListener('resize', dismiss)
  document.addEventListener('scroll', scroll, true)
  observer = new MutationObserver(() => {
    if (document.querySelector('dialog[open]')) dismiss()
  })
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
})
onUnmounted(() => {
  observer?.disconnect()
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('blur', dismiss)
  window.removeEventListener('resize', dismiss)
  document.removeEventListener('scroll', scroll, true)
})
</script>
<template>
  <Teleport to="body">
    <div
      ref="element"
      class="context-menu workbench-context-menu"
      role="menu"
      :aria-label="label"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="key"
      @contextmenu.prevent
    >
      <template
        v-for="item in items"
        :key="item.id"
      >
        <div
          v-if="item.separator"
          class="context-menu-separator"
          role="separator"
        ></div>
        <button
          role="menuitem"
          tabindex="-1"
          :disabled="item.disabled"
          :title="item.hint"
          @click="emit('select', item.id)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>
<style scoped>
.workbench-context-menu {
  z-index: 140;
}
</style>
