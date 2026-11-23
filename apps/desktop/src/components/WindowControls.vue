<script setup lang="ts">
import Icon from './Icon.vue'
defineProps<{ maximized: boolean }>()
defineEmits<{ action: [kind: 'minimize' | 'maximize' | 'close'] }>()
</script>

<template>
  <div
    class="window-controls"
    role="group"
    aria-label="窗口控制"
  >
    <button
      class="window-control"
      title="最小化"
      aria-label="最小化窗口"
      @click="$emit('action', 'minimize')"
    >
      <Icon
        name="Minus"
        :size="14"
      />
    </button>
    <button
      class="window-control"
      :title="maximized ? '还原' : '最大化'"
      :aria-label="maximized ? '还原窗口' : '最大化窗口'"
      @click="$emit('action', 'maximize')"
    >
      <Icon
        :name="maximized ? 'WindowRestore' : 'WindowMaximize'"
        :size="12"
      />
    </button>
    <button
      class="window-control window-close"
      title="关闭"
      aria-label="关闭窗口"
      @click="$emit('action', 'close')"
    >
      <Icon
        name="X"
        :size="17"
      />
    </button>
  </div>
</template>
