<script setup lang="ts">
import { useStashStore } from '../stores/stash'
import Icon from './Icon.vue'
const stash = useStashStore()
</script>
<template>
  <button
    :disabled="!!stash.createBlocked"
    :title="stash.createBlocked || '直接贮藏全部符合范围的修改；选项位于右侧贮藏页签'"
    aria-label="贮藏当前修改"
    @click="stash.create"
  >
    <Icon
      name="Archive"
      :size="19"
    /><span>贮藏</span>
  </button>
</template>
