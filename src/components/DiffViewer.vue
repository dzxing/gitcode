<script setup lang="ts">
import { computed } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import { useStashStore } from '../stores/stash'

const store = useRepositoryStore()
const stash = useStashStore()
const lines = computed(() => {
  let old = 0,
    next = 0
  return store.diffText.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
    if (hunk) {
      old = Number(hunk[1])
      next = Number(hunk[2])
      return { text, type: 'hunk', old: '', next: '' }
    }
    if (
      text.startsWith('+++') ||
      text.startsWith('---') ||
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file')
    )
      return { text, type: 'meta', old: '', next: '' }
    const type = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context'
    if (!old && !next) return { text, type: 'meta', old: '', next: '' }
    if (text.startsWith('\\')) return { text, type: 'meta', old: '', next: '' }
    return { text, type, old: type === 'add' ? '' : old++, next: type === 'remove' ? '' : next++ }
  })
})
const stats = computed(() => ({
  add: lines.value.filter((l) => l.type === 'add').length,
  remove: lines.value.filter((l) => l.type === 'remove').length,
}))
const baseName = computed(() => store.selectedFile?.path.split('/').pop())
const hasStagedVersion = computed(
  () =>
    !!store.selectedFile &&
    store.repo.staged.some((file) => file.path === store.selectedFile!.path),
)
function retryDiff() {
  if (!store.selectedFile) return
  if (store.selectedStash) void stash.preview(store.selectedFile.path, store.stashDiffSource)
  else if (store.fileDiffSource)
    void store.selectWorktreeFile(store.selectedFile, store.fileDiffSource)
  else void store.selectFile(store.selectedFile, store.fileStaged)
}
</script>

<template>
  <section
    class="diff-panel"
    aria-label="文件差异"
  >
    <header class="diff-heading">
      <div>
        <Icon
          name="FileCode2"
          :size="15"
        /><strong :title="store.selectedFile?.path">{{ baseName }}</strong
        ><span class="diff-kind">{{
          store.selectedStash
            ? store.stashDiffSource === 'staged'
              ? '贮藏 · 原暂存'
              : '贮藏 · 工作版本'
            : store.selectedCommit
              ? store.selectedCommit.hash.slice(0, 7)
              : store.fileStaged
                ? '已暂存'
                : store.fileDiffSource === 'working'
                  ? '完整改动'
                  : '工作区'
        }}</span>
      </div>
      <div v-if="!store.diffError">
        <span class="add-count">+{{ stats.add }}</span
        ><span class="remove-count">−{{ stats.remove }}</span>
      </div>
      <button
        class="icon-button"
        aria-label="关闭差异预览"
        title="关闭差异预览"
        @click="store.closeDiff()"
      >
        <Icon
          name="X"
          :size="15"
        />
      </button>
    </header>
    <div class="diff-path">{{ store.selectedFile?.path }}</div>
    <div
      v-if="store.selectedStash && stash.details?.indexDiff"
      class="diff-source-switch"
      role="group"
      aria-label="贮藏差异来源"
    >
      <button
        :aria-pressed="store.stashDiffSource === 'working'"
        :disabled="store.diffLoading"
        @click="stash.setSource('working')"
      >
        完整工作区版本</button
      ><button
        :aria-pressed="store.stashDiffSource === 'staged'"
        :disabled="store.diffLoading"
        @click="stash.setSource('staged')"
      >
        原暂存内容
      </button>
    </div>
    <div
      v-if="
        !store.selectedStash && store.fileDiffSource && !store.selectedCommit && hasStagedVersion
      "
      class="diff-source-switch"
      role="group"
      aria-label="差异内容来源"
    >
      <button
        :aria-pressed="store.fileDiffSource === 'working'"
        :disabled="store.diffLoading"
        title="HEAD 到当前工作区，包含已暂存和未暂存改动"
        @click="store.selectedFile && store.selectWorktreeFile(store.selectedFile, 'working')"
      >
        完整改动
      </button>
      <button
        :aria-pressed="store.fileDiffSource === 'staged'"
        :disabled="store.diffLoading"
        title="HEAD 到暂存区"
        @click="store.selectedFile && store.selectWorktreeFile(store.selectedFile, 'staged')"
      >
        暂存内容
      </button>
    </div>
    <div
      v-if="store.diffLoading"
      class="empty-state compact"
    >
      <Icon
        name="LoaderCircle"
        class="spin"
      /><span>正在读取差异…</span>
    </div>
    <div
      v-else-if="store.diffError"
      class="read-error"
      role="alert"
    >
      <strong>读取差异失败</strong>
      <p>{{ store.diffError }}</p>
      <button
        class="secondary-button"
        :disabled="store.busy"
        @click="retryDiff"
      >
        重试读取差异
      </button>
    </div>
    <div
      v-else-if="!store.diffText"
      class="empty-state compact"
    >
      <Icon name="FileText" /><span>没有可显示的文本差异</span
      ><small>文件可能为二进制、子模块，或已无内容变更。</small>
    </div>
    <div
      v-else
      class="diff-scroll"
    >
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="diff-line"
        :class="line.type"
      >
        <span class="line-number">{{ line.old }}</span
        ><span class="line-number">{{ line.next }}</span
        ><code>{{ line.text || ' ' }}</code>
      </div>
      <p
        v-if="store.diffTruncated"
        class="diff-truncated"
      >
        内容较大，仅显示前 300,000 字符。
      </p>
    </div>
  </section>
</template>

<style scoped>
.diff-source-switch {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--line-soft);
}
.diff-source-switch button {
  min-height: 24px;
  padding: 0 8px;
  border-radius: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.diff-source-switch button[aria-pressed='true'] {
  background: var(--view-selection-bg);
  color: var(--view-selection-color);
}
.diff-source-switch button:not(:disabled):hover {
  background: var(--control-hover-bg);
}
</style>
