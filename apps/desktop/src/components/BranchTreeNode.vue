<script setup lang="ts">
import type { BranchTreeNode as DirectoryNode } from '../sidebar'
import SidebarBranchRow from './SidebarBranchRow.vue'
import BranchTreeFolder from './BranchTreeFolder.vue'
defineProps<{ node: DirectoryNode; depth: number; query: string; section: string }>()
</script>
<template>
  <SidebarBranchRow
    v-if="node.branch"
    :branch="node.branch"
    :label="node.label"
    :depth="depth"
    :section="section"
  />
  <BranchTreeFolder
    v-else
    :node-key="node.key"
    :label="node.label"
    :depth="depth"
    :query="query"
  >
    <BranchTreeNode
      v-for="child in node.children"
      :key="child.key"
      :node="child"
      :depth="depth + 1"
      :query="query"
      :section="section"
    />
  </BranchTreeFolder>
</template>
