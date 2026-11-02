<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'

const repo = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>(),
  attempted = ref(false),
  error = ref('')
const plan = computed(() => repo.checkoutProtection)
let previous: HTMLElement | null = null
watch(
  () => repo.modal === 'checkout-protected',
  async (open) => {
    if (open) {
      previous = document.activeElement as HTMLElement
      attempted.value = false
      error.value = ''
      await nextTick()
      dialog.value?.showModal()
      dialog.value?.querySelector<HTMLButtonElement>('.checkout-cancel')?.focus()
    } else {
      dialog.value?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  },
)
function close() {
  if (!repo.busy) {
    repo.modal = null
    repo.checkoutProtection = null
  }
}
async function execute() {
  const target = plan.value
  if (!target || repo.busy || attempted.value) return
  attempted.value = true
  const ok = await repo.run('stash-checkout', { planId: target.id }, target.intent)
  if (!ok && repo.modal === 'checkout-protected')
    error.value =
      [repo.lastActionResult?.error, repo.lastActionResult?.warning].filter(Boolean).join(' ') ||
      '操作未完成，请关闭后刷新仓库，核对工作区和贮藏列表。'
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog protected-checkout-dialog"
    aria-labelledby="protected-checkout-title"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
  >
    <div
      v-if="plan"
      class="dialog-content"
    >
      <button
        class="icon-button dialog-close"
        aria-label="关闭受保护的分支切换"
        :disabled="repo.busy"
        @click="close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <h2 id="protected-checkout-title">本地修改阻止切换</h2>
      <p>
        尚未切换到 <strong>{{ plan.branch }}</strong
        >，本地修改保持不变。
      </p>
      <p>
        可以贮藏全部已暂存、未暂存和未跟踪文件，再切换分支。贮藏会保留在导航区和关系图中，由你决定何时恢复。
      </p>
      <details open>
        <summary>将贮藏的文件（{{ plan.paths.length }}）</summary>
        <ul>
          <li
            v-for="path in plan.paths"
            :key="path"
          >
            {{ path }}
          </li>
        </ul>
      </details>
      <p class="form-help">不包含被忽略的文件。切换失败时保留贮藏，不自动恢复。</p>
      <p
        v-if="error"
        class="checkout-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="dialog-actions">
        <button
          class="secondary-button checkout-cancel"
          :disabled="repo.busy"
          @click="close"
        >
          {{ attempted ? '关闭' : '取消' }}</button
        ><button
          class="primary-button"
          :disabled="repo.busy || attempted"
          @click="execute"
        >
          {{ repo.busy ? '正在贮藏并切换…' : '贮藏并切换' }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.protected-checkout-dialog {
  width: 540px;
  max-height: calc(100dvh - 48px);
}
.dialog-content {
  max-height: calc(100dvh - 52px);
  overflow: auto;
}
.protected-checkout-dialog details {
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px;
  margin: 14px 0;
}
.protected-checkout-dialog ul {
  list-style: none;
  max-height: 160px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 0;
  font: 11px/1.8 var(--mono);
}
.protected-checkout-dialog li {
  overflow-wrap: anywhere;
}
.checkout-error {
  color: var(--git-deleted);
}
</style>
