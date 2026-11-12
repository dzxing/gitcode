<script setup lang="ts">
import { useRepositoryStore } from '../stores/repository'
import { useStashStore } from '../stores/stash'
import Icon from './Icon.vue'
const stash = useStashStore()
const repository = useRepositoryStore()
</script>
<template>
  <button
    :disabled="!!stash.createBlocked"
    :title="stash.createBlocked || '直接贮藏全部符合范围的修改；选项位于右侧贮藏页签'"
    aria-label="贮藏当前修改"
    @click="stash.create"
  >
    <span class="toolbar-action-icon"
      ><Icon
        :name="
          repository.busy && repository.activeOperation === 'stash-create'
            ? 'LoaderCircle'
            : 'Archive'
        "
        :class="{ spin: repository.busy && repository.activeOperation === 'stash-create' }"
        :size="19" /></span
    ><span>贮藏</span>
  </button>
</template>
