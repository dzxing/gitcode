<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMergeStore } from '../stores/merge'
import { useRepositoryStore } from '../stores/repository'
import { conflictBlocks, resolveBlock } from '../mergeConflicts'
import Icon from './Icon.vue'
const merge = useMergeStore(),
  repo = useRepositoryStore(),
  index = ref(0),
  confirmDiscard = ref(false)
const incomingLabel = computed(
  () =>
    repo.repo.branches.find(
      (branch) => branch.kind === 'remote' && branch.hash === merge.session.file?.incoming,
    )?.name ||
    (repo.repo.gitflow?.finish
      ? repo.repo.branches.find(
          (branch) =>
            branch.kind === 'local' &&
            branch.name !== merge.session.file?.branch &&
            branch.hash === merge.session.file?.incoming,
        )?.name
      : '') ||
    '合入提交',
)
const file = computed(() => merge.session.file),
  blocks = computed(() => conflictBlocks(merge.session.draft)),
  disabled = computed(() => repo.busy || merge.loading || merge.stale)
function apply(side: 'ours' | 'theirs' | 'both') {
  merge.session.draft = resolveBlock(
    merge.session.draft,
    Math.min(index.value, blocks.value.length - 1),
    side,
  )
  index.value = Math.min(index.value, Math.max(0, blocks.value.length - 1))
}
function discard() {
  merge.discard()
  confirmDiscard.value = false
  merge.open()
}
function reloadFile() {
  if (!file.value) return
  void merge.openFile(file.value.path, true)
  confirmDiscard.value = false
}
</script>
<template>
  <section
    v-if="file"
    class="merge-editor"
    aria-label="冲突解决编辑器"
  >
    <header class="merge-editor-heading">
      <Icon
        name="GitMerge"
        :size="16"
      /><strong :title="file.path">{{ file.path }}</strong
      ><span>{{ merge.dirty ? '未保存' : '尚未标记解决' }}</span
      ><button
        class="icon-button"
        aria-label="返回冲突列表"
        :disabled="repo.busy"
        @click="merge.dismissEditor"
      >
        <Icon
          name="X"
          :size="16"
        />
      </button>
    </header>
    <div class="merge-editor-toolbar">
      <button
        class="secondary-button"
        :disabled="disabled || !file.supported"
        @click="merge.resolve('ours')"
      >
        {{ file.ours.exists ? '整文件采用当前分支' : '接受当前侧删除' }}</button
      ><button
        class="secondary-button"
        :disabled="disabled || !file.supported"
        @click="merge.resolve('theirs')"
      >
        {{
          file.theirs.exists
            ? merge.session.state?.active
              ? '整文件采用合入版本'
              : '整文件采用恢复版本'
            : '接受恢复侧删除'
        }}</button
      ><button
        class="text-button"
        :disabled="repo.busy"
        @click="confirmDiscard = true"
      >
        放弃草稿／重新读取
      </button>
    </div>
    <p
      v-if="merge.stale"
      class="merge-editor-warning"
      role="alert"
    >
      文件或合并状态已变化。当前草稿保留，请核对后重新读取。
    </p>
    <p
      v-if="!file.editable"
      class="merge-editor-warning"
    >
      二进制、大文件或不支持的编码不提供文本编辑。可采用完整版本；特殊文件类型请使用外部工具处理。
    </p>
    <div
      v-if="confirmDiscard"
      class="merge-editor-warning"
    >
      <span>放弃当前未保存的编辑结果？磁盘上的内容不变。</span
      ><button
        class="secondary-button"
        @click="confirmDiscard = false"
      >
        保留草稿</button
      ><button
        class="secondary-button"
        @click="reloadFile"
      >
        放弃并重新读取</button
      ><button
        class="text-button"
        @click="discard"
      >
        放弃并返回列表
      </button>
    </div>
    <div class="merge-three-panes">
      <div class="merge-pane">
        <h3>当前分支 · {{ file.branch }}</h3>
        <pre tabindex="0">{{
          file.ours.exists ? (file.ours.text ?? '非文本内容') : '该侧没有此文件'
        }}</pre>
      </div>
      <div class="merge-pane merge-result">
        <h3>合并结果 · 可编辑</h3>
        <textarea
          v-model="merge.session.draft"
          aria-label="编辑合并结果"
          spellcheck="false"
          :readonly="disabled || !file.editable"
        />
        <details>
          <summary>查看共同基础版本</summary>
          <pre>{{ file.base.exists ? (file.base.text ?? '非文本内容') : '无共同文件版本' }}</pre>
        </details>
      </div>
      <div class="merge-pane">
        <h3 :title="file.incoming ? `${incomingLabel} · ${file.incoming}` : '恢复的修改'">
          {{ file.incoming ? `${incomingLabel} · ${file.incoming.slice(0, 7)}` : '恢复的修改' }}
        </h3>
        <pre tabindex="0">{{
          file.theirs.exists ? (file.theirs.text ?? '非文本内容') : '该侧没有此文件'
        }}</pre>
      </div>
    </div>
    <div
      v-if="file.editable && blocks.length"
      class="merge-block-actions"
    >
      <span>剩余 {{ blocks.length }} 个冲突块</span
      ><select
        v-model.number="index"
        aria-label="选择冲突块"
      >
        <option
          v-for="(_, i) in blocks"
          :key="i"
          :value="i"
        >
          冲突 {{ i + 1 }}
        </option></select
      ><button
        class="secondary-button"
        :disabled="disabled"
        @click="apply('ours')"
      >
        本块采用当前分支</button
      ><button
        class="secondary-button"
        :disabled="disabled"
        @click="apply('theirs')"
      >
        {{ merge.session.state?.active ? '本块采用合入版本' : '本块采用恢复版本' }}</button
      ><button
        class="secondary-button"
        :disabled="disabled"
        @click="apply('both')"
      >
        本块保留双方
      </button>
    </div>
    <p
      v-if="merge.session.error"
      class="merge-editor-warning"
      role="alert"
    >
      {{ merge.session.error }}
    </p>
    <footer>
      <span>{{
        merge.session.state?.active
          ? '保存只标记此文件已解决，不完成整个合并。'
          : '保存后标记此文件已解决；贮藏保留，无需合并提交。'
      }}</span
      ><button
        class="primary-button"
        :disabled="disabled || !file.editable || !!blocks.length"
        @click="merge.resolve('manual')"
      >
        保存并标记已解决
      </button>
    </footer>
  </section>
</template>
<style scoped>
.merge-editor {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
}
.merge-editor-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.merge-editor-heading strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.merge-editor-heading span {
  font-size: 10px;
  color: var(--git-modified);
  white-space: nowrap;
}
.merge-editor-heading button {
  margin-left: auto;
  flex-shrink: 0;
}
.merge-editor-toolbar,
.merge-block-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  font-size: 11px;
}
.merge-editor-toolbar button,
.merge-block-actions button {
  font-size: 11px;
  min-height: 27px;
}
.merge-three-panes {
  display: grid;
  grid-template-columns: 1fr 1.2fr 1fr;
  flex: 1;
  min-height: 100px;
  min-width: 0;
  overflow: auto;
}
.merge-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.merge-pane:last-child {
  border-right: 0;
}
.merge-pane h3 {
  padding: 8px;
  margin: 0;
  font-size: 11px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-pane pre,
.merge-pane textarea {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 10px;
  border: 0;
  border-radius: 0;
  background: var(--bg);
  color: var(--text);
  font: 12px/1.65 var(--mono);
  white-space: pre;
  tab-size: 4;
  resize: none;
}
.merge-result textarea {
  background: var(--surface-raised);
}
.merge-result details {
  flex-shrink: 0;
  max-height: 30%;
  overflow: auto;
  border-top: 1px solid var(--line);
  font-size: 10px;
}
.merge-result summary {
  padding: 6px 8px;
  color: var(--text-secondary);
  cursor: default;
}
.merge-block-actions select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  padding: 4px;
}
.merge-editor-warning {
  margin: 0;
  padding: 8px 12px;
  line-height: 1.6;
  font-size: 11px;
  color: var(--git-modified);
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.merge-editor-warning button {
  margin-left: 6px;
}
.merge-editor footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-top: 1px solid var(--line);
  font-size: 10px;
  color: var(--text-secondary);
}
.merge-editor footer button {
  margin-left: auto;
  font-size: 11px;
  flex-shrink: 0;
}
.merge-editor footer > span {
  min-width: 0;
}
</style>
