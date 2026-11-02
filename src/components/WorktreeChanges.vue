<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import WorktreeTreeRow from './WorktreeTreeRow.vue'
import { useRepositoryStore } from '../stores/repository'
import { useMergeStore } from '../stores/merge'
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
    const selected = worktree.selected(store.repo.path, zone, files)
    const visible = new Set(matching.map((file) => file.path))
    return {
      id: zone,
      title: zone === 'staged' ? '已暂存' : '未暂存',
      files,
      matching,
      selected,
      hidden: [...selected].filter((path) => !visible.has(path)).length,
      state: stagingSelectionState(matching, selected),
      nodes: buildStagingTree(matching, zone, view.value.layout, view.value.compress),
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
  if (!store.busy) worktree.choose(store.repo.path, zone, files, checked)
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
function dismissMenu(event: PointerEvent | KeyboardEvent) {
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
  document.removeEventListener('keydown', dismissMenu)
}
function menuToggle() {
  clearMenuListeners()
  if (menuElement.value?.open) {
    document.addEventListener('pointerdown', dismissMenu)
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
      <details
        ref="menuElement"
        class="worktree-view-menu"
        @toggle="menuToggle"
      >
        <summary
          aria-label="工作区视图选项"
          title="分组与显示方式"
        >
          <Icon
            name="Settings2"
            :size="15"
          />
        </summary>
        <div class="worktree-menu-content">
          <strong>分组</strong>
          <label
            ><input
              type="radio"
              name="worktree-layout"
              aria-label="目录视图"
              :checked="view.layout === 'tree'"
              @change="worktree.update(store.repo.path, { layout: 'tree' })"
            />目录</label
          >
          <label
            ><input
              type="radio"
              name="worktree-layout"
              aria-label="列表视图"
              :checked="view.layout === 'list'"
              @change="worktree.update(store.repo.path, { layout: 'list' })"
            />列表</label
          >
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
      >
        <div class="staging-zone-header">
          <input
            type="checkbox"
            class="zone-select-all"
            :aria-label="`全选${zone.title}匹配文件`"
            :checked="zone.state.checked"
            :indeterminate="zone.state.mixed"
            :disabled="store.busy || zone.state.disabled"
            @change="choose(zone.id, zone.matching, ($event.target as HTMLInputElement).checked)"
          />
          <h3
            class="staging-zone-title"
            tabindex="-1"
          >
            {{ zone.title }} <small>{{ zone.files.length }}</small>
          </h3>
          <button
            class="staging-batch-action"
            :disabled="store.busy || !zone.selected.size"
            @click="act(zone.id, [...zone.selected], $event.currentTarget as HTMLElement)"
          >
            {{ zone.id === 'staged' ? '取消暂存所选' : '暂存所选' }}（{{ zone.selected.size }}）
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
  font-size: 11px;
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
  width: 190px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  box-shadow: 0 6px 22px #0005;
  background: var(--surface-raised);
}
.worktree-menu-content strong {
  display: block;
  padding: 5px 6px 3px;
  font-size: 10px;
  color: var(--muted);
}
.worktree-menu-content label,
.worktree-menu-content > button {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  min-height: 28px;
  gap: 7px;
  padding: 0 6px;
  font-size: 11px;
  border-radius: 3px;
}
.worktree-menu-content > button:hover,
.worktree-menu-content label:hover {
  background: var(--control-hover-bg);
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
  overflow: auto;
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
  font-size: 11px;
  font-weight: 600;
}
.staging-zone-title small {
  margin-left: 5px;
  color: var(--muted);
  font: 10px var(--mono);
}
.staging-zone-title:focus-visible {
  outline: 1px solid var(--focus-ring);
  outline-offset: 2px;
}
.staging-batch-action {
  min-height: 25px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
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
  font-size: 10px;
  color: var(--text-secondary);
}
.zone-selection-summary button {
  font-size: 10px;
}
.staging-selection-note {
  margin: 0;
  padding: 0 10px 5px;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.5;
}
.worktree-tree {
  min-height: 0;
  padding: 0 6px 6px;
}
.worktree-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  padding: 24px 12px;
  color: var(--muted);
  font-size: 11px;
}
</style>
