<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed } from 'vue'
import { useFileViewStore } from '../stores/fileView'
import { useRepositoryStore } from '../stores/repository'
import type { FileChange } from '../types'
import Icon from './Icon.vue'
import { useContextMenuStore } from '../stores/contextMenu'
const menu = useContextMenuStore()

const props = defineProps<{ files: FileChange[]; staged?: boolean; historical?: boolean }>()
const store = useRepositoryStore(),
  view = useFileViewStore()
const mode = computed(() => view.modes[props.historical ? 'history' : 'worktree'])
const name = (path: string) => path.split('/').pop()
const directory = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const fullPath = (file: FileChange) => (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)
const statusTitle: Record<string, string> = {
  M: '已修改',
  A: '新增',
  '?': '未跟踪',
  D: '已删除',
  R: '重命名',
  U: '合并冲突',
  T: '类型变更',
}
</script>

<template>
  <div
    class="file-list"
    :class="`file-list-${mode}`"
  >
    <div
      v-for="file in files"
      :key="file.path"
      class="file-row"
      :class="{
        selected:
          store.selectedFile?.path === file.path && (historical || store.fileStaged === !!staged),
      }"
    >
      <button
        class="file-main"
        v-overflow-title="{
          text: menu.hoverTitle(fullPath(file)),
          target: '.file-basename, .file-directory',
        }"
        :aria-label="`查看文件差异 ${fullPath(file)}`"
        :data-file-path="file.path"
        :data-file-staged="!!staged"
        :data-file-historical="!!historical"
        @click="store.selectFile(file, staged, $event.currentTarget as HTMLElement)"
        @contextmenu="
          historical && store.selectedCommit
            ? menu.open($event, {
                kind: 'historical-file',
                path: file.path,
                revision: store.selectedCommit.hash,
              })
            : undefined
        "
        @keydown="
          historical && store.selectedCommit
            ? menu.keyboard($event, {
                kind: 'historical-file',
                path: file.path,
                revision: store.selectedCommit.hash,
              })
            : undefined
        "
      >
        <Icon
          name="FileCode2"
          :size="14"
        /><span
          class="file-name"
          :class="{ 'has-directory': directory(file.path) }"
          ><span class="file-basename">{{ name(file.path) }}</span
          ><small
            v-if="directory(file.path)"
            class="file-directory"
            >{{ directory(file.path) }}</small
          ></span
        ><span
          class="file-full-path"
          aria-hidden="true"
          >{{ fullPath(file) }}</span
        ><span
          class="file-status"
          :class="`status-${file.status[0]}`"
          :title="statusTitle[file.status[0]!] || file.status"
          >{{ file.status === '?' ? 'U' : file.status[0] }}</span
        >
      </button>
      <button
        v-if="!historical"
        class="icon-button file-action"
        :disabled="store.busy"
        :title="staged ? '取消暂存' : '暂存文件'"
        :aria-label="`${staged ? '取消暂存' : '暂存'} ${file.path}`"
        @click="store.run(staged ? 'unstage' : 'stage', { paths: [file.path] })"
      >
        <Icon
          :name="staged ? 'Minus' : 'Plus'"
          :size="14"
        />
      </button>
    </div>
  </div>
</template>
