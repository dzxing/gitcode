<script setup lang="ts">
import { computed } from 'vue'
import type { CommitReference, ReferenceGroup } from '../referenceLabels'
import Icon from './Icon.vue'
const props = defineProps<{
  group: ReferenceGroup
  title: string
  actionLabel: string
  busy?: boolean
  presentation?: boolean
}>()
const emit = defineEmits<{
  expand: [event: MouseEvent]
  activate: [reference: CommitReference, event: MouseEvent]
  inspect: [reference: CommitReference, event: MouseEvent]
  menu: [event: MouseEvent | KeyboardEvent, reference: CommitReference]
  keyboard: [event: KeyboardEvent, reference: CommitReference]
}>()
const remote = computed(() =>
  props.group.members.find((ref) => ref.kind === 'remote' && ref.key !== props.group.primary.key),
)
const icon = computed(() =>
  props.group.primary.kind === 'local'
    ? 'Laptop'
    : props.group.primary.kind === 'remote'
      ? 'Cloud'
      : props.group.primary.kind === 'tag'
        ? 'Tag'
        : 'GitBranch',
)
</script>

<template>
  <div
    class="reference-badge"
    :class="{
      'ref-tag': !presentation,
      'ref-badge-sizing': presentation,
      'current-ref': group.current,
    }"
    :data-reference-key="presentation ? undefined : group.key"
    :title="title"
    @contextmenu.prevent="!presentation && emit('menu', $event, group.primary)"
  >
    <component
      :is="presentation ? 'span' : 'button'"
      class="ref-primary"
      @mouseenter="!presentation && emit('expand', $event)"
      :aria-label="presentation ? undefined : actionLabel"
      :aria-disabled="!presentation && busy && group.primary.kind === 'local' ? true : undefined"
      :aria-describedby="
        !presentation && busy && group.primary.kind === 'local' ? 'operation-status' : undefined
      "
      @click="!presentation && emit('activate', group.primary, $event)"
      @contextmenu.stop.prevent="!presentation && emit('menu', $event, group.primary)"
      @keydown="!presentation && emit('keyboard', $event, group.primary)"
    >
      <Icon
        v-if="group.current"
        name="Check"
        :size="12"
        class="ref-current-mark"
      />
      <span class="ref-label-name">{{ group.primary.label }}</span>
      <Icon
        :name="icon"
        :size="12"
        class="ref-kind-icon"
        :data-reference-kind="group.primary.kind"
      />
    </component>
    <component
      :is="presentation ? 'span' : 'button'"
      v-if="remote"
      class="ref-inspect"
      :title="`查看远程引用 ${remote.key}`"
      :aria-label="presentation ? undefined : `查看远程引用 ${remote.key}`"
      @click.stop="!presentation && emit('inspect', remote, $event)"
      @contextmenu.stop.prevent="!presentation && emit('menu', $event, remote)"
      @keydown="!presentation && emit('keyboard', $event, remote)"
    >
      <Icon
        name="Cloud"
        :size="12"
        class="ref-kind-icon"
        data-reference-kind="remote"
      />
    </component>
  </div>
</template>
