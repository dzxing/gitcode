<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { desktop } from '../services/desktop'
import type { GitActivity } from '../types'
import Icon from './Icon.vue'

const store = useRepositoryStore()
const activity = ref<GitActivity | null>(null)
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})
const operation = computed(() =>
  store.busy ? store.activeOperation : store.fetching ? 'fetch' : '',
)
const origin = computed(() => (store.busy ? store.operationOrigin : store.fetchOrigin))
const cancelling = computed(() => store.cancelling || store.fetchCancelling)
const label = computed(() => (store.busy ? store.operationLabel : '获取远程分支'))
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
watch(
  () => [mounted.value, store.isWorking, operation.value, origin.value] as const,
  () => {
    const current = ++version
    clearTimeout(timer)
    activity.value = null
    if (
      !mounted.value ||
      !store.isWorking ||
      !['clone', 'fetch', 'pull', 'push', 'pull-and-push', 'prepare-sync'].includes(operation.value)
    )
      return
    const activeOperation = operation.value
    const activeOrigin = origin.value
    const poll = async () => {
      try {
        const next = await desktop.activity()
        if (current !== version) return
        if (
          next?.operation === activeOperation &&
          next.repo === activeOrigin &&
          next.state === 'running'
        )
          activity.value = next
        else activity.value = null
      } catch {
        // Older cores retain indeterminate feedback; never retry a Git mutation.
      }
      if (current === version) timer = setTimeout(() => void poll(), 350)
    }
    void poll()
  },
  { immediate: true },
)
onUnmounted(() => {
  version++
  clearTimeout(timer)
})
</script>

<template>
  <aside
    class="operation-feedback"
    role="status"
    aria-live="polite"
    aria-label="Git 操作进度"
  >
    <div class="operation-feedback-heading">
      <Icon
        name="LoaderCircle"
        :size="16"
        class="spin operation-feedback-icon"
      />
      <strong>{{ cancelling ? '正在取消并核对结果…' : `正在${label}…` }}</strong>
    </div>
    <progress
      v-if="activity?.percent != null"
      :value="activity.percent"
      max="100"
      :aria-label="activity.phase"
    />
    <progress
      v-else
      aria-label="正在执行，尚无可用百分比"
    />
    <div class="operation-feedback-footer">
      <span
        class="operation-feedback-phase"
        aria-live="off"
        >{{ activity?.phase || '正在等待 Git 返回结果'
        }}<template v-if="activity?.percent != null"> · {{ activity.percent }}%</template></span
      >
      <button
        class="secondary-button operation-feedback-cancel"
        :disabled="cancelling"
        @click="store.cancelOperation()"
      >
        {{ cancelling ? '正在取消…' : '取消操作' }}
      </button>
    </div>
  </aside>
</template>
