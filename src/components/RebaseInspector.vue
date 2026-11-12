<script setup lang="ts">
import { computed } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { useMergeStore } from '../stores/merge'
import { useRebaseStore } from '../stores/rebase'
import Icon from './Icon.vue'
const repo = useRepositoryStore(),
  merge = useMergeStore(),
  rebase = useRebaseStore()
const state = computed(() => repo.repo.merge!),
  operation = computed(() => state.value.rebase!)
const canContinue = computed(() => !state.value.files.length && !!state.value.staged.length)
</script>
<template>
  <section
    class="rebase-inspector"
    aria-label="变基进行中"
  >
    <header class="panel-header">
      <div class="panel-title">
        <Icon name="GitMerge" /><strong>{{
          state.files.length ? '变基冲突' : '变基已暂停'
        }}</strong>
      </div>
    </header>
    <p class="rebase-progress">
      将 <b>{{ operation.sourceBranch }}</b> 变基到 <b>{{ operation.targetName }}</b
      ><br />正在重放 {{ operation.step }} / {{ operation.total
      }}<code v-if="operation.pausedOid"> · {{ operation.pausedOid.slice(0, 7) }}</code>
    </p>
    <div class="rebase-file-list">
      <h3>冲突文件（{{ state.files.length }}）</h3>
      <button
        v-for="file in state.files"
        :key="file.path"
        class="rebase-file"
        :title="file.path"
        :disabled="repo.busy || merge.loading"
        @click="merge.openFile(file.path)"
      >
        <Icon
          name="FileCode2"
          :size="14"
        /><span>{{ file.path }}</span>
      </button>
      <h3>已暂存的解决结果（{{ state.staged.filter((f) => f.status !== 'U').length }}）</h3>
      <p
        v-for="file in state.staged.filter((f) => f.status !== 'U')"
        :key="file.path"
        class="rebase-resolved"
      >
        ✓ {{ file.path }}
      </p>
      <pre>{{ state.message }}</pre>
    </div>
    <p
      v-if="merge.session.error"
      class="rebase-hint"
      role="alert"
    >
      {{ merge.session.error }}
    </p>
    <p
      v-if="merge.dirty"
      class="rebase-hint"
    >
      有未保存的冲突处理草稿，请先保存或放弃。
    </p>
    <div class="rebase-actions">
      <button
        v-if="canContinue"
        class="primary-button"
        :disabled="repo.busy || merge.dirty"
        @click="rebase.perform('rebase-continue')"
      >
        继续变基</button
      ><button
        v-else
        class="secondary-button"
        :disabled="repo.busy || merge.dirty"
        title="丢弃当前提交的补丁，并继续重放后续提交"
        @click="rebase.perform('rebase-skip')"
      >
        跳过当前提交</button
      ><button
        class="text-button"
        :disabled="repo.busy || merge.dirty"
        title="放弃本轮变基及冲突解决结果，恢复变基前状态"
        @click="rebase.perform('rebase-abort')"
      >
        中止变基
      </button>
    </div>
  </section>
</template>
<style scoped>
.rebase-inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.rebase-progress {
  padding: 12px;
  margin: 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-help);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.rebase-progress b {
  color: var(--accent);
}
.rebase-progress code {
  font: var(--ui-font-help)/1.5 var(--mono);
}
.rebase-file-list {
  overflow: auto;
  flex: 1;
  padding: 12px;
  min-height: 0;
}
.rebase-file-list h3 {
  font-size: var(--ui-font-size);
  font-weight: 500;
  color: var(--text-secondary);
  margin: 8px 0;
}
.rebase-file {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 5px;
  text-align: left;
  font-size: var(--ui-font-size);
}
.rebase-file span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rebase-file:hover {
  background: var(--hover);
}
.rebase-file svg {
  color: var(--git-modified);
  flex-shrink: 0;
}
.rebase-resolved {
  font-size: var(--ui-font-help);
  overflow-wrap: anywhere;
}
.rebase-file-list pre {
  margin-top: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
.rebase-actions {
  display: flex;
  gap: 8px;
  flex-direction: column;
  padding: 12px;
  border-top: 1px solid var(--line);
  font-size: var(--ui-font-size);
}
.rebase-hint {
  padding: 0 12px;
  font-size: var(--ui-font-help);
  color: var(--git-modified);
}
</style>
