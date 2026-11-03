<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { buildHistoryGraph, HISTORY_ROW_HEIGHT } from '../graph'
import type { Commit, StashEntry } from '../types'
import Icon from './Icon.vue'
import ReferenceBadge from './ReferenceBadge.vue'
import {
  resolveCommitReferences,
  groupCommitReferences,
  type CommitReference,
  type ReferenceGroup,
} from '../referenceLabels'
import MergeEditor from './MergeEditor.vue'
import { useMergeStore } from '../stores/merge'
import DiffViewer from './DiffViewer.vue'
import { useContextMenuStore } from '../stores/contextMenu'
import { useStashStore } from '../stores/stash'
import { branchReference } from '../references'
import { useGraphViewStore } from '../stores/graphView'

const store = useRepositoryStore()
const graphView = useGraphViewStore()
const graphBranches = computed(() =>
  graphView.visibleBranches(store.repo.path, store.repo.branches),
)
const graphReferenceKeys = computed(() => new Set(graphBranches.value.map(branchReference)))
function resolveVisibleReferences(commit: Commit) {
  return resolveCommitReferences(commit, store.repo.branches).filter(
    (reference) => !reference.branch || graphReferenceKeys.value.has(reference.key),
  )
}
const menu = useContextMenuStore()
const stash = useStashStore()
const merge = useMergeStore()
const historyPanel = ref<HTMLElement>()
const searchInput = ref<HTMLInputElement>()
const refsDialog = ref<HTMLDialogElement>()
const refsCommit = ref<Commit | null>(null)
const referenceTailInset = 6
const pointerExpandedReference = ref(''),
  focusedExpandedReference = ref('')
let refsTrigger: HTMLElement | null = null
let refsOriginKey = '',
  refsOriginHash = ''
const searching = computed(() => !!store.query.trim() || !!store.branchFilter)
const visibleStashes = computed(() => {
  const term = store.query.trim().toLocaleLowerCase()
  // Stashes belong to the repository. A branch-history filter must not hide them.
  return stash.entries.filter(
    (entry) =>
      !term || `${entry.message} ${entry.branch} ${entry.oid}`.toLocaleLowerCase().includes(term),
  )
})
const showWorktree = computed(() => store.changes > 0)
const graph = computed(() =>
  buildHistoryGraph(store.visibleCommits, visibleStashes.value, showWorktree.value),
)
const relative = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`
  return new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
const nodeColors = computed(() => new Map(graph.value.nodes.map((node) => [node.hash, node.color])))
const referenceData = computed(
  () =>
    new Map(
      store.visibleCommits.map((commit) => {
        const references = resolveVisibleReferences(commit)
        return [commit.hash, { references, groups: groupCommitReferences(references) }]
      }),
    ),
)
function references(commit: Commit) {
  return referenceData.value.get(commit.hash)?.references || resolveVisibleReferences(commit)
}
function referenceGroups(commit: Commit): ReferenceGroup[] {
  return referenceData.value.get(commit.hash)?.groups || groupCommitReferences(references(commit))
}
const referenceHashes = computed(
  () =>
    new Set(
      [...referenceData.value].filter(([, data]) => data.groups.length).map(([hash]) => hash),
    ),
)
const currentReferenceHash = computed(
  () => store.repo.branches.find((branch) => branch.kind === 'local' && branch.current)?.hash || '',
)
// CSS snaps a 1px tail onto one device row. SVG needs a half-pixel center
// for the same rasterization; a 2px current-reference guide stays integral.
const referenceNodes = computed(() =>
  graph.value.nodes
    .filter((node) => referenceHashes.value.has(node.hash))
    .map((node) => ({
      ...node,
      guideY: node.y + (node.hash === currentReferenceHash.value ? 0 : 0.5),
    })),
)
function updateExpansionLimit(group: HTMLElement) {
  const right = Math.min(
    window.innerWidth,
    historyPanel.value?.getBoundingClientRect().right || window.innerWidth,
  )
  group.style.setProperty(
    '--ref-expanded-limit',
    `${Math.max(group.getBoundingClientRect().width, Math.min(640, right - group.getBoundingClientRect().left - 8))}px`,
  )
}
function expandFromPointer(commit: Commit, event: MouseEvent) {
  const group = (event.currentTarget as HTMLElement).closest<HTMLElement>('.ref-labels')
  if (group) {
    updateExpansionLimit(group)
    pointerExpandedReference.value = commit.hash
  }
}
function referenceFocusIn(commit: Commit, event: FocusEvent) {
  if ((event.target as HTMLElement).matches(':focus-visible')) {
    updateExpansionLimit(event.currentTarget as HTMLElement)
    focusedExpandedReference.value = commit.hash
  }
}
function referenceFocusOut(commit: Commit, event: FocusEvent) {
  if (
    !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null) &&
    focusedExpandedReference.value === commit.hash
  )
    focusedExpandedReference.value = ''
}
function referencePointerLeave(commit: Commit) {
  if (pointerExpandedReference.value === commit.hash) pointerExpandedReference.value = ''
}
function updateExpandedReferences() {
  historyPanel.value
    ?.querySelectorAll<HTMLElement>('.ref-labels.is-expanded')
    .forEach(updateExpansionLimit)
}
let panelResize: ResizeObserver | undefined
onMounted(() => {
  panelResize = new ResizeObserver(updateExpandedReferences)
  if (historyPanel.value) panelResize.observe(historyPanel.value)
})
onBeforeUnmount(() => panelResize?.disconnect())
function moreDescription(commit: Commit) {
  return `另有 ${Math.max(0, referenceGroups(commit).length - 1)} 组引用，查看全部 ${references(commit).length} 个引用：${commit.subject}`
}
function referenceActionLabel(reference: CommitReference) {
  const branch = reference.branch
  return branch?.kind === 'local'
    ? branch.current
      ? `当前分支 ${branch.name}`
      : `切换到本地分支 ${branch.name}`
    : `查看引用 ${reference.rawLabel}`
}
function referenceTitle(group: ReferenceGroup) {
  const reference = group.primary,
    branch = reference.branch
  const identities = group.members
    .map((member) => (member.branch ? member.key : member.rawLabel))
    .join('\n')
  if (branch?.kind !== 'local') return identities
  if (branch.current) return `当前分支 ${branch.name}\n${identities}`
  return `${store.busy ? `操作进行中，暂不能切换到 ${branch.name}` : `单击切换到 ${branch.name}`}\n${identities}`
}
async function activateReference(commit: Commit, reference: CommitReference, event: MouseEvent) {
  event.stopPropagation()
  if (event.detail > 1) return
  const branch = reference.branch
  if (branch?.kind !== 'local') {
    showReferences(commit, event)
    return
  }
  if (store.busy || store.modal || branch.current) return
  const trigger = event.currentTarget as HTMLElement
  const succeeded = await store.checkoutBranch(branch)
  if (succeeded) {
    await nextTick()
    // The visible reference key changes to HEAD after a successful checkout.
    if (document.activeElement === document.body || document.activeElement === trigger)
      historyPanel.value
        ?.querySelector<HTMLButtonElement>('.ref-tag.current-ref .ref-primary')
        ?.focus({ preventScroll: true })
  }
}
function referenceMenu(
  event: MouseEvent | KeyboardEvent,
  reference: CommitReference,
  commit: Commit,
) {
  const branch = reference.branch
  menu.open(event, branch ? { kind: 'branch', branch } : { kind: 'commit', commit })
}
function referenceKeyboard(event: KeyboardEvent, reference: CommitReference, commit: Commit) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    referenceMenu(event, reference, commit)
}
function selectStashNode(entry: StashEntry) {
  if (store.busy || store.modal) return
  stash.openList(entry)
  void nextTick(() =>
    [...(historyPanel.value?.querySelectorAll<HTMLButtonElement>('.stash-row') || [])]
      .find((row) => row.dataset.stashOid === entry.oid && row.dataset.stashRef === entry.ref)
      ?.focus({ preventScroll: true }),
  )
}
function nodeMenu(event: MouseEvent, hash: string) {
  const commit = store.visibleCommits.find((c) => c.hash === hash)
  if (commit) menu.open(event, { kind: 'commit', commit })
}
function showReferences(commit: Commit, event: MouseEvent) {
  refsCommit.value = commit
  refsTrigger = event.currentTarget as HTMLElement
  refsOriginKey =
    refsTrigger.closest<HTMLElement>('[data-reference-key]')?.dataset.referenceKey || ''
  refsOriginHash = commit.hash
  refsDialog.value?.showModal()
}
function closeReferences() {
  refsDialog.value?.close()
}
function restoreReferenceFocus() {
  refsCommit.value = null
  if (refsTrigger?.isConnected) {
    refsTrigger.focus({ preventScroll: true })
    return
  }
  const badges = [...(historyPanel.value?.querySelectorAll<HTMLElement>('.ref-tag') || [])]
  const target =
    badges.find((badge) => badge.dataset.referenceKey === refsOriginKey) ||
    badges.find(
      (badge) =>
        badge.closest<HTMLElement>('[data-commit-hash]')?.dataset.commitHash === refsOriginHash,
    )
  ;(target?.querySelector<HTMLButtonElement>('.ref-primary') || searchInput.value)?.focus({
    preventScroll: true,
  })
}
watch(
  () => store.activeTabId,
  () => {
    closeReferences()
    pointerExpandedReference.value = ''
    focusedExpandedReference.value = ''
  },
)
watch(() => store.repo, closeReferences)
defineExpose({ focusSearch: () => searchInput.value?.focus() })
function clearHistoryFilters() {
  store.query = ''
  store.clearBranchFilter()
}
</script>

<template>
  <main
    ref="historyPanel"
    class="history-panel"
    :class="{
      'show-author': store.showAuthor,
      'show-time': store.showTime,
      'show-sha': store.showSha,
    }"
    :style="{
      '--history-row-height': `${HISTORY_ROW_HEIGHT}px`,
      '--ref-tail-inset': `${referenceTailInset}px`,
      '--author-width': store.showAuthor ? '100px' : '0px',
      '--time-width': store.showTime ? '78px' : '0px',
      '--sha-width': store.showSha ? '90px' : '0px',
    }"
  >
    <header class="panel-header history-heading">
      <div class="panel-title">
        <Icon name="History" /><strong>提交历史</strong
        ><span class="pill">{{ store.repo.total }}</span>
      </div>
      <label class="commit-search"
        ><Icon
          name="Search"
          :size="14" /><input
          ref="searchInput"
          v-model="store.query"
          placeholder="搜索提交、作者或 SHA…"
          aria-label="搜索提交" /><kbd v-if="!store.query">⌘ K</kbd
        ><button
          v-else
          class="icon-button"
          aria-label="清除搜索"
          @click="store.query = ''"
        >
          <Icon
            name="X"
            :size="12"
          /></button
      ></label>
    </header>
    <div
      v-if="
        store.repo.branches.some((branch) => graphView.isHidden(store.repo.path, branch)) ||
        graphView.soloActive(store.repo.path, store.repo.branches)
      "
      class="filter-banner"
      role="status"
    >
      <span>{{
        graphView.soloActive(store.repo.path, store.repo.branches)
          ? 'Solo：仅显示选定引用的历史'
          : '部分引用已从图谱隐藏'
      }}</span>
      <button @click="graphView.reset(store.repo.path)">显示全部引用</button>
      <span v-if="graphView.warning">{{ graphView.warning }}</span>
    </div>
    <div
      v-if="store.branchFilter"
      class="filter-banner"
    >
      <Icon
        name="GitBranch"
        :size="13"
      /><span>正在查看 {{ store.branchFilterLabel }}</span
      ><button @click="store.clearBranchFilter()">
        显示全部
        <Icon
          name="X"
          :size="12"
        />
      </button>
    </div>
    <div
      class="history-scroll"
      tabindex="0"
      aria-label="提交图谱"
      @scroll="updateExpandedReferences"
      @contextmenu="menu.open($event, { kind: 'background' })"
      @keydown="menu.keyboard($event, { kind: 'background' })"
    >
      <div
        class="history-table"
        :style="{ '--graph-width': `${graph.width}px` }"
      >
        <div
          class="table-head commit-grid"
          tabindex="0"
          aria-label="历史列表显示列"
          @contextmenu="menu.open($event, { kind: 'columns' })"
          @keydown="menu.keyboard($event, { kind: 'columns' })"
        >
          <span>分支 / 标签</span><span>关系图</span><span>提交说明</span
          ><span class="author-heading">作者</span><span class="time-cell">时间</span
          ><span class="sha-cell">SHA</span>
        </div>
        <div class="history-body">
          <svg
            class="commit-graph"
            :width="graph.width"
            :height="(graph.rows.length + graph.rowOffset) * HISTORY_ROW_HEIGHT"
            aria-label="提交关系图"
          >
            <g
              class="reference-connectors"
              aria-hidden="true"
              pointer-events="none"
            >
              <line
                v-for="node in referenceNodes"
                :key="node.hash"
                :data-reference-hash="node.hash"
                :class="{ 'is-current-reference': node.hash === currentReferenceHash }"
                :x1="-referenceTailInset"
                :x2="node.x"
                :y1="node.guideY"
                :y2="node.guideY"
                :stroke="node.color"
              />
            </g>
            <path
              v-for="(edge, i) in graph.edges"
              :key="i"
              :data-child-hash="edge.childHash"
              :data-parent-hash="edge.parentHash"
              :d="edge.d"
              :stroke="edge.color"
              :stroke-dasharray="edge.boundary ? '3 3' : undefined"
              stroke-width="2"
              fill="none"
            />
            <path
              v-for="edge in graph.stashEdges"
              :key="edge.childHash"
              class="stash-base-edge"
              :data-stash-child="edge.childHash"
              :data-stash-base="edge.parentHash"
              :d="edge.d"
              :stroke="edge.color"
              stroke-width="1.5"
              stroke-dasharray="3 3"
              fill="none"
            />
            <g
              v-for="node in graph.stashNodes"
              :key="node.key"
              :data-stash-node="node.hash"
              class="stash-graph-node"
              @click="selectStashNode(node.entry)"
              @contextmenu="menu.open($event, { kind: 'stash', stash: node.entry })"
            >
              <title>
                {{ node.entry.message }} ·
                {{
                  node.boundary
                    ? `创建时的基础提交 ${node.baseHash.slice(0, 7)} 不在当前视图`
                    : `创建时的基础提交 ${node.baseHash.slice(0, 7)}`
                }}
              </title>
              <rect
                :x="node.x - 6"
                :y="node.y - 5"
                width="12"
                height="10"
                rx="2"
                fill="var(--bg)"
                :stroke="node.color"
                stroke-width="1.7"
              />
              <path
                :d="`M${node.x - 6} ${node.y - 1}h12m-8 3h4`"
                :stroke="node.color"
                fill="none"
                stroke-width="1.4"
              />
            </g>
            <circle
              v-if="showWorktree && !searching"
              :cx="graph.worktree.x"
              :cy="HISTORY_ROW_HEIGHT / 2"
              r="6"
              fill="var(--bg)"
              :stroke="graph.worktree.color"
              stroke-width="1.6"
              stroke-dasharray="2 2"
            />
            <g
              v-for="node in graph.nodes"
              :key="node.hash"
              :data-node-hash="node.hash"
              tabindex="-1"
              @contextmenu="nodeMenu($event, node.hash)"
            >
              <circle
                :cx="node.x"
                :cy="node.y"
                :r="store.selectedCommit?.hash === node.hash ? 7 : 5"
                :fill="node.merge ? 'var(--bg)' : node.color"
                :stroke="node.color"
                :stroke-width="node.merge ? 2 : 1"
              />
              <circle
                v-if="node.merge"
                :cx="node.x"
                :cy="node.y"
                r="1.5"
                :fill="node.color"
              />
            </g>
          </svg>
          <button
            v-if="showWorktree"
            class="wip-row commit-grid"
            @contextmenu="menu.open($event, { kind: 'worktree' })"
            @keydown="menu.keyboard($event, { kind: 'worktree' })"
            :class="{ selected: !store.selectedCommit && !store.selectedStash }"
            @click="store.clearSelection()"
          >
            <span class="worktree-tag"
              ><Icon
                name="FolderGit2"
                :size="13"
              />工作区</span
            ><span></span
            ><span class="wip-message"
              ><strong>未提交的更改</strong
              ><span class="wip-count">{{ store.changes }} 个文件</span></span
            ><span class="wip-owner">本机</span
            ><span class="time-cell"><span class="live-dot"></span>现在</span>
          </button>
          <template
            v-for="row in graph.rows"
            :key="row.kind === 'stash' ? row.stash.ref + row.stash.oid : row.commit.hash"
          >
            <button
              v-if="row.kind === 'stash'"
              class="stash-row commit-grid"
              :data-stash-oid="row.stash.oid"
              :data-stash-ref="row.stash.ref"
              :aria-pressed="
                stash.selected?.oid === row.stash.oid && stash.selected?.ref === row.stash.ref
              "
              :class="{
                selected:
                  stash.selected?.oid === row.stash.oid && stash.selected?.ref === row.stash.ref,
              }"
              :title="`${row.stash.message} · 创建时分支 ${row.stash.branch}（仅作记录）· 基础提交 ${row.stash.base.slice(0, 7)}`"
              :aria-label="`查看贮藏 ${row.stash.message}`"
              :disabled="store.busy"
              @click="stash.openList(row.stash)"
              @contextmenu="menu.open($event, { kind: 'stash', stash: row.stash })"
              @keydown="menu.keyboard($event, { kind: 'stash', stash: row.stash })"
            >
              <span class="stash-row-label"
                ><Icon
                  name="Archive"
                  :size="12"
                />贮藏</span
              ><span></span
              ><span class="stash-row-message">{{
                row.stash.message.replace(/^(?:On|WIP on) [^:]+:\s*/, '')
              }}</span
              ><span
                class="author-cell"
                aria-hidden="true"
              ></span
              ><span class="time-cell">{{ relative(row.stash.date) }}</span
              ><span class="sha-cell">{{ row.stash.oid.slice(0, 7) }}</span>
            </button>
            <template
              v-for="commit in row.kind === 'commit' ? [row.commit] : []"
              :key="commit.hash"
              ><div
                class="commit-row commit-grid"
                tabindex="-1"
                :data-commit-hash="commit.hash"
                :style="{ '--row-color': nodeColors.get(commit.hash) }"
                @contextmenu="menu.open($event, { kind: 'commit', commit })"
                @keydown="menu.keyboard($event, { kind: 'commit', commit })"
                :class="{ selected: store.selectedCommit?.hash === commit.hash }"
              >
                <button
                  class="commit-select"
                  :title="commit.subject"
                  :aria-label="`查看提交 ${commit.subject}`"
                  :aria-pressed="store.selectedCommit?.hash === commit.hash"
                  @click="store.selectCommit(commit)"
                ></button>
                <span
                  class="ref-cell"
                  :class="{
                    'has-reference': referenceHashes.has(commit.hash),
                    'is-current-reference': commit.hash === currentReferenceHash,
                  }"
                  :style="{ '--ref-color': nodeColors.get(commit.hash) }"
                >
                  <span
                    v-if="referenceGroups(commit).length"
                    class="ref-labels"
                    :class="{
                      'is-expanded':
                        pointerExpandedReference === commit.hash ||
                        focusedExpandedReference === commit.hash,
                    }"
                    @mouseleave="referencePointerLeave(commit)"
                    @focusin="referenceFocusIn(commit, $event)"
                    @focusout="referenceFocusOut(commit, $event)"
                  >
                    <span
                      class="ref-labels-sizing"
                      aria-hidden="true"
                      inert
                    >
                      <ReferenceBadge
                        v-for="group in referenceGroups(commit).slice(0, 1)"
                        :key="group.key"
                        :group="group"
                        title=""
                        action-label=""
                        presentation
                      />
                      <span
                        v-if="referenceGroups(commit).length > 1"
                        class="ref-more-sizing"
                        >+{{ referenceGroups(commit).length - 1 }}</span
                      >
                    </span>
                    <span class="ref-labels-content">
                      <ReferenceBadge
                        v-for="group in referenceGroups(commit).slice(0, 1)"
                        :key="group.key"
                        :group="group"
                        :title="referenceTitle(group)"
                        :action-label="referenceActionLabel(group.primary)"
                        :busy="store.busy"
                        @expand="(event) => expandFromPointer(commit, event)"
                        @activate="
                          (reference, event) => activateReference(commit, reference, event)
                        "
                        @inspect="(_, event) => showReferences(commit, event)"
                        @menu="(event, reference) => referenceMenu(event, reference, commit)"
                        @keyboard="
                          (event, reference) => referenceKeyboard(event, reference, commit)
                        "
                      />
                      <button
                        v-if="referenceGroups(commit).length > 1"
                        class="ref-more"
                        :title="moreDescription(commit)"
                        :aria-label="moreDescription(commit)"
                        @click="showReferences(commit, $event)"
                      >
                        +{{ referenceGroups(commit).length - 1 }}
                      </button>
                    </span>
                  </span>
                </span>
                <span
                  class="graph-lane-cell"
                  :class="{ 'has-reference': references(commit).length > 0 }"
                ></span
                ><span
                  class="commit-message"
                  :title="commit.subject"
                  ><Icon
                    v-if="commit.parents.length > 1"
                    name="GitMerge"
                    :size="13"
                  /><span>{{ commit.subject }}</span></span
                >
                <span class="author-cell"
                  ><span
                    class="avatar"
                    :class="{ violet: commit.author !== store.visibleCommits[0]?.author }"
                    >{{ commit.author.slice(0, 1).toUpperCase() }}</span
                  ><span>{{ commit.author }}</span></span
                >
                <span
                  class="time-cell"
                  :title="new Date(commit.date).toLocaleString('zh-CN')"
                  >{{ relative(commit.date) }}</span
                ><span class="sha-cell">{{ commit.hash.slice(0, 7) }}</span>
              </div>
            </template></template
          >
          <div
            v-if="!graph.rows.length"
            class="empty-state"
          >
            <Icon
              :name="searching ? 'Search' : 'GitCommitHorizontal'"
              :size="30"
            /><strong>{{ searching ? '没有匹配的提交' : '从第一次提交开始' }}</strong>
            <p>
              {{
                searching
                  ? '试试其他关键词，或清除分支筛选。'
                  : '暂存文件并填写提交说明，创建第一条记录。'
              }}
            </p>
            <button
              v-if="searching"
              class="text-button"
              @click="clearHistoryFilters"
            >
              清除筛选
            </button>
          </div>
        </div>
      </div>
      <div
        v-if="store.visibleCommits.length"
        class="history-end"
      >
        <span></span
        ><Icon
          name="GitCommitHorizontal"
          :size="14"
        /><small>{{
          store.repo.total > 250
            ? '显示最近 250 条提交'
            : searching
              ? `找到 ${store.visibleCommits.length} 条提交`
              : '故事，从这里开始'
        }}</small
        ><span></span>
      </div>
    </div>
    <DiffViewer v-if="store.selectedFile" />
    <MergeEditor v-if="merge.session.editor && merge.session.file" />
    <footer class="history-footer">
      <span><span class="legend-dot teal"></span>颜色区分图谱轨道</span
      ><span
        >{{ store.visibleCommits.length }} 条提交<span v-if="visibleStashes.length">
          · {{ visibleStashes.length }} 条贮藏</span
        ><span class="footer-separator">·</span>拓扑排序</span
      >
    </footer>
    <dialog
      ref="refsDialog"
      class="refs-dialog"
      aria-labelledby="refs-title"
      @click="$event.target === refsDialog && closeReferences()"
      @close="restoreReferenceFocus"
    >
      <header>
        <div>
          <h2 id="refs-title">提交引用</h2>
          <code>{{ refsCommit?.hash.slice(0, 7) }}</code>
        </div>
        <button
          class="icon-button"
          aria-label="关闭引用列表"
          @click="closeReferences"
        >
          <Icon
            name="X"
            :size="18"
          />
        </button>
      </header>
      <p>{{ refsCommit?.subject }}</p>
      <ul>
        <li
          v-for="reference in refsCommit ? references(refsCommit) : []"
          :key="reference.key"
        >
          <Icon
            :name="
              reference.kind === 'local'
                ? 'Laptop'
                : reference.kind === 'remote'
                  ? 'Cloud'
                  : reference.kind === 'tag'
                    ? 'Tag'
                    : 'GitBranch'
            "
            :size="15"
          /><span>{{ reference.label }}</span
          ><strong v-if="reference.current">当前分支</strong
          ><code class="reference-full-name">{{
            reference.branch ? reference.key : reference.rawLabel
          }}</code>
        </li>
      </ul>
    </dialog>
  </main>
</template>

<style scoped>
.stash-row {
  height: var(--history-row-height);
  width: 100%;
  padding: 0;
  gap: 0;
  align-items: center;
  text-align: left;
  font-size: 12px;
  color: var(--text);
  box-shadow: inset 0 -1px #ffffff03;
  position: relative;
  background: #bd93d704;
}
.stash-row:hover {
  background: var(--control-hover-bg);
}
.stash-row.selected {
  background: var(--view-selection-bg);
}
.stash-row-label {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  margin-left: 10px;
  gap: 5px;
  padding: 2px 6px;
  font-size: 10px;
  color: #d4b4e6;
  border: 1px solid #bd93d755;
  border-radius: 3px;
}
.stash-row-message {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  padding-left: 12px;
  color: #d4b4e6;
}
.stash-row .author-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.stash-graph-node {
  pointer-events: all;
  cursor: default;
}
</style>
