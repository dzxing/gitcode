<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { desktop } from '../services/desktop'
import { useRepositoryStore } from '../stores/repository'
import type { RepositoryFetchSettings } from '../types'

const store = useRepositoryStore()
const intent = store.captureOperation()
const info = ref<RepositoryFetchSettings | null>(null)
const remote = ref('')
const mode = ref<'all' | 'selected'>('all')
const branches = ref('')
const pending = ref(false)
const error = ref('')
const message = ref('')
const confirmHistory = ref(false)
let disposed = false
let version = 0
const sameRepository = computed(
  () => store.repo.path === intent.repo && store.activeTabId === intent.tabId && !store.isNewTab,
)
const selected = computed(() => info.value?.remotes.find((item) => item.name === remote.value))
const branchNames = computed(() => [
  ...new Set(
    branches.value
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean),
  ),
])
const dirty = computed(
  () =>
    selected.value?.mode !== mode.value ||
    (mode.value === 'selected' &&
      JSON.stringify(branchNames.value) !== JSON.stringify(selected.value?.branches)),
)
const locked = computed(() => pending.value || store.isWorking || !sameRepository.value)
function resetDraft() {
  mode.value = selected.value?.mode === 'selected' ? 'selected' : 'all'
  branches.value = selected.value?.branches.join('\n') || ''
  confirmHistory.value = false
  message.value = ''
}
watch(remote, resetDraft)
watch([mode, branches], () => {
  confirmHistory.value = false
})
async function load() {
  if (!sameRepository.value) return
  const current = ++version
  pending.value = true
  error.value = ''
  try {
    const result = await desktop.fetchSettingsRead(intent.repo)
    if (disposed || current !== version || !sameRepository.value) return
    info.value = result
    if (!result.remotes.some((item) => item.name === remote.value))
      remote.value = result.remotes[0]?.name || ''
    resetDraft()
  } catch (e) {
    if (!disposed && current === version)
      error.value = e instanceof Error ? e.message : '无法读取获取设置。'
  } finally {
    if (!disposed && current === version) pending.value = false
  }
}
async function execute(action: 'set-fetch-scope' | 'unshallow' | 'fetch') {
  if (locked.value || !info.value || !selected.value) return
  pending.value = true
  error.value = ''
  message.value = ''
  const notices = new Set(store.notices.map((notice) => notice.id))
  try {
    const ok = await store.run(
      action,
      {
        remote: remote.value,
        signature: info.value.signature,
        mode: mode.value,
        branches: branchNames.value,
      },
      intent,
    )
    if (disposed || !sameRepository.value) return
    if (!ok) {
      error.value =
        action === 'fetch'
          ? '获取未全部完成，请查看操作结果或活动日志；已保存的获取范围会保留。'
          : store.lastActionResult?.error ||
            store.lastActionResult?.warning ||
            store.notices.find((notice) => !notices.has(notice.id))?.text ||
            '操作未完成，请重新读取设置并核对仓库状态。'
      return
    }
    await load()
    if (!disposed)
      message.value =
        action === 'set-fetch-scope'
          ? '获取范围已保存，历史深度未改变。点击“立即获取”更新分支列表。'
          : action === 'fetch'
            ? '已按当前获取配置更新分支列表。'
            : info.value?.shallow
              ? '获取已结束，但仍存在浅历史边界，请核对操作结果。'
              : '历史已补全。分支获取范围保持不变。'
  } catch (e) {
    if (!disposed) error.value = e instanceof Error ? e.message : '操作未完成。'
  } finally {
    if (!disposed) pending.value = false
  }
}
onMounted(load)
onUnmounted(() => {
  disposed = true
  version++
})
</script>

<template>
  <section
    class="fetch-settings"
    aria-labelledby="repository-fetch-title"
    @keydown.enter.stop
  >
    <h3 id="repository-fetch-title">当前仓库 · 获取设置</h3>
    <p class="fetch-path">{{ intent.repo }}</p>
    <p class="fetch-hint">仅作用于此仓库。获取范围与历史深度分别设置。</p>
    <p
      v-if="!sameRepository"
      role="alert"
    >
      当前仓库已切换，请关闭并重新打开设置。
    </p>
    <template v-if="info && sameRepository">
      <p
        v-if="!info.remotes.length"
        role="status"
      >
        仓库尚未配置远端。
      </p>
      <template v-else>
        <label class="fetch-row"
          ><span>远端</span
          ><select
            v-model="remote"
            aria-label="获取设置远端"
            :disabled="locked"
          >
            <option
              v-for="item in info.remotes"
              :key="item.name"
              :value="item.name"
            >
              {{ item.name }}
            </option>
          </select></label
        >
        <fieldset :disabled="locked || !selected?.editable">
          <legend>分支获取范围</legend>
          <p class="fetch-summary">
            {{
              selected?.mode === 'all'
                ? '当前获取此远端的全部分支'
                : selected?.mode === 'selected'
                  ? `当前仅获取：${selected.branches.join('、')}`
                  : '当前使用自定义获取规则'
            }}
          </p>
          <label class="fetch-row"
            ><span>获取分支</span
            ><select
              v-model="mode"
              aria-label="分支获取范围"
            >
              <option value="all">全部分支</option>
              <option value="selected">指定分支</option>
            </select></label
          >
          <label
            v-if="mode === 'selected'"
            class="fetch-branches"
            >分支名（每行一个）<textarea
              autocomplete="off"
              v-model="branches"
              aria-label="指定获取分支"
              rows="3"
              placeholder="master&#10;develop&#10;feature/example"
            ></textarea>
          </label>
          <p class="fetch-hint">
            保存只调整获取规则，不下载历史、不删除已有引用。获取后更新列表；收窄范围不自动清除范围外的缓存。
          </p>
        </fieldset>
        <p
          v-if="selected && !selected.editable"
          class="fetch-hint"
          role="status"
        >
          {{ selected.reason }}
        </p>
        <p
          v-if="selected?.skipped"
          class="fetch-hint"
          role="status"
        >
          此远端配置为跳过批量获取，普通“获取”不会更新它。请先调整 Git 配置。
        </p>
        <div class="fetch-actions fetch-scope-actions">
          <button
            class="secondary-button"
            :disabled="
              locked ||
              !selected?.editable ||
              !dirty ||
              (mode === 'selected' && !branchNames.length)
            "
            @click="execute('set-fetch-scope')"
          >
            保存获取范围
          </button>
          <button
            class="primary-button"
            :disabled="locked || dirty || selected?.skipped"
            @click="execute('fetch')"
          >
            立即获取
          </button>
        </div>
        <p
          v-if="dirty && selected?.editable"
          class="fetch-hint"
        >
          请先保存范围，再获取。
        </p>
        <fieldset
          :disabled="locked"
          class="fetch-history"
        >
          <legend>历史深度</legend>
          <p>{{ info.shallow ? '浅仓库：提交历史尚不完整' : '完整仓库：没有浅历史边界' }}</p>
          <p class="fetch-hint">
            补全历史不会自动改为获取全部分支；只获取其他分支也不必先执行补全历史。
          </p>
          <button
            v-if="info.shallow && !confirmHistory"
            class="secondary-button"
            :disabled="locked || dirty || selected?.skipped"
            @click="confirmHistory = true"
          >
            补全历史…
          </button>
          <div
            v-if="confirmHistory"
            class="fetch-confirm"
            role="group"
            aria-label="确认补全历史"
          >
            <p>
              将从
              {{ remote }}
              下载当前获取范围内缺失的历史，可能需要较多时间和磁盘空间。不会切换分支或修改工作文件。
            </p>
            <div class="fetch-actions">
              <button
                class="secondary-button"
                @click="confirmHistory = false"
              >
                取消</button
              ><button
                class="primary-button"
                :disabled="locked || dirty"
                @click="execute('unshallow')"
              >
                确认补全历史
              </button>
            </div>
          </div>
        </fieldset>
      </template>
    </template>
    <p
      v-if="pending"
      role="status"
    >
      正在读取或执行，请稍候…
    </p>
    <p
      v-if="error"
      class="directory-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="message"
      role="status"
    >
      {{ message }}
    </p>
    <div class="fetch-actions">
      <button
        class="secondary-button"
        :disabled="locked"
        @click="load"
      >
        刷新</button
      ><button
        v-if="pending && store.isWorking"
        class="secondary-button"
        @click="store.cancelOperation()"
      >
        取消操作
      </button>
    </div>
  </section>
</template>

<style scoped>
.fetch-settings p {
  margin: 0 0 10px;
  line-height: 1.5;
}
.fetch-scope-actions {
  justify-content: flex-start;
}
h3 {
  font-size: var(--dialog-font-body);
  margin: 8px 0 12px;
}
.fetch-path {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-size: var(--dialog-font-help);
}
.fetch-hint {
  color: var(--muted);
  line-height: 1.7;
  font-size: var(--dialog-font-help);
}
.fetch-row > span {
  flex: 0 0 var(--settings-label-width, 96px);
}
.fetch-row {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
select,
textarea {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--settings-input-bg, var(--panel));
  color: var(--text);
  padding: 3px 8px;
  font: inherit;
  color-scheme: inherit;
}
select {
  width: min(var(--settings-field-width, 320px), calc(100% - 108px));
  min-height: var(--settings-control-height, 28px);
  min-width: 0;
}
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 20px 0 12px;
  min-width: 0;
}
legend {
  font-weight: 550;
  margin-bottom: 8px;
}
.fetch-summary {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}
.fetch-branches {
  display: grid;
  gap: 8px;
}
textarea {
  width: 100%;
  resize: vertical;
  min-height: 72px;
}
.fetch-history {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.fetch-confirm {
  background: var(--surface-input);
  border: 1px solid var(--line);
  padding: 12px;
  border-radius: 4px;
  line-height: 1.7;
}
.fetch-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
