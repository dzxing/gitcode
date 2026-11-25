<script setup lang="ts">
import Icon from '../../../shared/ui/Icon.vue'
defineProps<{ ahead: number; behind: number }>()
</script>

<template>
  <span class="branch-sync-badge">
    <span
      v-if="ahead"
      class="branch-sync-count is-ahead"
      :aria-label="`领先 ${ahead} 个提交`"
    >
      <Icon
        name="ArrowUp"
        :size="12"
      /><span class="branch-sync-number">{{ ahead }}</span>
    </span>
    <span
      v-if="behind"
      class="branch-sync-count is-behind"
      :aria-label="`落后 ${behind} 个提交`"
    >
      <Icon
        name="ArrowDown"
        :size="12"
      /><span class="branch-sync-number">{{ behind }}</span>
    </span>
  </span>
</template>
