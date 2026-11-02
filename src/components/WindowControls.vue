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
      <svg
        v-if="maximized"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M4 3V1.5H10.5V8H9M1.5 4H8V10.5H1.5Z"
          stroke="currentColor"
        /></svg
      ><svg
        v-else
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="1.5"
          y="1.5"
          width="9"
          height="9"
          stroke="currentColor"
        />
      </svg>
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
