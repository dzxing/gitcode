<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useStashStore } from '../stores/stash'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
const stash = useStashStore(),
  store = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>()
let previousFocus: HTMLElement | null = null
watch(
  () => store.modal === 'stash-delete',
  async (open) => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement
      await nextTick()
      dialog.value?.showModal()
      dialog.value?.querySelector<HTMLButtonElement>('.delete-cancel')?.focus()
    } else {
      dialog.value?.close()
      await nextTick()
      const origin =
        previousFocus?.isConnected && !previousFocus.matches(':disabled')
          ? previousFocus
          : document.querySelector<HTMLElement>('.wip-row')
      origin?.focus({ preventScroll: true })
    }
  },
)
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog stash-delete-dialog"
    aria-labelledby="stash-delete-title"
    @cancel.prevent="stash.closeDelete"
    @click="$event.target === dialog && stash.closeDelete()"
  >
    <div
      v-if="stash.deleteTarget"
      class="dialog-content"
    >
      <button
        class="icon-button dialog-close"
        :disabled="store.busy"
        aria-label="关闭删除确认"
        @click="stash.closeDelete"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <h2 id="stash-delete-title">删除这条贮藏？</h2>
      <p class="stash-delete-name">{{ stash.deleteTarget.entry.message }}</p>
      <p>此操作移除贮藏记录，不修改当前工作文件。应用内无法撤销。</p>
      <p
        v-if="stash.error"
        class="stash-delete-error"
        role="alert"
      >
        {{ stash.error }}
      </p>
      <button
        v-if="store.busy"
        class="text-button delete-abort"
        :disabled="store.cancelling"
        @click="store.cancelOperation()"
      >
        {{ store.cancelling ? '正在取消并核对…' : '取消当前操作（不等于回滚）' }}
      </button>
      <div class="dialog-actions">
        <button
          class="secondary-button delete-cancel"
          :disabled="store.busy"
          @click="stash.closeDelete"
        >
          取消</button
        ><button
          class="secondary-button delete-confirm"
          :disabled="store.busy"
          @click="stash.confirmDelete"
        >
          {{ store.busy ? '正在删除…' : '删除贮藏' }}
        </button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.stash-delete-dialog {
  width: 420px;
}
.delete-abort {
  font-size: 11px;
  margin-bottom: 12px;
}
.stash-delete-dialog .stash-delete-name {
  color: var(--bright);
  overflow-wrap: anywhere;
  font-size: 12px;
}
.stash-delete-dialog .stash-delete-error,
.delete-confirm {
  color: var(--git-deleted);
}
</style>
