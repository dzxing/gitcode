<script setup lang="ts">
import compactMark from '@gitcode/brand/assets/logo-ui-compact.svg'
import detailedMark from '@gitcode/brand/assets/logo-glyph-transparent.svg'
withDefaults(defineProps<{ size?: number; showMark?: boolean }>(), { size: 24, showMark: true })
</script>
<template>
  <span class="app-brand">
    <img
      v-if="showMark"
      class="brand-mark"
      :src="size <= 32 ? compactMark : detailedMark"
      :width="size"
      :height="size"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
    <span class="brand-wordmark">GitCode</span>
  </span>
</template>
<style scoped>
.app-brand {
  display: inline-flex;
  align-items: center;
  gap: var(--brand-mark-gap, 8px);
  flex-shrink: 0;
}
.brand-mark {
  display: block;
  flex: none;
  object-fit: contain;
}
.brand-wordmark {
  font-family: var(--font-ui-custom, 'Inter', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--brand-type-size, inherit);
  font-weight: 650;
  letter-spacing: -0.045em;
  line-height: 1.1;
  color: var(--brand-ink, #edf5ff);
  white-space: nowrap;
}
</style>
