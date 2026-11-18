<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed, ref } from 'vue'
import { useHistoryToolsStore } from '../stores/historyTools'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import { alignVersions } from '../versionComparison'
import { useContextMenuStore } from '../stores/contextMenu'
const tools = useHistoryToolsStore(),
  repo = useRepositoryStore()
const visible = computed(() =>
  tools.tabs.filter((t) => t.repo === repo.repo.path && t.tabId === repo.activeTabId),
)
const active = computed(() => visible.value.find((t) => t.key === tools.active))
const menu = useContextMenuStore()
const comparePair = ref('all')
const synced = ref(true)
const revisionWidth = ref(35)
const content = ref<HTMLElement>()
function syncScroll(event: Event) {
  if (!synced.value || !content.value) return
  const source = event.target as HTMLElement
  for (const pane of content.value.querySelectorAll<HTMLElement>('.version-content')) {
    if (pane !== source && Math.abs(pane.scrollTop - source.scrollTop) > 1)
      pane.scrollTop = source.scrollTop
  }
}
function resize(event: PointerEvent) {
  const parent = (event.currentTarget as HTMLElement).parentElement!
  const move = (e: PointerEvent) => {
    const box = parent.getBoundingClientRect()
    revisionWidth.value = Math.min(60, Math.max(25, ((e.clientX - box.left) / box.width) * 100))
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
}
const aligned = computed(() =>
  alignVersions([0, 1, 2].map((i) => active.value?.versions[i]?.text ?? null)),
)
const changeRows = computed(() =>
  aligned.value[1].flatMap((row, i, rows) => (row.changed && !rows[i - 1]?.changed ? [i] : [])),
)
const changeIndex = ref(-1)
function nextChange(direction: number) {
  if (!changeRows.value.length || !content.value) return
  changeIndex.value =
    (changeIndex.value + direction + changeRows.value.length) % changeRows.value.length
  const row = changeRows.value[changeIndex.value]
  for (const pane of content.value.querySelectorAll('.version-content'))
    pane.children[row]?.scrollIntoView({ block: 'center' })
}
const labels = ['HEAD · 最近提交', '暂存区 · 下次提交内容', '工作区 · 当前文件']
const versionIndices = computed(() =>
  comparePair.value === 'all' ? [0, 1, 2] : comparePair.value === 'head-index' ? [0, 1] : [1, 2],
)
</script>
<template>
  <div
    class="history-tool-host"
    :class="{ 'has-active-tool': !!active }"
  >
    <nav
      v-if="visible.length"
      class="history-tool-tabs"
      aria-label="仓库工具标签"
      role="tablist"
    >
      <button
        role="tab"
        :aria-selected="!active"
        @click="tools.active = ''"
      >
        提交历史
      </button>
      <div
        v-for="tab in visible"
        :key="tab.key"
        class="history-tool-tab"
        :class="{ selected: active?.key === tab.key }"
      >
        <button
          role="tab"
          :aria-selected="active?.key === tab.key"
          v-overflow-title="tab.path"
          @click="tools.active = tab.key"
        >
          {{ tab.kind === 'file' ? '历史' : '三版本' }}：{{ tab.path.split('/').pop() }}
        </button>
        <button
          class="icon-button"
          :aria-label="`关闭 ${tab.path}`"
          @click="tools.close(tab.key)"
        >
          <Icon
            name="X"
            :size="12"
          />
        </button>
      </div>
    </nav>
    <section
      v-if="active"
      class="history-tool-view"
      :aria-label="active.kind === 'file' ? '文件历史' : '三版本对照'"
    >
      <header class="history-tool-header">
        <strong v-overflow-title="active.path">{{ active.path }}</strong>
        <span v-if="active.kind === 'file'">起点 {{ active.revision.slice(0, 8) }}</span>
        <select
          v-else
          v-model="comparePair"
          aria-label="比较版本"
        >
          <option value="all">三个版本</option>
          <option value="head-index">HEAD 与暂存区</option>
          <option value="index-working">暂存区与工作区</option>
        </select>
        <label v-if="active.kind === 'three'"
          ><input
            v-model="synced"
            type="checkbox"
          />同步滚动</label
        >
        <button
          class="secondary-button"
          :disabled="active.loading"
          @click="tools.load(active)"
        >
          重新读取
        </button>
        <template v-if="active.kind === 'three'"
          ><button
            class="secondary-button"
            :disabled="!changeRows.length"
            @click="nextChange(-1)"
          >
            上一处</button
          ><button
            class="secondary-button"
            :disabled="!changeRows.length"
            @click="nextChange(1)"
          >
            下一处
          </button></template
        >
        <span
          v-if="active.loading"
          role="status"
          >正在读取…</span
        >
      </header>
      <p
        v-if="active.stale"
        class="history-tool-stale"
        role="status"
      >
        仓库状态已更新，当前为上次读取的内容。<button
          class="text-button"
          @click="tools.load(active)"
        >
          重新读取
        </button>
      </p>
      <p
        v-if="active.error"
        class="history-tool-error"
        role="alert"
      >
        {{ active.error }}
        <button
          class="text-button"
          @click="tools.load(active)"
        >
          重试
        </button>
      </p>
      <div
        v-if="active.kind === 'file'"
        class="file-history-body"
        :style="{ '--revision-width': revisionWidth + '%' }"
      >
        <div
          class="file-history-revisions"
          role="list"
          aria-label="文件版本"
        >
          <button
            v-for="row in active.rows"
            :key="row.hash"
            class="file-history-revision"
            :class="{ selected: active.selected.includes(row.hash) }"
            @click="tools.select(active, row, $event.ctrlKey || $event.metaKey)"
            @contextmenu="
              menu.open($event, {
                kind: 'file-revision',
                path: row.path || active.path,
                oldPath: row.oldPath,
                currentPath: active.path,
                revision: row.hash,
              })
            "
            @keydown="
              menu.keyboard($event, {
                kind: 'file-revision',
                path: row.path || active.path,
                oldPath: row.oldPath,
                currentPath: active.path,
                revision: row.hash,
              })
            "
          >
            <strong>{{ row.subject }}</strong
            ><span>{{ row.author }} · {{ new Date(row.date).toLocaleString() }}</span
            ><small
              >{{ row.hash.slice(0, 8)
              }}<template v-if="row.oldPath"> · {{ row.oldPath }} → {{ row.path }}</template></small
            >
          </button>
          <p
            v-if="!active.loading && !active.error && !active.rows.length"
            class="history-tool-empty"
          >
            此文件在所选历史中没有提交记录。
          </p>
          <button
            v-if="active.nextOffset !== null"
            class="secondary-button"
            :disabled="active.loading"
            @click="tools.load(active, true)"
          >
            加载更多版本
          </button>
        </div>
        <div
          class="history-tool-divider"
          role="separator"
          aria-label="调整版本列表宽度"
          tabindex="0"
          @pointerdown.prevent="resize"
          @keydown.left.prevent="revisionWidth = Math.max(25, revisionWidth - 2)"
          @keydown.right.prevent="revisionWidth = Math.min(60, revisionWidth + 2)"
        ></div>
        <div class="file-history-preview">
          <div class="history-tool-subhead">
            {{
              active.preview === 'local'
                ? '所选版本与本地文件比较'
                : active.preview === 'pair'
                  ? '所选版本比较'
                  : '此版本引入的修改'
            }}<span>Ctrl / ⌘ 单击比较两个版本</span>
          </div>
          <pre><code v-for="(line, n) in (active.diff || (active.loading ? '正在读取差异…' : '选择一个文件版本')).split('\n')" :key="n" :class="{ 'diff-add': line.startsWith('+'), 'diff-remove': line.startsWith('-'), 'diff-hunk': line.startsWith('@@') }">{{ line }}{{ '\n' }}</code></pre>
        </div>
      </div>
      <div
        v-else
        ref="content"
        class="three-version-body"
        :style="{ '--version-count': versionIndices.length }"
      >
        <section
          v-for="index in versionIndices"
          :key="index"
          class="version-pane"
        >
          <header>{{ labels[index] }}</header>
          <p
            v-if="!active.versions[index]"
            class="history-tool-empty"
          >
            {{ active.loading ? '正在读取…' : '尚未读取' }}
          </p>
          <p
            v-else-if="!active.versions[index]!.exists"
            class="history-tool-empty"
          >
            不存在于此版本
          </p>
          <p
            v-else-if="active.versions[index]!.binary"
            class="history-tool-empty"
          >
            此文件的类型、编码或大小不支持文本预览。
          </p>
          <pre
            v-else
            class="version-content"
            @scroll="syncScroll"
          ><code v-for="(line, number) in aligned[index]" :key="number" :class="{ 'version-changed': line.changed, 'version-padding': line.number === null }"><span class="version-line-number">{{ line.number ?? ' ' }}</span>{{ line.text || ' ' }}</code></pre>
        </section>
      </div>
    </section>
    <div
      v-show="!active"
      class="history-original-view"
    >
      <slot />
    </div>
  </div>
</template>
<style scoped>
.history-tool-host {
  grid-column: 2 / 4;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}
.history-tool-tabs {
  display: flex;
  flex-shrink: 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  min-height: 32px;
}
.history-tool-tabs button {
  white-space: nowrap;
  padding: 6px 10px;
  color: var(--muted);
}
.history-tool-tab {
  display: flex;
  align-items: center;
  border-right: 1px solid var(--line);
}
.history-tool-tab.selected {
  background: var(--bg);
  box-shadow: inset 0 -2px var(--accent);
}
.history-tool-tab.selected > button {
  color: var(--text);
}
.history-tool-tab > button:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.history-original-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--inspector-width);
  min-height: 0;
  flex: 1;
  position: relative;
}
.history-tool-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.history-tool-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-size);
}
.history-tool-header strong {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 100px;
  white-space: nowrap;
}
.history-tool-header span,
.history-tool-subhead span {
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.history-tool-header label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.history-tool-header select {
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  padding: 4px;
}
.history-tool-stale {
  padding: 6px 12px;
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.history-tool-error {
  padding: 8px 12px;
  color: var(--git-deleted);
}
.file-history-body {
  display: grid;
  grid-template-columns: var(--revision-width) 5px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}
.file-history-revisions {
  overflow: auto;
  min-width: 0;
  padding: 4px;
}
.file-history-revision {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  align-items: flex-start;
  width: 100%;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-size);
}
.file-history-revision:hover {
  background: var(--control-hover-bg);
}
.file-history-revision.selected {
  background: var(--view-selection-bg);
}
.file-history-revision strong {
  font-weight: 500;
  font-family: var(--font-code);
  font-size: var(--code-font-size);
}
.file-history-revision span,
.file-history-revision small {
  color: var(--muted);
  font-size: var(--ui-font-help);
  overflow-wrap: anywhere;
}
.history-tool-divider {
  cursor: col-resize;
  background: var(--line);
  touch-action: none;
}
.file-history-preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.history-tool-subhead {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
}
.file-history-preview pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
  flex: 1;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  tab-size: 4;
}
.three-version-body {
  display: grid;
  grid-template-columns: repeat(var(--version-count), minmax(240px, 1fr));
  min-height: 0;
  flex: 1;
  overflow-x: auto;
}
.version-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.version-pane header {
  padding: 10px;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-size);
}
.version-content {
  margin: 0;
  overflow: auto;
  flex: 1;
  padding: 8px 0;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  tab-size: 4;
}
.version-content code {
  font: inherit;
  display: block;
  min-height: calc(var(--code-font-size) * var(--code-line-height));
}
.version-changed {
  background: var(--accent-soft);
}
.version-padding {
  background: var(--control-open-bg);
}
.diff-add {
  color: var(--git-added);
}
.diff-remove {
  color: var(--git-deleted);
}
.diff-hunk {
  color: var(--accent);
}
.version-line-number {
  display: inline-block;
  width: 42px;
  padding-right: 10px;
  text-align: right;
  color: var(--muted);
  user-select: none;
}
.history-tool-empty {
  color: var(--muted);
  padding: 16px;
}
</style>
