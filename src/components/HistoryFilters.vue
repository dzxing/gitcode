<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useHistoryQueryStore } from '../stores/historyQuery'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import { branchReference } from '../references'
const query = useHistoryQueryStore(),
  repo = useRepositoryStore()
const toolbar = ref<HTMLElement>()
function clear() {
  query.clear()
  repo.query = ''
  repo.clearBranchFilter()
}
function chooseBranch(event: Event) {
  const reference = (event.target as HTMLSelectElement).value
  if (!reference) repo.clearBranchFilter()
  else {
    const branch = repo.repo.branches.find((b) => branchReference(b) === reference)
    if (branch) repo.setBranchFilter(branch)
  }
}
function outside(event: PointerEvent) {
  for (const details of toolbar.value?.querySelectorAll('details[open]') || [])
    if (!details.contains(event.target as Node)) details.removeAttribute('open')
}
function opened(event: Event) {
  const details = event.target as HTMLDetailsElement
  if (details.open) details.querySelector('input')?.focus()
}
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>
<template>
  <div
    ref="toolbar"
    class="history-query-toolbar"
    aria-label="历史筛选"
  >
    <label
      >分支<select
        aria-label="筛选分支"
        :value="repo.branchFilter"
        @change="chooseBranch"
      >
        <option value="">全部分支</option>
        <option
          v-for="branch in repo.repo.branches.filter((b) => !b.symbolicTarget)"
          :key="branchReference(branch)"
          :value="branchReference(branch)"
        >
          {{ branch.name }}
        </option>
      </select></label
    >
    <details
      class="history-filter"
      @toggle="opened"
      @keydown.esc.prevent="($event.currentTarget as HTMLDetailsElement).open = false"
    >
      <summary>
        作者{{ query.filters.author ? `：${query.filters.author}` : ''
        }}<Icon
          name="ChevronDown"
          :size="12"
        />
      </summary>
      <div class="history-filter-popup">
        <label
          >作者<input
            v-model="query.filters.author"
            autocomplete="off"
            placeholder="姓名或邮箱"
            aria-label="筛选作者"
        /></label>
      </div>
    </details>
    <details
      class="history-filter"
      @toggle="opened"
      @keydown.esc.prevent="($event.currentTarget as HTMLDetailsElement).open = false"
    >
      <summary>
        日期{{
          query.filters.since || query.filters.until
            ? `：${query.filters.since || '不限'} — ${query.filters.until || '不限'}`
            : ''
        }}
        <Icon
          name="ChevronDown"
          :size="12"
        />
      </summary>
      <div class="history-filter-popup">
        <label
          >开始<input
            v-model="query.filters.since"
            type="date"
            aria-label="开始日期" /></label
        ><label
          >结束<input
            v-model="query.filters.until"
            type="date"
            aria-label="结束日期"
        /></label>
      </div>
    </details>
    <details
      class="history-filter"
      @toggle="opened"
      @keydown.esc.prevent="($event.currentTarget as HTMLDetailsElement).open = false"
    >
      <summary>
        路径{{ query.filters.path ? `：${query.filters.path}` : ''
        }}<Icon
          name="ChevronDown"
          :size="12"
        />
      </summary>
      <div class="history-filter-popup">
        <label
          >路径<input
            v-model="query.filters.path"
            autocomplete="off"
            placeholder="文件或目录"
            aria-label="筛选路径"
        /></label>
      </div>
    </details>
    <button
      v-if="query.enabled"
      class="text-button"
      @click="clear"
    >
      清除筛选
    </button>
    <span
      v-if="query.loading"
      role="status"
      >正在查询…</span
    >
    <span v-else-if="query.enabled">已加载 {{ query.commits.length }} 条</span>
    <p
      v-if="query.error"
      role="alert"
    >
      {{ query.error }}{{ query.commits.length ? '（仍显示上次查询结果）' : '' }}
      <button
        class="text-button"
        @click="query.read()"
      >
        重试
      </button>
    </p>
  </div>
</template>
<style scoped>
.history-query-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-help);
  position: relative;
  z-index: 4;
}
.history-query-toolbar label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
}
.history-query-toolbar input,
.history-query-toolbar select {
  min-width: 0;
  width: 150px;
  height: 26px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-input);
  color: var(--text);
  font: inherit;
}
.history-query-toolbar select {
  width: 130px;
  max-width: 180px;
}
.history-query-toolbar input[type='date'] {
  width: 145px;
}
.history-query-toolbar p {
  flex-basis: 100%;
  color: var(--git-deleted);
  margin: 2px 0;
}
.history-filter {
  position: relative;
  min-width: 48px;
}
.history-filter summary {
  cursor: default;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 3px;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-filter summary::marker {
  content: '';
}
.history-filter summary:hover,
.history-filter[open] summary {
  background: var(--control-hover-bg);
}
.history-filter-popup {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 6px 18px #0003;
  z-index: 12;
}
</style>
