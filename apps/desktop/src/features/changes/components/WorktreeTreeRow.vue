<script setup lang="ts">
import { vOverflowTitle } from '../../../shared/ui/overflowTitle'
import { computed } from 'vue'
import Icon from '../../../shared/ui/Icon.vue'
import { fileStatusPresentation } from '../../../shared/lib/fileStatus'
import type { WorktreeChange, WorktreeNode } from '../worktree'
import { stagingSelectionState } from '../worktree'
import { useContextMenuStore } from '../../../app/stores/contextMenu'
const menu = useContextMenuStore()

const props = withDefaults(
  defineProps<{
    zone: 'unstaged' | 'staged'
    node: WorktreeNode
    selected: Set<string>
    collapsed: string[]
    activePath?: string
    activeStaged?: boolean
    busy?: boolean
    depth?: number
    parentKey?: string
    detailed?: boolean
    layout?: 'tree' | 'list'
  }>(),
  { depth: 0, parentKey: '', layout: 'tree' },
)
const emit = defineEmits<{
  choose: [files: WorktreeChange[], checked: boolean]
  toggle: [key: string]
  inspect: [file: WorktreeChange, trigger: HTMLElement]
  act: [file: WorktreeChange, trigger: HTMLElement]
}>()
const state = computed(() => stagingSelectionState(props.node.files, props.selected))
const open = computed(() => !props.collapsed.includes(props.node.key))
const fullPath = computed(() =>
  props.node.file?.oldPath ? `${props.node.file.oldPath} → ${props.node.path}` : props.node.path,
)
const directory = computed(() =>
  props.node.path.includes('/') ? props.node.path.slice(0, props.node.path.lastIndexOf('/')) : '',
)
const status = computed(() =>
  fileStatusPresentation(props.node.file?.conflict ? 'U' : props.node.file?.status || ''),
)
const folderStatus = computed(() =>
  props.node.files.some((file) => file.conflict)
    ? 'conflict'
    : props.node.files.every((file) => file.status === '?')
      ? 'untracked'
      : 'modified',
)
function keydown(event: KeyboardEvent) {
  menu.keyboard(event, {
    kind: 'files',
    files: props.node.files,
    staged: props.zone === 'staged',
    label: props.node.path,
  })
  if (event.defaultPrevented) return
  const row = event.currentTarget as HTMLElement
  const root = row.closest('.worktree-tree')
  if (!root) return
  const targets = [...root.querySelectorAll<HTMLButtonElement>('.worktree-row-main')].filter(
    (button) => button.getClientRects().length && !button.disabled,
  )
  const current = row.querySelector<HTMLButtonElement>('.worktree-row-main')
  const index = current ? targets.indexOf(current) : -1
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    targets[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    return
  }
  if (event.key === 'ArrowRight' && props.node.kind !== 'file') {
    event.preventDefault()
    if (!open.value) emit('toggle', props.node.key)
    else targets[index + 1]?.focus()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (props.node.kind !== 'file' && open.value) emit('toggle', props.node.key)
    else
      [...root.querySelectorAll<HTMLElement>('.worktree-node-row')]
        .find((item) => item.dataset.worktreeKey === props.parentKey)
        ?.querySelector<HTMLButtonElement>('.worktree-row-main')
        ?.focus()
  } else if (event.key === ' ' && event.target === current) {
    event.preventDefault()
    if (!props.busy) {
      if (props.node.file) emit('choose', props.node.files, !state.value.checked)
      else emit('toggle', props.node.key)
    }
  }
}
</script>

<template>
  <div
    class="worktree-entry"
    role="treeitem"
    :aria-expanded="node.kind !== 'file' ? open : undefined"
  >
    <div
      class="worktree-node-row"
      :class="{
        'worktree-file-row': node.kind === 'file',
        'file-row': node.kind === 'file',
        selected: node.file && activePath === node.path && activeStaged === (zone === 'staged'),
        'worktree-group-row': node.kind === 'group',
        'is-active': node.file && activePath === node.path && activeStaged === (zone === 'staged'),
        'is-checked': node.file && selected.has(node.path),
        'is-detailed': detailed && node.kind === 'file',
        'is-conflict': node.file?.conflict,
      }"
      :data-file-status="
        node.file ? status.kind : node.kind === 'directory' ? folderStatus : undefined
      "
      :data-worktree-key="node.key"
      :data-worktree-path="node.file ? node.path : undefined"
      :style="{ '--worktree-depth': depth }"
      @keydown="keydown"
      @contextmenu="
        menu.open($event, {
          kind: 'files',
          files: node.files,
          staged: zone === 'staged',
          label: node.path,
        })
      "
    >
      <button
        v-if="node.kind !== 'file'"
        class="worktree-disclosure"
        :aria-label="`展开或折叠 ${node.path || node.label}`"
        :aria-expanded="open"
        @click="emit('toggle', node.key)"
      >
        <Icon
          name="ChevronRight"
          :size="12"
          :class="{ 'is-open': open }"
        />
      </button>

      <input
        v-if="node.file"
        type="checkbox"
        class="worktree-checkbox"
        :aria-label="`${zone === 'staged' ? '选择取消暂存' : '选择暂存'} ${node.path}`"
        :checked="state.checked"
        :indeterminate="state.mixed"
        :disabled="busy || state.disabled || node.file.conflict"
        @click.stop
        @change="emit('choose', node.files, ($event.target as HTMLInputElement).checked)"
      />
      <button
        v-if="node.file"
        class="worktree-row-main worktree-file-main file-main"
        :data-file-path="node.path"
        :data-file-staged="zone === 'staged'"
        data-file-historical="false"
        :aria-label="`查看文件差异 ${fullPath}`"
        :aria-pressed="activePath === node.path && activeStaged === (zone === 'staged')"
        v-overflow-title="{
          text: menu.hoverTitle(fullPath),
          target: '.file-basename, .file-directory',
        }"
        :disabled="busy"
        @click="emit('inspect', node.file, $event.currentTarget as HTMLElement)"
      >
        <Icon
          :name="node.file.status === 'D' ? 'FileText' : 'FileCode2'"
          :size="14"
        />
        <span
          class="worktree-file-caption file-name"
          :class="{ 'has-directory': directory }"
          ><span class="worktree-file-name file-basename">{{ node.label }}</span
          ><small
            v-if="directory && (detailed || layout === 'list')"
            class="file-directory"
            >{{ directory }}</small
          ></span
        >
        <span
          v-if="node.file.partial"
          class="worktree-index-badge"
          >部分暂存</span
        >

        <span
          class="worktree-file-status file-status"
          :class="`status-${status.code}`"
          :title="menu.hoverTitle(status.label)"
          >{{ status.code }}</span
        >
      </button>
      <button
        v-else
        class="worktree-row-main worktree-folder-main"
        v-overflow-title="{ text: menu.hoverTitle(node.path || node.label), target: 'span' }"
        @click="emit('toggle', node.key)"
      >
        <Icon
          name="FolderOpen"
          :size="14"
        /><span>{{ node.label }}</span
        ><small>{{ node.files.length }}</small>
      </button>
      <button
        v-if="node.file"
        class="icon-button file-action"
        :disabled="busy || node.file.conflict"
        :aria-label="`${zone === 'staged' ? '取消暂存' : '暂存'} ${node.path}`"
        :title="menu.hoverTitle(zone === 'staged' ? '取消暂存' : '暂存文件')"
        @click="emit('act', node.file, $event.currentTarget as HTMLElement)"
      >
        <Icon
          :name="zone === 'staged' ? 'Minus' : 'Plus'"
          :size="14"
        />
      </button>
    </div>
    <div
      v-if="node.kind !== 'file' && open"
      role="group"
    >
      <WorktreeTreeRow
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :zone="zone"
        :selected="selected"
        :collapsed="collapsed"
        :active-path="activePath"
        :active-staged="activeStaged"
        :busy="busy"
        :depth="depth + (node.kind === 'group' ? 0 : 1)"
        :parent-key="node.key"
        :detailed="detailed"
        :layout="layout"
        @choose="(files, checked) => emit('choose', files, checked)"
        @toggle="(key) => emit('toggle', key)"
        @inspect="(file, trigger) => emit('inspect', file, trigger)"
        @act="(file, trigger) => emit('act', file, trigger)"
      />
    </div>
  </div>
</template>

<style scoped>
.worktree-node-row {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 32px;
  padding: 0 8px 0 calc(4px + var(--worktree-depth) * 16px);
  gap: 5px;
  border-radius: 3px;
}
.worktree-node-row.file-row {
  height: 32px;
  margin: 0;
  border-radius: 3px;
}
.worktree-node-row:hover {
  background: var(--control-hover-bg);
}
.worktree-node-row.is-active {
  background: var(--view-selection-bg);
}
.worktree-node-row.is-active:hover {
  background: var(--view-selection-hover-bg);
}
.worktree-group-row {
  min-height: 30px;
  margin-top: 4px;
  font-weight: 600;
}
.worktree-disclosure,
.worktree-disclosure-space {
  flex-shrink: 0;
  width: 16px;
  height: 24px;
}
.worktree-disclosure {
  color: var(--icon-color);
}
.worktree-disclosure svg {
  transition: transform 0.15s;
}
.worktree-disclosure .is-open {
  transform: rotate(90deg);
}
.worktree-checkbox {
  appearance: auto;
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  margin: 0 2px 0 0;
  accent-color: var(--accent);
  cursor: default;
}
.worktree-checkbox:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.worktree-checkbox:disabled {
  opacity: 0.5;
}
.worktree-row-main {
  min-width: 0;
  flex: 1;
  min-height: 32px;
  justify-content: flex-start;
  gap: 6px;
  font-size: var(--ui-font-size);
  text-align: left;
}
.worktree-row-main > svg {
  flex-shrink: 0;
  color: var(--icon-color);
}
.worktree-file-main {
  padding: 0;
}
.worktree-file-caption.file-name {
  font-size: var(--ui-font-help);
  flex-direction: row;
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.worktree-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.worktree-file-caption.file-name small {
  color: var(--muted);
  font-size: var(--ui-font-help);
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  min-width: 0;
}
.worktree-folder-main > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worktree-folder-main > small {
  margin-left: auto;
  color: var(--muted);
  font: var(--ui-font-help)/1.5 var(--mono);
  font-weight: 400;
}
.worktree-index-badge {
  flex-shrink: 0;
  font-size: var(--ui-font-help);
  color: var(--muted);
}
.worktree-file-status {
  flex-shrink: 0;
  margin-left: auto;
  font: var(--ui-font-help)/1.5 var(--mono);
}
.is-detailed.file-row {
  height: 40px;
  min-height: 40px;
}
.is-detailed .worktree-row-main {
  min-height: 40px;
}
.is-detailed .worktree-file-caption.file-name {
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 2px;
}
.file-action {
  flex-shrink: 0;
  width: 22px;
  height: 24px;
  opacity: 0;
  pointer-events: none;
}
.worktree-node-row:hover .file-action:not(:disabled),
.worktree-node-row:focus-within .file-action:not(:disabled) {
  opacity: 1;
  pointer-events: auto;
}
.file-action:disabled {
  opacity: 0.35;
  pointer-events: none;
}
.worktree-file-caption.has-directory .file-basename {
  flex: 0 1 auto;
  max-width: 70%;
}
.worktree-file-caption .file-directory {
  flex: 1;
  min-width: 0;
}
.is-detailed .worktree-file-caption .file-basename {
  max-width: 100%;
}
.is-detailed .worktree-file-caption .file-directory {
  flex: none;
}
@media (prefers-reduced-motion: reduce) {
  .worktree-disclosure svg {
    transition: none;
  }
}
</style>
