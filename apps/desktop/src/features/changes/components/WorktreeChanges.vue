<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '../../../shared/ui/Icon.vue'
import FileViewToggle from './FileViewToggle.vue'
import WorktreeTreeRow from './WorktreeTreeRow.vue'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useMergeStore } from '../../merge/stores/merge'
import { useStagingStore } from '../stores/staging'
import { useFileViewStore } from '../stores/fileView'
import {
  buildStagingTree,
  collectWorktreeChanges,
  filterWorktreeChanges,
  stagingSelectionState,
} from '../worktree'
import type { WorktreeChange, StagingZone } from '../worktree'

const store = useRepositoryStore(),
  worktree = useStagingStore(),
  density = useFileViewStore()
const menuElement = ref<HTMLDetailsElement>()
const view = computed(() => worktree.view(store.repo.path))
const root = ref<HTMLElement>()
const collapsedZones = ref(new Set<StagingZone>())
watch(
  () => store.repo.path,
  () => {
    collapsedZones.value = new Set()
  },
)
function toggleZone(zone: StagingZone) {
  const next = new Set(collapsedZones.value)
  if (next.has(zone)) next.delete(zone)
  else next.add(zone)
  collapsedZones.value = next
}
const zones = computed(() => {
  const metadata = new Map(
    collectWorktreeChanges(store.repo.staged, store.repo.unstaged).map((file) => [file.path, file]),
  )
  return (['unstaged', 'staged'] as const).map((zone) => {
    const files = store.repo[zone].map((version) => ({
      ...metadata.get(version.path)!,
      ...version,
      oldPath: version.oldPath,
    }))
    const matching = filterWorktreeChanges(files, view.value.query)
    const eligible = matching.filter((file) => !file.conflict)
    const selected = worktree.selected(
      store.repo.path,
      zone,
      files.filter((file) => !file.conflict),
    )
    const visible = new Set(matching.map((file) => file.path))
    const paths = selected.size ? [...selected] : eligible.map((file) => file.path)
    const nodes = buildStagingTree(matching, zone, view.value.layout, view.value.compress)
    const rowCount = (items: typeof nodes): number =>
      items.reduce(
        (count, node) =>
          count +
          1 +
          (node.kind !== 'file' && !view.value.collapsed.includes(node.key)
            ? rowCount(node.children)
            : 0),
        0,
      )
    const rows = rowCount(nodes)
    const label = selected.size
      ? `${zone === 'staged' ? '取消暂存所选' : '暂存所选'}（${paths.length}）`
      : view.value.query.trim()
        ? `${zone === 'staged' ? '取消暂存匹配' : '暂存匹配'}（${paths.length}）`
        : zone === 'staged'
          ? '全部取消暂存'
          : '全部暂存'
    return {
      id: zone,
      paths,
      label,
      rows,
      maxHeight:
        40 +
        rows * (density.modes.worktree === 'compact' ? 32 : 40) +
        (selected.size ? 28 : 0) +
        (zone === 'staged' && selected.size ? 34 : 0),
      title: zone === 'staged' ? '已暂存' : '未暂存',
      files,
      matching,
      selected,
      hidden: [...selected].filter((path) => !visible.has(path)).length,
      state: stagingSelectionState(eligible, selected),
      nodes,
    }
  })
})
watch(
  [
    () => store.repo.path,
    () => store.repo.head,
    () => store.repo.branch,
    () => store.repo.staged,
    () => store.repo.unstaged,
  ],
  () => {
    if (
      worktree.reconcile(
        store.repo.path,
        { staged: store.repo.staged, unstaged: store.repo.unstaged },
        `${store.repo.branch}\0${store.repo.head}`,
      )
    )
      store.notify('分支或 HEAD 已变化，已清除批量操作勾选。')
  },
  { immediate: true },
)
function choose(zone: StagingZone, files: WorktreeChange[], checked: boolean) {
  if (!store.busy)
    worktree.choose(
      store.repo.path,
      zone,
      files.filter((file) => !file.conflict),
      checked,
    )
}
function inspect(zone: StagingZone, file: WorktreeChange, trigger?: HTMLElement) {
  if (file.conflict) {
    void useMergeStore().openFile(file.path)
    return
  }
  void store.selectFile(file, zone === 'staged', trigger)
}
async function act(zone: StagingZone, paths: string[], trigger?: HTMLElement) {
  if (store.busy || !paths.length) return
  const path = store.repo.path,
    context = `${store.repo.branch}\0${store.repo.head}`
  const section = root.value?.querySelector<HTMLElement>(`[data-staging-zone="${zone}"]`)
  const before = [...(section?.querySelectorAll<HTMLElement>('.file-main') || [])]
  const origin = trigger?.closest('.file-row')?.querySelector<HTMLElement>('.file-main')
  const index = origin ? before.indexOf(origin) : 0
  const succeeded = await store.run(zone === 'staged' ? 'unstage' : 'stage', { paths })
  if (store.repo.path !== path || `${store.repo.branch}\0${store.repo.head}` !== context) return
  if (succeeded) worktree.remove(path, zone, paths)
  else await store.refresh()
  if (store.repo.path !== path || `${store.repo.branch}\0${store.repo.head}` !== context) return
  worktree.reconcile(path, { staged: store.repo.staged, unstaged: store.repo.unstaged }, context)
  await nextTick()
  // Retain source-zone position when the operated row is removed, including batch operations.
  if (!origin || !origin.isConnected) {
    const after = [...(section?.querySelectorAll<HTMLElement>('.file-main') || [])]
    ;(
      after[Math.min(Math.max(index, 0), after.length - 1)] ||
      section?.querySelector<HTMLElement>('.staging-zone-title')
    )?.focus()
  } else if (trigger?.isConnected) trigger.focus()
}
function dismissMenu(event: PointerEvent | KeyboardEvent | FocusEvent) {
  if (event.type === 'keydown') {
    if ((event as KeyboardEvent).key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    menuElement.value?.removeAttribute('open')
    menuElement.value?.querySelector<HTMLElement>('summary')?.focus()
  } else if (!menuElement.value?.contains(event.target as Node))
    menuElement.value?.removeAttribute('open')
}
function clearMenuListeners() {
  document.removeEventListener('pointerdown', dismissMenu)
  document.removeEventListener('focusin', dismissMenu)
  document.removeEventListener('keydown', dismissMenu)
}
function menuToggle() {
  clearMenuListeners()
  if (menuElement.value?.open) {
    document.addEventListener('pointerdown', dismissMenu)
    document.addEventListener('focusin', dismissMenu)
    document.addEventListener('keydown', dismissMenu)
  }
}
watch([() => store.repo.path, () => store.modal], () => menuElement.value?.removeAttribute('open'))
onBeforeUnmount(clearMenuListeners)
</script>

<template>
  <div
    ref="root"
    class="worktree-changes"
  >
    <div class="worktree-toolbar">
      <label class="worktree-search"
        ><Icon
          name="Search"
          :size="13" /><input
          autocomplete="off"
          :value="view.query"
          aria-label="筛选工作区文件"
          placeholder="筛选文件或路径…"
          @input="
            worktree.update(store.repo.path, { query: ($event.target as HTMLInputElement).value })
          " /><button
          v-if="view.query"
          class="icon-button"
          aria-label="清除文件筛选"
          @click="worktree.update(store.repo.path, { query: '' })"
        >
          <Icon
            name="X"
            :size="12"
          /></button
      ></label>
      <div
        class="worktree-layout-toggle"
        role="group"
        aria-label="文件分组方式"
      >
        <button
          aria-label="列表视图"
          :aria-pressed="view.layout === 'list'"
          @click="worktree.update(store.repo.path, { layout: 'list' })"
        >
          列表
        </button>
        <button
          aria-label="目录视图"
          :aria-pressed="view.layout === 'tree'"
          @click="worktree.update(store.repo.path, { layout: 'tree' })"
        >
          目录
        </button>
      </div>
      <details
        ref="menuElement"
        class="worktree-view-menu"
        @toggle="menuToggle"
      >
        <summary
          aria-label="工作区视图选项"
          title="密度与目录设置"
        >
          <Icon
            name="Settings2"
            :size="15"
          />
        </summary>
        <div class="worktree-menu-content">
          <strong>文件显示密度</strong>
          <FileViewToggle context="worktree" />
          <label
            ><input
              type="checkbox"
              :checked="view.compress"
              :disabled="view.layout !== 'tree'"
              @change="
                worktree.update(store.repo.path, {
                  compress: ($event.target as HTMLInputElement).checked,
                })
              "
            />压缩连续目录</label
          >
        </div>
      </details>
    </div>
    <div class="staging-zones inspector-scroll changes-scroll">
      <section
        v-for="zone in zones"
        :key="zone.id"
        :data-staging-zone="zone.id"
        class="staging-zone"
        :aria-busy="store.indexWorking"
        :class="{ 'is-collapsed': collapsedZones.has(zone.id), 'is-empty': !zone.rows }"
        :style="{
          '--zone-weight': Math.max(1, zone.rows),
          maxHeight: collapsedZones.has(zone.id) || !zone.rows ? undefined : `${zone.maxHeight}px`,
        }"
      >
        <div class="staging-zone-header">
          <input
            v-if="zone.matching.length"
            type="checkbox"
            class="zone-select-all"
            :aria-label="`全选${zone.title}匹配文件`"
            :checked="zone.state.checked"
            :indeterminate="zone.state.mixed"
            :disabled="store.busy || zone.state.disabled"
            @change="choose(zone.id, zone.matching, ($event.target as HTMLInputElement).checked)"
          />
          <span
            v-else
            class="zone-checkbox-spacer"
            aria-hidden="true"
          ></span>
          <h3
            class="staging-zone-title"
            tabindex="-1"
          >
            <button
              :aria-label="`${collapsedZones.has(zone.id) ? '展开' : '折叠'}${zone.title}`"
              :aria-expanded="!collapsedZones.has(zone.id)"
              :aria-controls="`staging-files-${zone.id}`"
              @click="toggleZone(zone.id)"
            >
              <Icon
                name="ChevronRight"
                :size="12"
                :class="{ 'is-open': !collapsedZones.has(zone.id) }"
              />{{ zone.title }}
              <small>{{
                view.query.trim()
                  ? `${zone.matching.length}/${zone.files.length}`
                  : zone.files.length
              }}</small>
            </button>
          </h3>
          <span
            v-if="store.indexWorking"
            class="staging-zone-progress"
            role="status"
            ><Icon
              name="LoaderCircle"
              :size="12"
              class="spin"
            />{{
              store.activeOperation === 'stage'
                ? '暂存中'
                : store.activeOperation === 'unstage'
                  ? '取消中'
                  : '处理中'
            }}</span
          >
          <button
            v-if="zone.files.length"
            class="staging-batch-action"
            :disabled="store.busy || !zone.paths.length"
            :title="
              zone.selected.size
                ? `操作已勾选的 ${zone.selected.size} 项${zone.hidden ? `，包含隐藏 ${zone.hidden} 项` : ''}`
                : view.query.trim()
                  ? '仅操作筛选匹配的文件'
                  : '操作此分组的全部文件'
            "
            @click="act(zone.id, zone.paths, $event.currentTarget as HTMLElement)"
          >
            {{ zone.label }}
          </button>
        </div>
        <div
          v-if="zone.selected.size"
          class="zone-selection-summary"
          aria-live="polite"
        >
          <span
            v-if="zone.hidden"
            class="zone-hidden-count"
            >含隐藏 {{ zone.hidden }} 项</span
          ><button
            class="text-button"
            :disabled="store.busy"
            @click="worktree.remove(store.repo.path, zone.id, [...zone.selected])"
          >
            清除选择
          </button>
        </div>
        <p
          v-if="zone.id === 'staged' && zone.selected.size"
          class="staging-selection-note"
        >
          勾选用于取消暂存；提交范围仍为全部已暂存
        </p>
        <div
          :id="`staging-files-${zone.id}`"
          v-show="!collapsedZones.has(zone.id)"
          class="worktree-tree file-list"
          :class="density.modes.worktree === 'compact' ? 'file-list-compact' : 'file-list-detailed'"
          role="tree"
          :aria-label="`${zone.title}文件树`"
        >
          <WorktreeTreeRow
            v-for="node in zone.nodes"
            :key="node.key"
            :node="node"
            :zone="zone.id"
            :selected="zone.selected"
            :collapsed="view.collapsed"
            :active-path="store.selectedFile?.path"
            :active-staged="store.fileStaged"
            :busy="store.busy"
            :detailed="density.modes.worktree === 'detailed'"
            :layout="view.layout"
            @choose="(files, checked) => choose(zone.id, files, checked)"
            @toggle="(key) => worktree.toggle(store.repo.path, key)"
            @inspect="(file, trigger) => inspect(zone.id, file, trigger)"
            @act="(file, trigger) => act(zone.id, [file.path], trigger)"
          />
          <div
            v-if="!zone.nodes.length"
            class="worktree-empty"
          >
            {{
              view.query
                ? '没有匹配的文件'
                : zone.id === 'staged'
                  ? '暂无已暂存文件'
                  : '暂无未暂存更改'
            }}
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.worktree-changes {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.worktree-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 10px;
}
.worktree-search {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  height: 27px;
  gap: 6px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  background: var(--surface-input);
}
.worktree-search:focus-within {
  border-color: var(--focus-ring);
}
.worktree-search input {
  min-width: 0;
  width: 100%;
  font-size: var(--ui-font-size);
}
.worktree-search .icon-button {
  width: 20px;
  height: 22px;
}
.worktree-view-menu {
  position: relative;
}
.worktree-view-menu summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  border-radius: 4px;
  color: var(--icon-color);
  cursor: default;
}
.worktree-view-menu summary::-webkit-details-marker {
  display: none;
}
.worktree-view-menu summary:hover,
.worktree-view-menu[open] summary {
  background: var(--control-hover-bg);
}
.worktree-menu-content {
  position: absolute;
  z-index: 15;
  top: 31px;
  right: 0;
  width: max-content;
  min-width: 190px;
  max-width: calc(100vw - 16px);
  padding: 5px;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  line-height: 1.5;
  border: 1px solid var(--line);
  border-radius: 5px;
  box-shadow: 0 6px 22px var(--popup-shadow-color);
  background: var(--surface-raised);
}
.worktree-menu-content strong {
  display: block;
  padding: 5px 10px;
  font-size: var(--ui-font-help);
  color: var(--muted);
}
.worktree-menu-content label,
.worktree-menu-content > button {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  min-height: 30px;
  gap: 7px;
  padding: 5px 10px;
  font-size: var(--ui-font-size);
  white-space: nowrap;
  border-radius: 3px;
}
.worktree-menu-content > button:hover:not(:disabled),
.worktree-menu-content label:not(:has(input:disabled)):hover {
  background: var(--control-hover-bg);
}
.worktree-menu-content label:has(input:disabled) {
  color: var(--control-disabled-color);
}
.worktree-menu-content input {
  appearance: auto;
  margin: 0;
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
}
.worktree-menu-content hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 5px 0;
}
.staging-zones {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.staging-zone {
  display: flex;
  flex-direction: column;
  flex: var(--zone-weight) 1 0;
  min-height: 70px;
}
.staging-zone.is-collapsed,
.staging-zone.is-empty {
  flex: 0 0 auto;
  min-height: 0;
}
.staging-zone-header,
.zone-selection-summary,
.staging-selection-note {
  flex-shrink: 0;
}
.staging-zone-title button {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 5px;
  text-align: left;
  width: 100%;
  padding: 0;
  font: inherit;
}
.zone-checkbox-spacer {
  width: 13px;
  flex-shrink: 0;
}
.staging-zone[data-staging-zone='unstaged'] .staging-batch-action:not(:disabled) {
  color: var(--accent);
}
.staging-zone-title svg {
  transition: transform 120ms ease;
  flex-shrink: 0;
}
.staging-zone-title svg.is-open {
  transform: rotate(90deg);
}
.worktree-layout-toggle {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}
.worktree-layout-toggle button {
  padding: 4px 5px;
  font-size: var(--ui-font-size);
  color: var(--text-secondary);
  border-radius: 3px;
}
.worktree-layout-toggle button[aria-pressed='true'] {
  color: var(--bright);
  background: var(--view-selection-bg);
}
.staging-zone + .staging-zone {
  border-top: 1px solid var(--line);
}
.staging-zone-header {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 3px 10px;
}
.zone-select-all {
  appearance: auto;
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
}
.staging-zone-title {
  flex: 1;
  margin: 0;
  font-size: var(--ui-font-size);
  font-weight: 600;
}
.staging-zone-title small {
  margin-left: 5px;
  color: var(--muted);
  font: var(--ui-font-help)/1.5 var(--mono);
}
.staging-zone-title:focus-visible {
  outline: 1px solid var(--focus-ring);
  outline-offset: 2px;
}
.staging-batch-action {
  min-height: 25px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: var(--ui-font-size);
  color: var(--text-secondary);
}
.staging-batch-action:not(:disabled):hover {
  background: var(--control-hover-bg);
}
.zone-selection-summary {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 0 10px 4px;
  font-size: var(--ui-font-size);
  color: var(--text-secondary);
}
.zone-selection-summary button {
  font-size: var(--ui-font-size);
}
.staging-selection-note {
  margin: 0;
  padding: 0 10px 5px;
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
  line-height: 1.5;
}
.worktree-tree {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 0 6px 6px;
}
.worktree-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  padding: 7px 12px;
  color: var(--muted);
  font-size: var(--ui-font-help);
}
</style>
