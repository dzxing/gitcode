<script setup lang="ts">
import { computed } from 'vue'
import type { Branch } from '../../../shared/contracts'
import { branchDirectoryTree, type SidebarSection } from '../sidebar'
import { branchReference } from '../../../shared/lib/references'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useSidebarStore } from '../stores/sidebar'
import SidebarBranchRow from './SidebarBranchRow.vue'
import BranchTreeNode from './BranchTreeNode.vue'
const props = withDefaults(
  defineProps<{
    branches: Branch[]
    section: SidebarSection
    query: string
    scope?: string[]
    labelPrefix?: string
    depth?: number
  }>(),
  { labelPrefix: '', depth: 1 },
)
const store = useRepositoryStore(),
  sidebar = useSidebarStore()
const tree = computed(() =>
  branchDirectoryTree(
    props.branches,
    props.scope || [props.section],
    props.branches
      .filter((branch) => sidebar.isFavorite(store.repo.path, branch))
      .map(branchReference),
    sidebar.sortMode(store.repo.path, props.section),
    props.query,
    (branch) => branch.name.slice(props.labelPrefix.length),
  ),
)
</script>
<template>
  <div class="branch-list">
    <SidebarBranchRow
      v-for="item in tree.favorites"
      :key="branchReference(item.branch)"
      :branch="item.branch"
      :label="item.label"
      :depth="depth"
      :section="section"
    />
    <BranchTreeNode
      v-for="node in tree.children"
      :key="node.key"
      :node="node"
      :depth="depth"
      :query="query"
      :section="section"
    />
  </div>
</template>
