<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRepositoryStore } from '../../repository/stores/repository'
import Icon from '../../../shared/ui/Icon.vue'

const store = useRepositoryStore()
const intent = store.captureOperation()
const name = ref(''),
  switchAfter = ref(false),
  error = ref('')
const input = ref<HTMLInputElement>()
const previous =
  typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
const stale = computed(
  () =>
    store.repo.path !== intent.repo ||
    store.activeTabId !== intent.tabId ||
    store.repo.head !== intent.expectedHead ||
    store.repo.branch !== intent.expectedBranch,
)
onMounted(async () => {
  await nextTick()
  input.value?.focus()
  input.value?.scrollIntoView({ block: 'nearest' })
})
function close() {
  if (!store.busy) store.modal = null
}
async function submit() {
  if (store.busy || stale.value || !name.value.trim()) return
  error.value = ''
  const ok = await store.run(
    'create-branch',
    { name: name.value.trim(), startOid: intent.expectedHead, switchAfter: switchAfter.value },
    intent,
  )
  if (!ok) error.value = store.lastActionResult?.error || '创建未完成，请核对结果后重试。'
}
onBeforeUnmount(() => {
  if (store.modal === 'branch' && !store.busy) store.modal = null
  void nextTick(() => {
    if (previous?.isConnected && !document.querySelector('dialog[open]'))
      previous.focus({ preventScroll: true })
  })
})
</script>

<template>
  <form
    autocomplete="off"
    class="inline-branch-form"
    aria-label="在此提交新建分支"
    @submit.prevent="submit"
    @click.stop
    @dblclick.stop
    @contextmenu.stop
    @keydown.stop
    @keydown.esc.prevent="close"
  >
    <input
      ref="input"
      v-model="name"
      aria-label="分支名称"
      placeholder="输入分支名称"
      autocomplete="off"
      spellcheck="false"
      :disabled="store.busy || stale"
      required
    />
    <button
      type="submit"
      class="icon-button"
      aria-label="创建分支"
      :disabled="store.busy || stale || !name.trim()"
    >
      <Icon
        :name="store.busy ? 'LoaderCircle' : 'Check'"
        :class="{ spin: store.busy }"
        :size="13"
      />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label="取消新建分支"
      :disabled="store.busy"
      @click="close"
    >
      <Icon
        name="X"
        :size="13"
      />
    </button>
    <div class="inline-branch-options">
      <label
        ><input
          v-model="switchAfter"
          type="checkbox"
          :disabled="store.busy"
        />创建后检出</label
      ><code>{{ intent.expectedHead.slice(0, 7) }}</code>
      <p
        v-if="stale || error"
        role="alert"
      >
        {{ stale ? '仓库或分支已变化，请取消后重新创建。' : error }}
      </p>
    </div>
  </form>
</template>
