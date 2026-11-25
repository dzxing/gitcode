<script setup lang="ts">
import { presentDiff } from '../diffPresentation'
import { vOverflowTitle } from '../../../shared/ui/overflowTitle'
import { useHistoryToolsStore } from '../../history/stores/historyTools'
import { computed, ref } from 'vue'
import { usePartialStage } from '../usePartialStage'
import { useRepositoryStore } from '../../repository/stores/repository'
import Icon from '../../../shared/ui/Icon.vue'
import { useStashStore } from '../../stash/stores/stash'

const store = useRepositoryStore()
const stash = useStashStore()
const diffScroll = ref<HTMLElement>()
const partial = usePartialStage(() => diffScroll.value)
const diff = computed(() =>
  partial.enabled.value && partial.plan.value ? partial.plan.value.diff : store.diffText,
)
const lines = computed(() => presentDiff(diff.value))
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
        /><strong v-overflow-title="store.selectedFile?.path">{{ baseName }}</strong
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
    <div
      v-if="partial.available.value"
      class="partial-toolbar"
      role="group"
      aria-label="局部暂存操作"
    >
      <button
        v-if="!partial.enabled.value"
        class="secondary-button"
        :disabled="store.busy || store.diffLoading"
        @click="partial.enter"
      >
        选择修改
      </button>
      <template v-else>
        <span>{{ partial.plan.value?.source === 'staged' ? '已暂存差异' : '未暂存差异' }}</span>
        <span
          v-if="partial.loading.value"
          role="status"
          >正在读取…</span
        >
        <button
          data-partial-apply
          class="primary-button"
          :disabled="partial.locked.value || !partial.selected.value.size"
          @click="partial.apply()"
        >
          {{ partial.action.value }}所选行<span v-if="partial.selected.value.size"
            >（{{ partial.selected.value.size }}）</span
          >
        </button>
        <button
          class="text-button"
          :disabled="store.busy || partial.loading.value"
          @click="partial.load"
        >
          重新读取
        </button>
        <button
          class="text-button"
          :disabled="store.busy"
          @click="partial.reset"
        >
          退出选择
        </button>
      </template>
    </div>
    <p
      v-if="partial.enabled.value && (partial.error.value || partial.stale.value)"
      class="partial-warning"
      role="alert"
    >
      {{ partial.error.value || '文件或暂存区已变化，请重新读取后再选择。' }}
    </p>
    <p
      v-if="partial.plan.value?.hunks.some((h) => h.hunkOnly)"
      class="partial-note"
    >
      缺少结尾换行的修改块仅支持整块操作。
    </p>
    <div class="diff-path">
      {{ store.selectedFile?.path }}
      <button
        class="text-button"
        @click="
          useHistoryToolsStore().open(
            'file',
            store.selectedFile!.path,
            store.selectedCommit?.hash || store.repo.head,
          )
        "
      >
        显示文件历史
      </button>
      <button
        v-if="!store.selectedCommit && !store.selectedStash"
        class="text-button"
        @click="useHistoryToolsStore().open('three', store.selectedFile!.path, store.repo.head)"
      >
        比较三个版本
      </button>
    </div>
    <div
      v-if="store.selectedStash && stash.details?.indexDiff"
      class="diff-source-switch"
      role="group"
      aria-label="贮藏差异来源"
    >
      <button
        :aria-pressed="store.stashDiffSource === 'working'"
        :disabled="store.diffLoading || store.busy"
        @click="stash.setSource('working')"
      >
        完整工作区版本</button
      ><button
        :aria-pressed="store.stashDiffSource === 'staged'"
        :disabled="store.diffLoading || store.busy"
        @click="stash.setSource('staged')"
      >
        原暂存内容
      </button>
    </div>
    <div
      v-if="!store.selectedStash && !store.selectedCommit && hasStagedVersion"
      class="diff-source-switch"
      role="group"
      aria-label="差异内容来源"
    >
      <button
        v-if="store.repo.unstaged.some((file) => file.path === store.selectedFile?.path)"
        :aria-pressed="!store.fileStaged && store.fileDiffSource !== 'working'"
        :disabled="store.diffLoading || store.busy"
        @click="store.selectedFile && store.selectFile(store.selectedFile, false)"
      >
        未暂存内容
      </button>
      <button
        :aria-pressed="store.fileDiffSource === 'working'"
        :disabled="store.diffLoading || store.busy"
        title="HEAD 到当前工作区，包含已暂存和未暂存改动"
        @click="store.selectedFile && store.selectWorktreeFile(store.selectedFile, 'working')"
      >
        完整改动
      </button>
      <button
        :aria-pressed="store.fileStaged && store.fileDiffSource !== 'working'"
        :disabled="store.diffLoading || store.busy"
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
      ref="diffScroll"
      class="diff-scroll"
      :class="{ 'partial-mode': partial.enabled.value && !!partial.plan.value }"
    >
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="diff-line"
        :class="[
          line.type,
          { 'is-partial-selected': partial.enabled.value && partial.selected.value.has(i) },
        ]"
      >
        <span
          v-if="partial.enabled.value && partial.plan.value"
          class="partial-gutter"
        >
          <input
            v-if="partial.selectable.value.has(i)"
            type="checkbox"
            :data-partial-line="i"
            :aria-label="`选择${line.type === 'add' ? '新增' : '删除'}行 ${line.next || line.old}`"
            :checked="partial.selected.value.has(i)"
            :disabled="partial.locked.value"
            @change="partial.toggle(i)"
          />
        </span>
        <span class="line-number">{{ line.old }}</span
        ><span class="line-number">{{ line.next }}</span
        ><code
          ><template v-if="line.change"
            >{{ line.text.slice(0, line.change.start)
            }}<mark class="diff-fragment">{{
              line.text.slice(line.change.start, line.change.end)
            }}</mark
            >{{ line.text.slice(line.change.end) }}</template
          ><template v-else>{{ line.text || ' ' }}</template></code
        >
        <span
          v-if="partial.enabled.value && partial.hunkMap.value.has(i)"
          class="partial-hunk-actions"
        >
          <button
            :aria-label="`选择修改块 ${partial.hunkMap.value.get(i)!.number}`"
            :aria-pressed="
              partial.hunkMap.value.get(i)!.lines.every((id) => partial.selected.value.has(id))
            "
            :disabled="partial.locked.value"
            @click="partial.toggleHunk(i)"
          >
            选整块
          </button>
          <button
            :aria-label="`${partial.action.value}修改块 ${partial.hunkMap.value.get(i)!.number}`"
            :disabled="partial.locked.value"
            @click="partial.apply(partial.hunkMap.value.get(i)!.lines)"
          >
            {{ partial.action.value }}此块
          </button>
        </span>
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
.partial-toolbar {
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--ui-font-help);
}
.partial-toolbar button {
  min-height: 24px;
  padding: 2px 8px;
  font-size: var(--ui-font-size);
}
.partial-warning,
.partial-note {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  color: var(--theme-warning-text, #edc779);
  font-size: var(--ui-font-help);
  line-height: 1.5;
}
.partial-mode .diff-line.is-partial-selected {
  box-shadow: inset 3px 0 var(--focus-ring);
  color: var(--view-selection-color);
  background-color: var(--view-selection-bg, #294b5b);
}
.partial-gutter {
  display: inline-flex;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
}
.partial-gutter input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent, #68c7d4);
}
.partial-mode .diff-line.hunk {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel, #252b34);
}
.partial-mode .diff-line.hunk code {
  flex: 1;
}
.partial-hunk-actions {
  position: sticky;
  right: 0;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 0 8px;
  background: inherit;
}
.partial-hunk-actions button {
  min-height: 21px;
  padding: 0 6px;
  border-radius: 3px;
  color: var(--text-secondary);
  font: var(--ui-font-size)/21px var(--mono);
}
.partial-hunk-actions button:not(:disabled):hover,
.partial-hunk-actions button[aria-pressed='true'] {
  background: var(--control-hover-bg);
  color: var(--text);
}

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
  font-size: var(--ui-font-size);
}
.diff-source-switch button[aria-pressed='true'] {
  background: var(--view-selection-bg);
  color: var(--view-selection-color);
}
.diff-source-switch button:not(:disabled):hover {
  background: var(--control-hover-bg);
}
</style>
