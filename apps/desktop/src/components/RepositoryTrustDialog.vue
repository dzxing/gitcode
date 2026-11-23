<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
const store = useRepositoryStore()
const dialog = ref<HTMLDialogElement>()
let previousFocus: HTMLElement | null = null
watch(
  () => !!store.trustRequest,
  async (open) => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement
      await nextTick()
      dialog.value?.showModal()
      dialog.value?.querySelector<HTMLButtonElement>('.trust-cancel')?.focus()
    } else {
      dialog.value?.close()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  },
)
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog dialog-confirmation desktop-dialog repository-trust-dialog"
    aria-labelledby="repository-trust-title"
    @cancel.prevent="store.cancelTrust()"
  >
    <div
      v-if="store.trustRequest"
      class="dialog-content"
    >
      <h2 id="repository-trust-title">信任此仓库？</h2>
      <p>读取状态和差异也可能执行仓库配置的过滤器。请仅打开你信任来源的工作副本。</p>
      <dl>
        <dt>仓库目录</dt>
        <dd>{{ store.trustRequest.path }}</dd>
        <dt>Git 目录</dt>
        <dd>{{ store.trustRequest.gitDir }}</dd>
      </dl>
      <p>
        信任后将启用完整 Git 功能，包括
        LFS、过滤器、操作钩子和已初始化的子模块。此选择会保存在本机，重启后仍然有效。
        仓库被替换或执行相关配置变化时，需要重新确认。
      </p>
      <p class="trust-preview-note">当前仅显示目录信息，尚未读取工作区状态或获取远端更新。</p>
      <p
        v-if="store.trustError"
        role="alert"
        class="trust-error"
      >
        {{ store.trustError }}
      </p>
      <div class="dialog-actions">
        <button
          class="secondary-button trust-cancel"
          :disabled="store.trustApproving"
          @click="store.cancelTrust()"
        >
          取消
        </button>
        <button
          class="primary-button"
          :disabled="store.trustApproving"
          @click="store.approveTrust()"
        >
          {{ store.trustApproving ? '正在确认…' : '信任并打开' }}
        </button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.repository-trust-dialog {
  width: min(520px, calc(100vw - 32px));
}
dl {
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 5px;
}
dt {
  color: var(--muted);
  font-size: var(--dialog-font-help);
}
dd {
  margin: 3px 0 10px;
  overflow-wrap: anywhere;
  user-select: text;
}
dd:last-child {
  margin-bottom: 0;
}
.trust-preview-note {
  color: var(--muted);
}
.trust-error {
  color: var(--danger, #ed8585);
}
</style>
