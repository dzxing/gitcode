<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { desktop, isDesktop, joinPath } from '../services/desktop'
import { getUIPlatform } from '../services/platform'
import {
  parentDirectory,
  suggestedRepositoryName,
  validRepositoryFolderName,
} from '../repositoryDestination'
import DirectoryBrowser from './DirectoryBrowser.vue'
import Icon from './Icon.vue'

const store = useRepositoryStore()
const dialog = ref<HTMLDialogElement>()
const directoryMode = ref<'repo' | 'parent' | null>(null)
const pickerError = ref('')
const picking = ref(false)
const localError = ref('')
const advanced = ref(false)
const drafts = reactive({
  clone: { url: '', parent: '', name: '', nameEdited: false },
  create: { url: '', parent: '', name: '', nameEdited: false },
})
const mode = computed(() =>
  ['open', 'clone', 'create'].includes(store.modal || '')
    ? (store.modal as 'open' | 'clone' | 'create')
    : null,
)
const draft = computed(() => drafts[mode.value === 'create' ? 'create' : 'clone'])
const title = computed(() =>
  mode.value === 'open' ? '打开本地仓库' : mode.value === 'clone' ? '克隆仓库' : '创建本地仓库',
)
const localReady = computed(() => isDesktop() || store.connected)
const destination = computed(() =>
  draft.value.parent.trim() && draft.value.name.trim()
    ? joinPath(draft.value.parent.trim(), draft.value.name.trim())
    : '',
)
const cancelFirst = getUIPlatform() === 'macos'
const busy = computed(() => store.busy || picking.value)
let returnFocus: HTMLElement | null = null

watch(
  () => drafts.clone.url,
  (value) => {
    if (!drafts.clone.nameEdited) drafts.clone.name = suggestedRepositoryName(value)
  },
)
function clearError() {
  localError.value = ''
  pickerError.value = ''
  store.repositoryOpenError = ''
  store.repositoryCreateError = ''
  store.repositoryCreateDetails = ''
  store.repositoryCreateCancelled = false
}
async function focusInput() {
  await nextTick()
  if (mode.value && !busy.value)
    dialog.value
      ?.querySelector<HTMLInputElement>('input:not(:disabled)')
      ?.focus({ preventScroll: true })
}
watch(
  mode,
  async (value, previous) => {
    if (value) {
      if (!previous && !store.busy && typeof document !== 'undefined') {
        const active = document.activeElement
        returnFocus =
          typeof HTMLElement !== 'undefined' &&
          active instanceof HTMLElement &&
          active !== document.body
            ? active
            : document.querySelector<HTMLElement>('[data-top-menu="file"]')
      }
      pickerError.value = ''
      localError.value = ''
      advanced.value = false
      if (value !== 'open' && !draft.value.parent && !store.isNewTab)
        draft.value.parent = parentDirectory(store.repo.path)
      await nextTick()
      if (!dialog.value?.open) dialog.value?.showModal()
      await focusInput()
      if (
        value === 'open' &&
        store.runtime?.platform === 'windows' &&
        /^\\\\(?:wsl\.localhost|wsl\$)\\?$/i.test(store.repositoryOpenPath)
      )
        directoryMode.value = 'repo'
    } else {
      dialog.value?.close()
      directoryMode.value = null
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  },
  { immediate: true },
)
watch(busy, (value) => {
  if (!value && typeof document !== 'undefined' && document.activeElement === dialog.value)
    void focusInput()
})
function close() {
  if (store.busy) {
    void store.cancelOperation()
    return
  }
  if (!picking.value) store.modal = null
}
function setName(event: Event) {
  clearError()
  draft.value.name = (event.target as HTMLInputElement).value
  draft.value.nameEdited = !!draft.value.name.trim()
}
function browseWsl() {
  store.repositoryOpenPath = '\\\\wsl.localhost\\'
  void browse('repo', true)
}
function choosePath(path: string) {
  clearError()
  if (directoryMode.value === 'repo') store.repositoryOpenPath = path
  else draft.value.parent = path
  directoryMode.value = null
}
async function browse(purpose: 'repo' | 'parent', internal = false) {
  if (busy.value) return
  clearError()
  if (!isDesktop() || internal) {
    directoryMode.value = purpose
    return
  }
  picking.value = true
  pickerError.value = ''
  try {
    const path = await desktop.chooseDirectory(
      purpose === 'repo'
        ? store.repositoryOpenPath || (!store.isNewTab ? store.repo.path : undefined)
        : draft.value.parent || undefined,
      purpose === 'repo' ? 'repository' : 'parent',
    )
    if (path) {
      if (purpose === 'repo') store.repositoryOpenPath = path
      else draft.value.parent = path
    }
  } catch (error) {
    pickerError.value = (error as Error).message
    advanced.value = true
  } finally {
    picking.value = false
  }
}
async function submit() {
  if (busy.value || !localReady.value) return
  clearError()
  if (mode.value === 'open') {
    await store.open(store.repositoryOpenPath.trim())
  } else {
    if (!validRepositoryFolderName(draft.value.name)) {
      localError.value = '仓库名称不能包含路径分隔符，也不能是 . 或 ..。'
      dialog.value?.querySelector<HTMLInputElement>('#repository-name')?.focus()
      return
    }
    if (!destination.value) return
    await store.createRepository(
      mode.value === 'clone' ? 'clone' : 'init',
      destination.value,
      draft.value.url.trim(),
    )
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog desktop-dialog repository-entry-dialog"
    aria-labelledby="repository-entry-title"
    :aria-busy="busy"
    @cancel.prevent="close"
  >
    <form
      class="repository-entry-form"
      autocomplete="off"
      @submit.prevent="submit"
    >
      <header class="repository-entry-header">
        <h2 id="repository-entry-title">{{ title }}</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭仓库窗口"
          :disabled="busy"
          @click="close"
        >
          <Icon
            name="X"
            :size="16"
          />
        </button>
      </header>
      <div class="repository-entry-body">
        <div
          v-if="!localReady"
          class="repository-connection"
          role="status"
        >
          <span>{{ store.connectionError || '连接本地 Git 服务后可选择仓库。' }}</span>
          <button
            type="button"
            class="secondary-button"
            :disabled="store.connecting"
            @click="store.init()"
          >
            {{ store.connecting ? '正在连接…' : '连接' }}
          </button>
        </div>
        <template v-if="mode === 'open'">
          <label
            class="repository-field"
            for="repository-open-path"
            ><span>仓库路径</span
            ><span class="repository-path-picker"
              ><input
                id="repository-open-path"
                v-model="store.repositoryOpenPath"
                @input="clearError"
                class="settings-input"
                aria-label="仓库路径"
                placeholder="Git 仓库的绝对路径"
                required
                :disabled="busy"
              /><button
                type="button"
                class="secondary-button"
                :disabled="busy || !localReady"
                @click="browse('repo')"
              >
                浏览…</button
              ><button
                v-if="store.runtime?.platform === 'windows'"
                type="button"
                class="secondary-button"
                :disabled="busy || !localReady"
                @click="browseWsl"
              >
                WSL…
              </button></span
            ></label
          >
        </template>
        <template v-else>
          <label
            v-if="mode === 'clone'"
            class="repository-field"
            for="repository-url"
            ><span>仓库地址</span
            ><input
              id="repository-url"
              v-model="draft.url"
              @input="clearError"
              class="settings-input"
              aria-label="仓库地址"
              placeholder="HTTPS 或 SSH 地址"
              required
              :disabled="busy"
          /></label>
          <label
            class="repository-field"
            for="repository-parent"
            ><span>父目录</span
            ><span class="repository-path-picker"
              ><input
                id="repository-parent"
                v-model="draft.parent"
                @input="clearError"
                class="settings-input"
                aria-label="父目录"
                placeholder="选择已存在的目录"
                required
                :disabled="busy"
              /><button
                type="button"
                class="secondary-button"
                :disabled="busy || !localReady"
                @click="browse('parent')"
              >
                浏览…
              </button></span
            ></label
          >
          <label
            class="repository-field"
            for="repository-name"
            ><span>仓库名称</span
            ><input
              id="repository-name"
              :value="draft.name"
              class="settings-input repository-name"
              aria-label="仓库名称"
              placeholder="my-project"
              required
              :disabled="busy"
              @input="setName"
          /></label>
          <div class="repository-destination">
            <span>目标路径</span
            ><output aria-label="目标路径">{{ destination || '选择父目录并填写仓库名称' }}</output>
          </div>
        </template>
        <p
          v-if="
            localError ||
            (store.repositoryOpenError && mode === 'open') ||
            (store.repositoryCreateError && mode !== 'open')
          "
          :role="store.repositoryCreateCancelled && mode !== 'open' ? 'status' : 'alert'"
          :class="store.repositoryCreateCancelled ? 'repository-notice' : 'repository-error'"
        >
          {{
            localError ||
            (mode === 'open' ? store.repositoryOpenError : store.repositoryCreateError)
          }}
        </p>
        <p
          v-if="store.repositoryCreateError && mode !== 'open'"
          class="repository-help"
        >
          目标目录可能留有文件；请检查目录，或更换名称、位置后重试。不会自动覆盖。
        </p>
        <details
          v-if="store.repositoryCreateDetails && mode !== 'open'"
          class="repository-error-details"
        >
          <summary>详细信息</summary>
          <pre>{{ store.repositoryCreateDetails }}</pre>
        </details>
        <p
          v-if="pickerError"
          class="repository-error"
          role="alert"
        >
          {{ pickerError }}
        </p>
        <details
          v-if="isDesktop()"
          :open="advanced"
          class="repository-advanced"
          @toggle="advanced = ($event.target as HTMLDetailsElement).open"
        >
          <summary>更多选项</summary>
          <button
            type="button"
            class="text-button"
            :disabled="busy || !localReady"
            @click="browse(mode === 'open' ? 'repo' : 'parent', true)"
          >
            使用内置目录浏览器…
          </button>
        </details>
      </div>
      <footer class="repository-entry-actions">
        <span
          class="repository-entry-status"
          role="status"
          >{{ store.busy ? (mode === 'open' ? '正在读取仓库…' : '正在创建仓库…') : '' }}</span
        >
        <button
          v-if="cancelFirst"
          type="button"
          class="secondary-button"
          :disabled="picking || store.cancelling"
          @click="close"
        >
          {{ store.busy ? '取消操作' : '取消' }}
        </button>
        <button
          type="submit"
          class="primary-button"
          :disabled="
            busy ||
            !localReady ||
            (mode === 'open'
              ? !store.repositoryOpenPath.trim()
              : !destination || (mode === 'clone' && !draft.url.trim()))
          "
        >
          {{ mode === 'open' ? '打开仓库' : mode === 'clone' ? '克隆并打开' : '创建并打开' }}
        </button>
        <button
          v-if="!cancelFirst"
          type="button"
          class="secondary-button"
          :disabled="picking || store.cancelling"
          @click="close"
        >
          {{ store.busy ? '取消操作' : '取消' }}
        </button>
      </footer>
    </form>
  </dialog>
  <DirectoryBrowser
    v-if="directoryMode"
    :mode="directoryMode"
    :initial-path="
      directoryMode === 'repo'
        ? store.repositoryOpenPath || (!store.isNewTab ? store.repo.path : undefined)
        : draft.parent || undefined
    "
    @select="choosePath"
    @close="directoryMode = null"
  />
</template>

<style scoped>
.repository-entry-dialog {
  --repository-label-width: 80px;
  --repository-field-gap: 12px;
  inset: 38px 0 0;
  width: min(600px, calc(100vw - 32px));
  padding: 0;
  max-height: calc(100dvh - 54px);
  overflow: hidden;
  border-radius: 8px;
}
.repository-entry-dialog::backdrop {
  background: transparent;
}
.repository-entry-form {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 56px);
}
.repository-entry-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--line);
}
.repository-entry-header h2 {
  margin: 0;
}
.repository-entry-body {
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.repository-field,
.repository-destination {
  display: grid;
  grid-template-columns: var(--repository-label-width) minmax(0, 1fr);
  align-items: center;
  gap: var(--repository-field-gap);
  margin: 0 0 12px;
}
.repository-path-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.repository-path-picker input {
  flex: 1;
  min-width: 0;
  width: 100%;
}
.repository-name {
  width: 100%;
  min-width: 0;
}
.repository-destination {
  align-items: start;
  color: var(--muted);
  font-size: var(--ui-font-help);
  line-height: 1.5;
  margin-bottom: 0;
}
.repository-destination output {
  overflow-wrap: anywhere;
  user-select: text;
}
.repository-entry-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 20px;
  border-top: 1px solid var(--line);
}
.repository-entry-status {
  flex: 1;
  min-width: 100px;
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.repository-entry-body .repository-error,
.repository-entry-body .repository-help,
.repository-entry-body .repository-notice {
  margin: 8px 0 8px calc(var(--repository-label-width) + var(--repository-field-gap));
  line-height: 1.5;
}
.repository-entry-body .repository-error {
  color: var(--danger, var(--git-deleted));
}
.repository-entry-body .repository-help {
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.repository-advanced {
  margin: 16px 0 0 calc(var(--repository-label-width) + var(--repository-field-gap));
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
}
.repository-advanced summary {
  padding: 4px 0;
}
.repository-error-details pre {
  max-height: 140px;
  overflow: auto;
  padding: 8px;
  background: var(--surface-input);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.repository-error-details {
  margin-left: calc(var(--repository-label-width) + var(--repository-field-gap));
}
.repository-connection {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
@media (max-width: 520px) {
  .repository-entry-dialog {
    --repository-label-width: 0px;
    --repository-field-gap: 0px;
  }
  .repository-field,
  .repository-destination {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .repository-entry-body {
    padding: 16px;
  }
}
</style>
