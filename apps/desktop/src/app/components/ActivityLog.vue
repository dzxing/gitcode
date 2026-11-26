<script setup lang="ts">
import { vOverflowTitle } from '../../shared/ui/overflowTitle'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../../features/repository/stores/repository'
import { coreBridge } from '../../infrastructure/coreBridge'
import type { ActivitySettings, OperationLogEntry, OperationLogQuery } from '../../shared/contracts'
import Icon from '../../shared/ui/Icon.vue'
import { fetchLogPresentation } from '../../shared/lib/activityLogPresentation'

const store = useRepositoryStore()
const dialog = ref<HTMLDialogElement>()
const scope = ref<'application' | 'repository'>(store.isNewTab ? 'application' : 'repository')
const records = ref<OperationLogEntry[]>([])
const selected = ref(store.activityLogId)
const detail = computed(() => records.value.find((record) => record.id === selected.value))
const detailReady = computed(() => detail.value?.detailLoaded !== false)
const fetchDetail = computed(() =>
  detail.value?.operation === 'fetch' ? fetchLogPresentation(detail.value) : null,
)
const focusFailure = ref(store.activityLogFocus === 'fetch-failure')
const missingFailure = ref(false)
const settingsOpen = ref(false)
const settings = ref<ActivitySettings>({ autoFetchInterval: 1, extended: false })
const settingsReady = ref(false)
const error = ref('')
const loadError = ref('')
const storageError = ref('')
const saving = ref(false)
const confirmingClear = ref(false)
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
let alive = true
const query = computed<OperationLogQuery>(() => ({
  scope: scope.value,
  repo: store.isNewTab ? '' : store.repo.path,
}))
const labels: Record<string, string> = {
  'core-start': '启动本地 Git 服务',
  'application-startup': '应用启动与会话恢复',
  'application-exit': '应用退出与任务收尾',
  'application-interface': '应用界面异常',
  'activity-settings': '修改活动日志与自动获取设置',
  fetch: '获取',
  'set-fetch-scope': '保存分支获取范围',
  unshallow: '补全仓库历史',
  pull: '拉取',
  push: '推送',
  'pull-and-push': '拉取并推送',
  commit: '提交',
  'commit-selected': '提交所选文件',
  stage: '暂存',
  unstage: '取消暂存',
  checkout: '检出分支',
  branch: '创建分支',
  'create-branch': '创建分支',
  'rename-branch': '重命名分支',
  'delete-branch': '删除分支',
  clone: '克隆',
  init: '初始化仓库',
  'stash-create': '贮藏',
  'partial-stage': '局部暂存／取消暂存',
  'recovery-undo': '撤回本地最近提交',
  'recovery-restore': '恢复本地分支',
  'stash-apply': '恢复并保留贮藏',
  'stash-pop': '恢复并移除贮藏',
  'stash-drop': '删除贮藏',
  'merge-start': '合并',
  'merge-finish': '完成合并',
  'merge-abort': '中止合并',
  'gitflow-init': '初始化 GitFlow',
  'gitflow-start': '开始 GitFlow 分支',
  'gitflow-finish': '完成 GitFlow 分支',
}
const states: Record<OperationLogEntry['state'], string> = {
  running: '进行中',
  succeeded: '成功',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果待核对',
}
function title(record: OperationLogEntry) {
  return `${record.background ? '自动' : ''}${labels[record.operation] || record.operation}`
}
function selectRecord(id: string) {
  focusFailure.value = false
  missingFailure.value = false
  selected.value = id
  copied.value = false
}
function close() {
  dialog.value?.close()
  store.activityPanelOpen = false
}
async function load() {
  const current = ++version
  clearTimeout(timer)
  try {
    const value = await coreBridge.operationLog({
      ...query.value,
      ...(focusFailure.value ? { focus: 'fetch-failure' as const } : {}),
      ...(selected.value ? { id: selected.value } : {}),
    })
    if (!alive || current !== version) return
    records.value = value.records
    if (focusFailure.value && query.value.scope === 'repository') {
      focusFailure.value = false
      const failure = value.records.find(
        (record) =>
          record.operation === 'fetch' && ['failed', 'partial', 'unknown'].includes(record.state),
      )
      if (failure) {
        selected.value = failure.id
        void nextTick(() =>
          dialog.value
            ?.querySelector('.activity-log-row.selected')
            ?.scrollIntoView({ block: 'nearest' }),
        )
      } else missingFailure.value = true
    }
    storageError.value = value.storageError
    if (!settingsReady.value) {
      settings.value = { ...value.settings }
      settingsReady.value = true
    }
    loadError.value = ''
  } catch (e) {
    if (alive && current === version) loadError.value = (e as Error).message
  } finally {
    if (alive && current === version)
      timer = setTimeout(() => {
        void load()
      }, 1500)
  }
}
watch(selected, () => {
  void load()
})
watch(query, () => {
  focusFailure.value = false
  missingFailure.value = false
  records.value = []
  selected.value = ''
  confirmingClear.value = false
  void load()
})
async function saveSettings() {
  if (saving.value || !settingsReady.value) return
  saving.value = true
  error.value = ''
  try {
    await store.saveActivitySettings({ ...settings.value })
    settingsOpen.value = false
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
async function clear() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await coreBridge.clearOperationLog(query.value)
    selected.value = ''
    confirmingClear.value = false
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
function retryFetch() {
  if (!detail.value || detail.value.repo !== store.repo.path || store.isNewTab || store.isWorking)
    return
  retryCurrentFetch()
}
function retryCurrentFetch() {
  if (query.value.scope !== 'repository' || store.isNewTab || !store.connected || store.isWorking)
    return
  close()
  void store.run('fetch')
}
async function copy() {
  if (!detail.value || !detailReady.value) return
  const record = detail.value
  try {
    await navigator.clipboard.writeText(
      [
        new Date(record.startedAt).toLocaleString(),
        title(record),
        record.repo,
        record.target,
        states[record.state],
        ...(fetchDetail.value
          ? [
              fetchDetail.value.summary,
              ...fetchDetail.value.remotes.map(
                (step) => `${step.remote}：${step.summary}${step.output ? `\n${step.output}` : ''}`,
              ),
              fetchDetail.value.raw,
            ]
          : [record.message, record.output]),
        record.commands,
        record.truncated ? '部分输出已截断' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    copied.value = true
  } catch {
    error.value = '无法复制，请选择详情文字后复制。'
  }
}
onMounted(async () => {
  dialog.value?.showModal()
  await load()
  await nextTick()
  if (store.activityLogId) selected.value = store.activityLogId
})
onUnmounted(() => {
  alive = false
  version++
  clearTimeout(timer)
})
</script>

<template>
  <dialog
    ref="dialog"
    class="activity-log-dialog"
    aria-labelledby="activity-log-title"
    @cancel.prevent="close"
    @close="close"
  >
    <header class="activity-log-header">
      <h2 id="activity-log-title">活动日志</h2>
      <button
        class="text-button"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        自动获取与日志设置
      </button>
      <button
        class="icon-button"
        aria-label="关闭活动日志"
        @click="close"
      >
        <Icon
          name="X"
          :size="16"
        />
      </button>
    </header>
    <form
      autocomplete="off"
      v-if="settingsOpen"
      class="activity-log-settings"
      @submit.prevent="saveSettings"
    >
      <label
        >自动获取间隔
        <input
          autocomplete="off"
          v-model.number="settings.autoFetchInterval"
          type="number"
          min="0"
          max="60"
          step="1"
          required
          :disabled="saving || !settingsReady"
          aria-label="自动获取间隔（分钟）"
        />
        分钟</label
      >
      <span>0 关闭，仅获取当前仓库；不自动拉取、合并或推送。</span>
      <label
        ><input
          v-model="settings.extended"
          type="checkbox"
          :disabled="saving || !settingsReady"
        />扩展日志（包含自动获取与内部命令）</label
      >
      <button
        type="submit"
        class="secondary-button"
        :disabled="saving || !settingsReady"
      >
        {{ saving ? '保存中…' : '保存设置' }}
      </button>
    </form>
    <div
      class="activity-log-tabs"
      role="tablist"
      aria-label="日志范围"
    >
      <button
        id="activity-application-tab"
        role="tab"
        :aria-selected="scope === 'application'"
        aria-controls="activity-log-list"
        @click="scope = 'application'"
      >
        应用
      </button>
      <button
        id="activity-repository-tab"
        role="tab"
        :aria-selected="scope === 'repository'"
        :disabled="store.isNewTab"
        aria-controls="activity-log-list"
        @click="scope = 'repository'"
      >
        当前仓库
      </button>
      <span v-overflow-title="query.repo">{{
        scope === 'repository' ? store.repo.name : 'GitCode'
      }}</span>
      <button
        class="text-button"
        :disabled="saving || !records.length"
        @click="confirmingClear = true"
      >
        清空日志
      </button>
    </div>
    <p
      v-if="error || loadError || storageError"
      class="activity-log-warning"
      role="status"
    >
      {{ error || loadError || storageError }}
    </p>
    <p
      v-if="missingFailure"
      class="activity-log-warning"
      role="status"
    >
      最近的获取失败记录已被清理或不在保留范围内。<button
        class="text-button"
        :disabled="store.isWorking || !store.connected"
        @click="retryCurrentFetch"
      >
        手动获取
      </button>
    </p>
    <div
      v-if="confirmingClear"
      class="activity-log-clear"
      role="group"
      aria-label="确认清空日志"
    >
      <span>清空此范围的已完成记录？正在执行的记录会保留。</span>
      <button
        class="secondary-button"
        :disabled="saving"
        @click="confirmingClear = false"
      >
        取消
      </button>
      <button
        class="danger-button"
        :disabled="saving"
        @click="clear"
      >
        清空记录
      </button>
    </div>
    <div
      class="activity-log-body"
      :class="{ 'has-detail': detail }"
    >
      <section
        id="activity-log-list"
        role="tabpanel"
        :aria-labelledby="
          scope === 'application' ? 'activity-application-tab' : 'activity-repository-tab'
        "
        class="activity-log-list"
        aria-label="操作记录"
      >
        <p
          v-if="!records.length"
          class="activity-log-empty"
        >
          {{ error ? '日志暂时不可用。' : '暂无操作记录。' }}
        </p>
        <button
          v-for="record in records"
          :key="record.id"
          class="activity-log-row"
          :class="{ selected: record.id === selected }"
          :aria-expanded="record.id === selected"
          @click="selectRecord(record.id)"
        >
          <time :datetime="new Date(record.lastSeenAt || record.startedAt).toISOString()">{{
            new Date(record.lastSeenAt || record.startedAt).toLocaleTimeString()
          }}</time>
          <span class="activity-log-operation"
            >{{ title(record)
            }}<small v-if="(record.repeatCount || 0) > 1"> ×{{ record.repeatCount }}</small
            ><small v-if="record.target"> · {{ record.target }}</small></span
          >
          <span
            class="activity-log-state"
            :data-state="record.state"
            >{{ states[record.state] }}</span
          >
          <span>{{ record.duration != null ? `${record.duration} ms` : '…' }}</span>
        </button>
      </section>
      <section
        v-if="detail"
        class="activity-log-detail"
        aria-label="操作详情"
      >
        <header>
          <strong>{{ title(detail) }} · {{ states[detail.state] }}</strong
          ><button
            v-if="
              detail.operation === 'fetch' &&
              ['failed', 'partial', 'unknown'].includes(detail.state) &&
              detail.repo === store.repo.path
            "
            class="text-button"
            :disabled="store.isWorking || !store.connected"
            @click="retryFetch"
          >
            手动获取</button
          ><button
            class="text-button"
            :disabled="!detailReady"
            @click="copy"
          >
            {{ copied ? '已复制' : '复制详情' }}</button
          ><button
            class="icon-button"
            aria-label="关闭操作详情"
            @click="selected = ''"
          >
            <Icon
              name="X"
              :size="13"
            />
          </button>
        </header>
        <p>
          {{ new Date(detail.startedAt).toLocaleString() }}<br />{{ detail.repo
          }}<template v-if="detail.target"><br />{{ detail.target }}</template
          ><template v-if="detail.lastSeenAt"
            ><br />最近发生：{{ new Date(detail.lastSeenAt).toLocaleString() }}</template
          >
        </p>
        <p
          v-if="!detailReady"
          role="status"
        >
          正在加载详情…
        </p>
        <template v-else-if="fetchDetail">
          <p class="activity-log-summary">{{ fetchDetail.summary }}</p>
          <div
            v-if="fetchDetail.remotes.length"
            class="activity-log-remotes"
            role="group"
            aria-label="各远端获取结果"
          >
            <div
              v-for="step in fetchDetail.remotes"
              :key="step.remote"
              class="activity-log-remote"
              :class="{ 'has-error': !step.ok }"
            >
              <div class="activity-log-remote-heading">
                <Icon
                  :name="step.ok ? 'Check' : 'AlertCircle'"
                  :size="13"
                /><strong>{{ step.remote }}</strong
                ><span>{{ step.summary }}</span>
              </div>
              <details v-if="step.output">
                <summary>{{ step.remote }} 的原始输出</summary>
                <pre>{{ step.output }}</pre>
              </details>
            </div>
          </div>
          <details v-if="fetchDetail.raw">
            <summary>{{ fetchDetail.remotes.length ? '其他原始详情' : '原始 Git 输出' }}</summary>
            <pre>{{ fetchDetail.raw }}</pre>
          </details>
        </template>
        <template v-else>
          <pre v-if="detail.message">{{ detail.message }}</pre>
          <pre v-if="detail.output && detail.output !== detail.message">{{ detail.output }}</pre>
        </template>
        <details v-if="detail.commands">
          <summary>内部命令与诊断输出</summary>
          <pre>{{ detail.commands }}</pre>
        </details>
        <p
          v-if="detail.truncated"
          class="activity-log-warning"
        >
          部分输出已截断。
        </p>
      </section>
    </div>
    <footer class="activity-log-footer">
      本机保留最近 7 天，最多 5000 条操作与 20 MiB 数据；每个范围显示最近 500
      条。日志不代表撤销记录。
    </footer>
  </dialog>
</template>
