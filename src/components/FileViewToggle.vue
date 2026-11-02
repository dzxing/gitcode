<script setup lang="ts">
import { useFileViewStore, type FileViewContext } from '../stores/fileView'
defineProps<{ context: FileViewContext }>()
const view = useFileViewStore()
</script>

<template>
  <div
    class="file-view-toggle"
    role="group"
    aria-label="文件列表显示方式"
    :title="view.warning || undefined"
  >
    <button
      :aria-pressed="view.modes[context] === 'compact'"
      title="单行显示文件名与目录"
      @click="view.setMode(context, 'compact')"
    >
      紧凑
    </button>
    <button
      :aria-pressed="view.modes[context] === 'detailed'"
      title="分两行显示文件名与目录"
      @click="view.setMode(context, 'detailed')"
    >
      详细
    </button>
  </div>
</template>
