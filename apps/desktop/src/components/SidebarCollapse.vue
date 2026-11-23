<script setup lang="ts">
defineProps<{ open: boolean }>()
</script>

<template>
  <div
    class="sidebar-disclosure"
    :class="{ 'is-open': open }"
    :inert="!open"
    :aria-hidden="!open"
  >
    <div class="sidebar-disclosure-inner"><slot /></div>
  </div>
</template>
