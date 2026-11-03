<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { branchReference, sidebarBranchKey } from '../references'
import { branchTracking } from '../branchTracking'
import type { Branch } from '../types'
import { useRepositoryStore } from '../stores/repository'
import { useContextMenuStore } from '../stores/contextMenu'
import Icon from './Icon.vue'
import { useSidebarStore } from '../stores/sidebar'

const props = withDefaults(
  defineProps<{ branch: Branch; depth?: number; label?: string; section?: string }>(),
  { depth: 1, section: 'local' },
)
const store = useRepositoryStore(),
  menu = useContextMenuStore(),
  sidebar = useSidebarStore()
const selectionKey = computed(() => sidebarBranchKey(props.section, props.branch))
const favorite = computed(() => sidebar.isFavorite(store.repo.path, props.branch))
const selected = computed(
  () =>
    store.branchFilter === branchReference(props.branch) &&
    store.sidebarBranchSelection === selectionKey.value,
)
const nameElement = ref<HTMLElement>()
const nameTipId = useId()
const nameTip = ref<{ left: number; top: number; maxWidth: number; above: boolean } | null>(null)
let pointerIn = false,
  keyboardIn = false
const tracking = computed(() => branchTracking(props.branch))
const branchHint = computed(() => {
  let hint = `单击筛选 ${props.branch.name}`
  if (props.branch.current) hint += '；当前分支'
  if (props.branch.kind === 'local' && !props.branch.current) {
    hint += store.busy
      ? '；操作进行中，暂不能切换'
      : props.branch.worktreePath
        ? '，双击打开所在工作区'
        : '，双击切换分支'
  }
  if (props.branch.kind === 'remote' && !props.branch.symbolicTarget) hint += '；双击检出远程分支'
  if (tracking.value.description) hint += `；${tracking.value.description}`
  return hint
})
function hideName() {
  nameTip.value = null
}
function showName(event: MouseEvent | FocusEvent) {
  if (event.type === 'focus') {
    keyboardIn = (event.currentTarget as HTMLElement).matches(':focus-visible')
    if (!keyboardIn) return
  } else pointerIn = true
  const name = nameElement.value
  if (
    !name ||
    (name.scrollWidth <= name.clientWidth && (!props.label || props.label === props.branch.name))
  )
    return
  const rect = name.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 160))
  const above = window.innerHeight - rect.bottom < 80
  nameTip.value = {
    left,
    top: above ? rect.top - 8 : rect.bottom + 8,
    maxWidth: Math.min(640, window.innerWidth - left - 8),
    above,
  }
}
function leaveName(event: MouseEvent | FocusEvent) {
  if (event.type === 'blur') keyboardIn = false
  else pointerIn = false
  if (!pointerIn && !keyboardIn) hideName()
}
function dismissName(event: KeyboardEvent) {
  if (event.key === 'Escape') hideName()
}
function clearNameListeners() {
  window.removeEventListener('scroll', hideName, true)
  window.removeEventListener('resize', hideName)
  window.removeEventListener('keydown', dismissName)
}
watch(
  nameTip,
  (tip) => {
    clearNameListeners()
    if (tip) {
      window.addEventListener('scroll', hideName, true)
      window.addEventListener('resize', hideName)
      window.addEventListener('keydown', dismissName)
    }
  },
  { flush: 'sync' },
)
watch(() => store.modal, hideName)
watch(() => props.branch.name, hideName)
onBeforeUnmount(clearNameListeners)
async function toggleFavorite() {
  const key = selectionKey.value
  sidebar.toggleFavorite(store.repo.path, props.branch)
  // Pinning may move a GitFlow entry between its category and the favorites area.
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const row = [...document.querySelectorAll<HTMLElement>('.branch-row[data-navigation-key]')].find(
    (row) => row.dataset.navigationKey === key,
  )
  const hidden = row?.closest<HTMLElement>('.sidebar-disclosure[inert]')
  const target = hidden
    ? [...document.querySelectorAll<HTMLButtonElement>('button[aria-controls]')].find(
        (button) => button.getAttribute('aria-controls') === hidden.id,
      )
    : row?.querySelector<HTMLButtonElement>('.branch-favorite')
  target?.focus({ preventScroll: true })
}
function checkout() {
  hideName()
  if (
    store.busy ||
    props.branch.kind === 'tag' ||
    props.branch.symbolicTarget ||
    props.branch.current
  )
    return
  void store.checkoutBranch(props.branch)
}
function filterBranch(event: MouseEvent) {
  // A double-click emits two clicks before dblclick; apply the toggle only once.
  if (event.detail > 1) return
  store.setBranchFilter(props.branch, selectionKey.value, true)
}
function doubleClick() {
  store.setBranchFilter(props.branch, selectionKey.value)
  checkout()
}
function openBranchMenu(event: MouseEvent) {
  hideName()
  menu.open(event, { kind: 'branch', branch: props.branch })
}
</script>

<template>
  <div
    class="branch-row"
    :data-navigation-key="selectionKey"
    :data-branch-name="branch.name"
    :data-branch-kind="branch.kind"
    :data-depth="depth"
    :style="{ '--branch-depth': depth }"
    :class="{ current: branch.current, filtered: selected }"
    @contextmenu="openBranchMenu"
    @keydown="menu.keyboard($event, { kind: 'branch', branch })"
  >
    <button
      class="branch-main"
      :aria-pressed="selected"
      :aria-label="branchHint"
      :aria-describedby="nameTip ? nameTipId : undefined"
      :title="nameTip ? undefined : branchHint"
      @mouseenter="showName"
      @mouseleave="leaveName"
      @focus="showName"
      @blur="leaveName"
      @click="filterBranch"
      @dblclick="doubleClick"
    >
      <Icon
        class="branch-kind-icon"
        :name="branch.kind === 'tag' ? 'Tag' : 'GitBranch'"
        :size="14"
      />
      <span
        ref="nameElement"
        class="branch-name"
        >{{ label || branch.name }}</span
      >
      <small
        v-if="branch.current || tracking.label"
        class="branch-meta"
        :title="tracking.description || '当前分支'"
        aria-hidden="true"
      >
        <Icon
          v-if="branch.current"
          class="branch-current-check"
          name="Check"
          :size="14"
        />
        <span
          v-if="tracking.ahead"
          class="branch-sync-count is-ahead"
          >↑{{ tracking.ahead }}</span
        >
        <span
          v-if="tracking.behind"
          class="branch-sync-count is-behind"
          >↓{{ tracking.behind }}</span
        >
        <span
          v-if="tracking.label && !tracking.ahead && !tracking.behind"
          class="branch-sync-state"
          :class="{ 'is-warning': tracking.state === 'gone' || tracking.state === 'unknown' }"
          >{{ tracking.state === 'gone' ? '上游缺失' : tracking.label }}</span
        >
      </small>
    </button>
    <button
      class="branch-favorite icon-button"
      :class="{ 'is-favorite': favorite }"
      :aria-pressed="favorite"
      :aria-label="`${favorite ? '取消收藏' : '收藏'} ${branch.name}`"
      :title="favorite ? '取消收藏' : '收藏并置顶'"
      @click.stop="toggleFavorite"
      @dblclick.stop
    >
      <Icon
        name="Star"
        :size="13"
      />
    </button>
    <Teleport
      v-if="nameTip"
      to="body"
      ><div
        :id="nameTipId"
        class="branch-name-tooltip"
        role="tooltip"
        :style="{
          left: `${nameTip.left}px`,
          top: `${nameTip.top}px`,
          maxWidth: `${nameTip.maxWidth}px`,
          transform: nameTip.above ? 'translateY(-100%)' : undefined,
        }"
      >
        {{ branch.name }}
      </div></Teleport
    >
  </div>
</template>
