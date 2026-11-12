<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRebaseStore } from '../stores/rebase'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import DiffViewer from './DiffViewer.vue'
const rebase = useRebaseStore(),
  repo = useRepositoryStore(),
  dragging = ref<number | null>(null)
const rows = computed(() => [...rebase.steps].reverse())
function drop(index: number) {
  if (dragging.value === null) return
  rebase.move(dragging.value, index - dragging.value)
  dragging.value = null
}
</script>
<template>
  <section
    class="rebase-panel"
    aria-label="交互式变基"
  >
    <header>
      <strong>交互式变基</strong
      ><span
        >将 <b>{{ repo.repo.branch }}</b> 变基到 <b>{{ rebase.target?.name }}</b></span
      ><button
        class="text-button"
        :disabled="repo.busy"
        @click="rebase.cancel"
      >
        取消变基
      </button>
    </header>
    <div
      class="rebase-steps"
      role="list"
      aria-label="待重放提交（从下向上重放）"
    >
      <p class="rebase-order">从下向上重放 · 拖动或使用上下移动按钮调整顺序</p>
      <div
        v-for="(step, index) in rows"
        :key="step.sha"
        class="rebase-step"
        :class="{ selected: rebase.selected === step.sha, dropped: step.type === 'drop' }"
        role="listitem"
        :draggable="!repo.busy"
        @dragstart="dragging = rebase.steps.length - 1 - index"
        @dragover.prevent
        @drop.prevent="drop(rebase.steps.length - 1 - index)"
        @dragend="dragging = null"
      >
        <div class="rebase-step-line">
          <select
            v-model="step.type"
            :aria-label="`提交 ${step.sha.slice(0, 7)} 的操作`"
            :disabled="repo.busy"
            @change="rebase.normalize"
          >
            <option value="pick">保留 Pick</option>
            <option value="reword">修改说明 Reword</option>
            <option
              v-if="rebase.canSquash(rebase.steps.length - 1 - index)"
              value="squash"
            >
              合并到前一条 Squash
            </option>
            <option value="drop">删除 Drop</option>
          </select>
          <button
            class="rebase-commit"
            :title="step.message"
            @click="rebase.select(step)"
          >
            <code>{{ step.sha.slice(0, 7) }}</code
            ><span>{{ step.message.split('\n')[0] }}</span>
          </button>
          <button
            class="icon-button"
            :aria-label="`上移提交 ${step.sha.slice(0, 7)}`"
            :disabled="repo.busy || index === 0"
            @click="rebase.move(rebase.steps.length - 1 - index, 1)"
          >
            <Icon
              name="ArrowUp"
              :size="13"
            /></button
          ><button
            class="icon-button"
            :aria-label="`下移提交 ${step.sha.slice(0, 7)}`"
            :disabled="repo.busy || index === rebase.steps.length - 1"
            @click="rebase.move(rebase.steps.length - 1 - index, -1)"
          >
            <Icon
              name="ArrowDown"
              :size="13"
            />
          </button>
        </div>
        <textarea
          autocomplete="off"
          v-if="step.type === 'reword'"
          v-model="step.message"
          :aria-label="`修改提交说明 ${step.sha.slice(0, 7)}`"
          :disabled="repo.busy"
          maxlength="20000"
          rows="3"
        />
      </div>
    </div>
    <p
      v-if="rebase.error || rebase.stale"
      class="rebase-error"
      role="alert"
    >
      {{ rebase.stale ? '仓库状态已变化，请重新读取后核对编排。' : rebase.error }}
      <button
        class="text-button"
        :disabled="repo.busy"
        @click="rebase.reload"
      >
        重新读取
      </button>
    </p>
    <DiffViewer v-if="repo.selectedFile" />
    <footer>
      <span>开始后才会改写当前分支的提交；Drop 会移除对应提交。</span
      ><button
        class="secondary-button"
        :disabled="repo.busy"
        @click="rebase.reset"
      >
        重置编排</button
      ><button
        class="secondary-button"
        :disabled="repo.busy"
        @click="rebase.cancel"
      >
        取消变基</button
      ><button
        class="primary-button"
        :disabled="
          repo.busy ||
          rebase.stale ||
          rebase.steps.some((s) => s.type === 'reword' && !s.message.trim())
        "
        @click="rebase.start()"
      >
        开始变基
      </button>
    </footer>
  </section>
</template>
<style scoped>
.rebase-panel {
  position: relative;
  grid-column: 1 / 3;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  border-right: 1px solid var(--line);
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  flex-shrink: 0;
  font-size: var(--ui-font-help);
  border-bottom: 1px solid var(--line);
}
header > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
header > button {
  margin-left: auto;
  white-space: nowrap;
}
b {
  color: var(--accent);
}
.rebase-steps {
  overflow: auto;
  flex: 1;
  padding: 12px 16px;
}
.rebase-order {
  margin: 0 0 12px;
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
}
.rebase-step {
  padding: 5px;
  border-radius: 3px;
}
.rebase-step.selected {
  background: var(--view-selection-bg);
}
.rebase-step.dropped .rebase-commit {
  text-decoration: line-through;
  opacity: 0.6;
}
.rebase-step-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rebase-step select {
  width: 175px;
  flex-shrink: 0;
  padding: 5px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text);
  font-size: var(--ui-font-size);
}
.rebase-commit {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: var(--ui-font-size);
}
.rebase-commit code {
  color: var(--text-secondary);
  font: var(--ui-font-help)/1.5 var(--mono);
}
.rebase-commit span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
textarea {
  display: block;
  resize: vertical;
  width: calc(100% - 183px);
  margin: 8px 0 4px 183px;
  padding: 8px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
footer {
  border-bottom: 0;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
footer > span {
  flex: 1;
  color: var(--text-secondary);
  min-width: 120px;
}
footer > button {
  font-size: var(--ui-font-size);
  white-space: nowrap;
}
.rebase-error {
  padding: 8px 16px;
  color: var(--git-deleted);
  font-size: var(--ui-font-help);
}
.rebase-commit > span {
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
</style>
