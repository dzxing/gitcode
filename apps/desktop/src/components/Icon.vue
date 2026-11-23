<script setup lang="ts">
import { computed } from 'vue'
import { materialSymbol, type IconName } from '../materialSymbols'

const props = defineProps<{ name: IconName; size?: number; filled?: boolean }>()
const symbol = computed(() => materialSymbol(props.name, props.filled))
</script>

<template>
  <svg
    class="ui-icon"
    :data-icon="name"
    :data-symbol="symbol.name"
    :width="size || 16"
    :height="size || 16"
    :viewBox="symbol.viewBox"
    preserveAspectRatio="xMidYMid meet"
    fill="currentColor"
    stroke="none"
    aria-hidden="true"
  >
    <path
      v-for="(path, index) in symbol.paths"
      :key="index"
      :d="path"
    />
  </svg>
</template>
