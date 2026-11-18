<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'
import SidebarCollapse from './SidebarCollapse.vue'
import { useContextMenuStore } from '../stores/contextMenu'
const menu = useContextMenuStore()
const labelElement = ref<HTMLElement>()
const labelClipped = ref(false)
function measureLabel() {
  labelClipped.value =
    !!labelElement.value && labelElement.value.scrollWidth > labelElement.value.clientWidth
}
import { useSidebarStore } from '../stores/sidebar'
import { useRepositoryStore } from '../stores/repository'
const props = defineProps<{
  nodeKey: string
  label: string
  depth: number
  query: string
  remote?: boolean
  flowGroup?: string
}>()
const sidebar = useSidebarStore(),
  store = useRepositoryStore()
const generatedId = useId()
const contentId = computed(() =>
  props.flowGroup ? `sidebar-flow-${props.flowGroup}` : generatedId,
)
const searchClosed = ref(false)
watch(
  () => [props.query, store.repo.path],
  () => {
    searchClosed.value = false
  },
)
const open = computed(() =>
  props.query.trim()
    ? !searchClosed.value
    : !sidebar.collapsedDirectories(store.repo.path, props.nodeKey),
)
function toggle() {
  if (props.query.trim()) searchClosed.value = !searchClosed.value
  else sidebar.toggleDirectoryCollapsed(store.repo.path, props.nodeKey)
}
</script>
<template>
  <div
    class="branch-tree-folder"
    :data-directory-key="nodeKey"
    :data-remote-node="nodeKey"
    :data-remote-name="remote ? label : undefined"
  >
    <button
      class="branch-folder-toggle"
      :class="{ 'gitflow-group-label': flowGroup }"
      :data-flow-group="flowGroup"
      :style="{ '--branch-depth': depth }"
      :aria-controls="contentId"
      :aria-expanded="open"
      :aria-label="`展开或折叠${remote ? '远程' : '目录'} ${label}`"
      :title="menu.hoverTitle(labelClipped ? label : undefined)"
      @mouseenter="measureLabel"
      @focus="measureLabel"
      @click="toggle"
    >
      <Icon
        name="ChevronRight"
        class="disclosure-chevron"
        :class="{ 'is-open': open }"
        :size="12"
      />
      <Icon
        :name="remote ? 'Cloud' : 'FolderOpen'"
        :size="14"
      />
      <span ref="labelElement">{{ label }}</span>
    </button>
    <SidebarCollapse
      :id="contentId"
      :open="open"
      ><div class="branch-list"><slot /></div
    ></SidebarCollapse>
  </div>
</template>
