<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { GitRuntimeSettings, GitRuntimeSelection } from '../../../shared/contracts'
import { useRepositoryStore } from '../../repository/stores/repository'
import { noticePresentation } from '../../../shared/lib/noticePresentation'
import { coreBridge, isDesktop, canConnectLocalCore } from '../../../infrastructure/coreBridge'

const store = useRepositoryStore()
const root = ref<HTMLElement>()
const info = ref<GitRuntimeSettings | null>(null)
const mode = ref<GitRuntimeSelection['mode']>('auto')
const customPath = ref('')
const pending = ref(false)
const error = ref('')
const saved = ref(false)
watch([mode, customPath], () => {
  error.value = ''
  saved.value = false
})
const selection = computed<GitRuntimeSelection>(() => ({
  mode: mode.value,
  ...(mode.value === 'custom' ? { path: customPath.value.trim() } : {}),
}))
const dirty = computed(() => {
  if (!info.value) return false
  const baseline = info.value.selection
  return (
    mode.value !== baseline.mode ||
    (mode.value === 'custom' && customPath.value.trim() !== (baseline.path || '').trim())
  )
})
const canRefresh = computed(
  () =>
    typeof window.gitcode?.refreshGitRuntime === 'function' ||
    (!isDesktop() && canConnectLocalCore()),
)
const canBrowse = computed(() => typeof window.gitcode?.chooseGit === 'function')
const platform = computed(() => info.value?.runtime.platform || store.runtime?.platform || '')
function presentFailure(message: string) {
  const result = noticePresentation(message, true)
  return !result.details && result.text.includes('\n')
    ? { text: result.text.split('\n')[0], details: message }
    : result
}
const failure = computed(() => presentFailure(error.value))
const runtimeError = computed(() =>
  info.value?.runtime.gitError ? presentFailure(info.value.runtime.gitError) : null,
)
const source = computed(
  () =>
    ({
      system: '系统 Git',
      custom: '自定义 Git',
      environment: '环境变量指定',
    })[info.value?.runtime.gitSource || ''] || '未检测到可用 Git',
)
onMounted(async () => {
  pending.value = true
  try {
    info.value = await coreBridge.gitSettings()
    mode.value = info.value.selection.mode
    customPath.value = info.value.selection.path || ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法读取 Git 运行环境。'
  } finally {
    pending.value = false
  }
})
async function browse() {
  pending.value = true
  try {
    const selected = await window.gitcode!.chooseGit!()
    if (selected) customPath.value = selected
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法选择 Git。'
  } finally {
    pending.value = false
  }
}
async function install() {
  try {
    await coreBridge.openResource('git-install')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开 Git 安装页面。'
  }
}
async function chooseExisting() {
  mode.value = 'custom'
  if (canBrowse.value) await browse()
  else {
    await nextTick()
    root.value?.querySelector<HTMLInputElement>('.git-runtime-path input')?.focus()
  }
}
async function refresh() {
  if (pending.value || store.busy || !canRefresh.value) return
  pending.value = true
  error.value = ''
  try {
    info.value = await coreBridge.refreshGitRuntime()
    store.runtime = info.value.runtime
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法重新检测 Git。'
  } finally {
    pending.value = false
  }
}
function validate() {
  if (pending.value || store.busy || !info.value) return false
  if (mode.value === 'custom' && !customPath.value.trim()) {
    error.value = '请选择 Git 可执行文件。'
    void nextTick(() =>
      root.value?.querySelector<HTMLInputElement>('.git-runtime-path input')?.focus(),
    )
    return false
  }
  return true
}
async function save() {
  if (!dirty.value) return true
  if (!validate()) return false
  pending.value = true
  error.value = ''
  saved.value = false
  try {
    info.value = await coreBridge.gitSettings(selection.value)
    store.runtime = info.value.runtime
    saved.value = true
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败。'
    return false
  } finally {
    pending.value = false
  }
}
defineExpose({ dirty, pending, validate, apply: save })
</script>

<template>
  <section
    ref="root"
    class="git-runtime-settings"
    role="region"
    aria-labelledby="git-runtime-title"
  >
    <div class="git-runtime-content">
      <h2 id="git-runtime-title">Git 运行环境</h2>
      <p
        v-if="info?.runtime.platform === 'windows'"
        class="form-hint"
      >
        此设置用于 Windows 仓库；WSL 仓库使用对应发行版中的 Git。
      </p>
      <dl
        v-if="info"
        class="git-runtime-details"
      >
        <dt>当前来源</dt>
        <dd>{{ source }}</dd>
        <dt>当前版本</dt>
        <dd>{{ info.runtime.gitVersion || '无可用版本' }}</dd>
        <dt>执行路径</dt>
        <dd>{{ info.runtime.gitPath || '—' }}</dd>
      </dl>
      <div
        v-if="info && !info.runtime.gitAvailable"
        class="git-runtime-actions"
      >
        <button
          type="button"
          class="secondary-button"
          :disabled="pending"
          @click="install"
        >
          安装 Git
        </button>
        <button
          type="button"
          class="secondary-button"
          :disabled="pending || store.busy || info.runtime.gitSource === 'environment'"
          @click="chooseExisting"
        >
          选择已有 Git
        </button>
        <button
          v-if="canRefresh"
          type="button"
          class="secondary-button"
          :disabled="pending || store.busy"
          @click="refresh"
        >
          重新检测 Git
        </button>
      </div>
      <p
        v-if="info?.runtime.gitSource === 'environment'"
        class="form-hint"
      >
        当前由 GITCODE_GIT_PATH 或 GITK_GIT_PATH 指定。环境变量优先于此设置。
      </p>
      <fieldset
        :disabled="pending || store.busy || !info || info.runtime.gitSource === 'environment'"
      >
        <legend>使用的 Git</legend>
        <label class="git-runtime-choice"
          ><input
            v-model="mode"
            type="radio"
            value="auto"
            @change="saved = false"
          />自动查找 Git</label
        >
        <p class="form-hint">
          {{
            platform === 'macos'
              ? '自动检查 Homebrew、MacPorts、Apple Command Line Tools、Xcode 和系统 Git。'
              : platform === 'windows'
                ? '检查 PATH 和常见安装位置。'
                : '查找当前系统可用的 Git。'
          }}
        </p>
        <label class="git-runtime-choice"
          ><input
            v-model="mode"
            type="radio"
            value="custom"
            @change="saved = false"
          />自定义 Git</label
        >
        <div
          v-if="mode === 'custom'"
          class="git-runtime-path"
        >
          <input
            class="settings-input"
            autocomplete="off"
            v-model="customPath"
            aria-label="Git 可执行文件路径"
            placeholder="Git 可执行文件的绝对路径"
            @input="saved = false"
          />
          <button
            v-if="canBrowse"
            type="button"
            class="secondary-button"
            @click="browse"
          >
            浏览…
          </button>
        </div>
      </fieldset>
      <p
        v-if="error"
        class="form-error"
        role="alert"
      >
        {{ failure.text }}
      </p>
      <p
        v-else-if="runtimeError"
        class="form-error"
        role="alert"
      >
        {{ runtimeError.text }}
      </p>
      <details
        v-if="failure.details || runtimeError?.details"
        class="runtime-error-details"
      >
        <summary>查看检测详情</summary>
        <pre>{{ failure.details || runtimeError?.details }}</pre>
      </details>
      <p
        v-if="platform === 'macos' && (error || runtimeError)"
        class="form-hint"
      >
        终端可运行 Git 时，可用 <code>command -v git</code> 或
        <code>xcrun --find git</code> 查找路径，再选择“自定义 Git”。
      </p>
      <p
        v-if="saved"
        role="status"
      >
        已应用并保存。
      </p>
    </div>
  </section>
</template>

<style scoped>
.git-runtime-settings h2 {
  margin: 0 0 16px;
}
.git-runtime-content {
  max-width: 600px;
}
.git-runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.git-runtime-details {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 8px 12px;
}
.git-runtime-details dt {
  color: var(--muted);
}
.git-runtime-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 16px 0;
}
legend {
  margin-bottom: 8px;
}
.git-runtime-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  margin: 4px 0;
}
.git-runtime-choice input {
  width: auto;
  margin: 0;
}
.git-runtime-path {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px 21px;
}
.git-runtime-path input {
  flex: 1;
  min-width: 0;
}
.form-error {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.form-hint {
  font-size: var(--dialog-font-help);
  color: var(--muted);
  line-height: 1.5;
  margin: 4px 0 12px;
}
.runtime-error-details {
  margin: 12px 0;
}
.runtime-error-details summary {
  padding: 4px 0;
}
.runtime-error-details pre {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--ui-font-help)/1.7 var(--mono);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 12px;
}
</style>
