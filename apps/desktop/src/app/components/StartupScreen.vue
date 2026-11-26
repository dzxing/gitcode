<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../../features/repository/stores/repository'
import AppBrand from '../../shared/ui/AppBrand.vue'
import { coreBridge } from '../../infrastructure/coreBridge'
const emit = defineEmits<{ configureGit: [] }>()

const store = useRepositoryStore()
const delayed = ref(false)
const configuring = ref(false)
const missingGit = computed(
  () =>
    !!store.runtime &&
    !store.runtime.gitAvailable &&
    !/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(store.activeRepositoryTab?.path || ''),
)
let timer: ReturnType<typeof setTimeout> | undefined
const waiting = computed(() => store.starting || (store.unloadedRepository && store.busy))
const failed = computed(
  () => store.startupPhase === 'error' || (store.unloadedRepository && !store.busy),
)
watch(
  waiting,
  (value) => {
    clearTimeout(timer)
    delayed.value = false
    if (value)
      timer = setTimeout(() => {
        delayed.value = true
      }, 200)
  },
  { immediate: true },
)
onUnmounted(() => clearTimeout(timer))
const title = computed(() =>
  failed.value
    ? missingGit.value
      ? '需要安装或配置 Git'
      : '仓库工作台尚未就绪'
    : store.startupPhase === 'core'
      ? '正在连接本地 Git 服务…'
      : '正在恢复仓库工作区…',
)
const description = computed(
  () =>
    store.startupError ||
    store.repositoryOpenError ||
    (store.activeRepositoryTab ? store.activeRepositoryTab.name : '准备本机工作台'),
)
function retry() {
  if (store.startupPhase === 'error') void store.retryStartup()
  else if (store.activeRepositoryTab?.path) void store.open(store.activeRepositoryTab.path)
}
function skip() {
  if (store.startupPhase === 'error') store.skipStartup()
  else store.newTab()
}
async function install() {
  try {
    await coreBridge.openResource('git-install')
  } catch (error) {
    store.notify((error as Error).message, true)
  }
}
async function chooseGit() {
  if (!window.gitcode?.chooseGit || !window.gitcode.gitSettings) {
    emit('configureGit')
    return
  }
  configuring.value = true
  try {
    const path = await window.gitcode.chooseGit()
    if (!path) return
    store.runtime = (await window.gitcode.gitSettings({ mode: 'custom', path })).runtime
    await store.retryStartup()
  } catch (error) {
    store.notify((error as Error).message, true)
  } finally {
    configuring.value = false
  }
}
</script>

<template>
  <section
    v-if="delayed || failed"
    class="startup-screen"
    :class="{ 'has-error': failed }"
    :aria-busy="waiting"
    aria-label="应用启动状态"
    role="region"
  >
    <div class="startup-card">
      <div class="startup-brand">
        <AppBrand :size="48" />
      </div>
      <h1>{{ title }}</h1>
      <p :role="failed ? 'alert' : 'status'">{{ description }}</p>
      <progress
        v-if="waiting"
        aria-label="正在准备工作区"
      />
      <div
        v-if="failed"
        class="startup-actions"
      >
        <button
          v-if="missingGit"
          class="primary-button"
          :disabled="configuring"
          @click="install"
        >
          安装 Git
        </button>
        <button
          v-if="missingGit"
          class="secondary-button"
          :disabled="configuring"
          @click="chooseGit"
        >
          选择已有 Git
        </button>
        <button
          :class="missingGit ? 'secondary-button' : 'primary-button'"
          :disabled="configuring"
          @click="retry"
        >
          {{ missingGit ? '重新检测 Git' : '重试' }}</button
        ><button
          class="secondary-button"
          :disabled="configuring"
          @click="skip"
        >
          进入新标签页
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.startup-screen {
  position: fixed;
  inset: 38px 0 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg, #1e2025);
}
.startup-card {
  width: min(360px, 100%);
  text-align: center;
  animation: startup-enter 160ms ease-out;
}
.startup-brand {
  --brand-type-size: calc(28px + var(--ui-font-delta, 0px));
  --brand-mark-gap: 12px;
  display: flex;
  justify-content: center;
  margin-bottom: 28px;
}

h1 {
  font-size: calc(15px + var(--ui-font-delta, 0px));
  font-weight: 500;
  margin: 0 0 12px;
  color: var(--text, #e4e7eb);
}
p {
  font-size: var(--ui-font-size);
  line-height: 1.7;
  color: var(--muted, #b9c2cf);
  overflow-wrap: anywhere;
  margin: 0 0 22px;
}
progress {
  width: 140px;
  height: 4px;
  accent-color: var(--accent, #25b6c9);
}
.startup-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
@keyframes startup-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .startup-card {
    animation: none;
  }
  progress {
    display: none;
  }
}
</style>
