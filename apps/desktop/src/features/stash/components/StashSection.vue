<script setup lang="ts">
import { vOverflowTitle } from '../../../shared/ui/overflowTitle'
import { ref } from 'vue'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useStashStore } from '../stores/stash'
import { useContextMenuStore } from '../../../app/stores/contextMenu'
import SidebarCollapse from '../../branches/components/SidebarCollapse.vue'
import Icon from '../../../shared/ui/Icon.vue'
const store = useRepositoryStore(),
  stash = useStashStore(),
  menu = useContextMenuStore(),
  expanded = ref(true)
</script>
<template>
  <section
    class="branch-section stash-section"
    aria-label="贮藏分组"
  >
    <div class="section-head">
      <button
        class="section-toggle"
        :aria-expanded="expanded"
        aria-controls="sidebar-stashes"
        @click="expanded = !expanded"
      >
        <Icon
          name="ChevronRight"
          class="disclosure-chevron"
          :class="{ 'is-open': expanded }"
          :size="12"
        /><Icon
          name="Archive"
          :size="14"
        /><span class="section-title">贮藏</span>
      </button>
    </div>
    <SidebarCollapse
      id="sidebar-stashes"
      :open="expanded"
      ><div class="stash-sidebar-list">
        <button
          v-for="entry in stash.entries"
          :key="entry.ref + entry.oid"
          class="stash-sidebar-entry"
          :aria-pressed="
            store.selectedStash?.oid === entry.oid && store.selectedStash?.ref === entry.ref
          "
          :class="{
            selected:
              store.selectedStash?.oid === entry.oid && store.selectedStash?.ref === entry.ref,
          }"
          :disabled="store.busy"
          v-overflow-title="{ text: menu.hoverTitle(entry.message), target: 'span' }"
          @click="stash.openList(entry)"
          @contextmenu="menu.open($event, { kind: 'stash', stash: entry })"
          @keydown="menu.keyboard($event, { kind: 'stash', stash: entry })"
        >
          <Icon
            name="Archive"
            :size="13"
          /><span>{{ entry.message.replace(/^(?:On|WIP on) [^:]+:\s*/, '') }}</span>
        </button>
        <p
          v-if="!stash.entries.length"
          class="section-empty"
        >
          暂无贮藏记录
        </p>
      </div></SidebarCollapse
    >
  </section>
</template>
<style scoped>
.stash-sidebar-entry {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  width: calc(100% - 16px);
  min-height: 28px;
  margin: 0 8px;
  padding: 4px 6px 4px 24px;
  text-align: left;
  font-size: var(--ui-font-help);
  border-radius: 3px;
}
.stash-sidebar-entry.selected {
  background: var(--view-selection-bg);
}
.stash-sidebar-entry:hover {
  background: var(--control-hover-bg);
}
.stash-sidebar-entry > svg {
  flex-shrink: 0;
  color: var(--icon-color);
}
.stash-sidebar-entry > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.stash-sidebar-entry > small {
  max-width: 35%;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  font-size: var(--ui-font-help);
  color: var(--muted);
}
</style>
