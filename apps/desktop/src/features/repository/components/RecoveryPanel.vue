<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { coreBridge } from '../../../infrastructure/coreBridge'
import { noticePresentation } from '../../../shared/lib/noticePresentation'
import type { RecoveryPlan } from '../../../shared/contracts'
import Icon from '../../../shared/ui/Icon.vue'
const store = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>()
const plan = ref<RecoveryPlan | null>(null),
  loading = ref(false),
  error = ref(''),
  result = ref('')
const confirmed = ref(false),
  entryId = ref(''),
  name = ref('')
let origin = store.captureOperation()
const previousFocus = document.activeElement as HTMLElement | null
let mounted = true
watch(entryId, (id) => {
  const entry = plan.value?.entries.find((item) => item.id === id)
  name.value = entry
    ? entry.kind === 'deleted'
      ? entry.branch
      : `recovered/${entry.createdAt}`
    : ''
})
async function load(refreshContext = false) {
  if (loading.value || store.busy) return
  loading.value = true
  error.value = ''
  confirmed.value = false
  entryId.value = ''
  plan.value = null
  try {
    if (refreshContext) {
      if (!(await store.refresh())) throw new Error('无法刷新仓库，请稍后重试。')
      if (!mounted || store.repo.path !== origin.repo || store.activeTabId !== origin.tabId) return
      // An explicit reread may adopt the newly displayed HEAD. Initial menu
      // invocation must still match the commit the user actually clicked.
      origin = store.captureOperation()
    }
    const value = await coreBridge.recoveryRead(origin.repo)
    if (mounted && store.repo.path === origin.repo && store.activeTabId === origin.tabId) {
      if (
        value.head !== origin.expectedHead ||
        (value.branch || 'detached HEAD') !== origin.expectedBranch
      ) {
        error.value = '当前分支或 HEAD 已变化，请刷新仓库后重新打开操作恢复。'
        return
      }
      plan.value = value
    }
  } catch (reason) {
    if (mounted)
      error.value = noticePresentation(
        reason instanceof Error ? reason.message : '恢复点读取失败。',
        true,
      ).text
  } finally {
    if (mounted) loading.value = false
  }
}
async function execute(action: 'recovery-undo' | 'recovery-restore') {
  const value = plan.value
  if (!value || store.busy || loading.value) return
  error.value = ''
  result.value = ''
  const ok = await store.run(
    action,
    {
      planId: value.id,
      confirmUnpublished: confirmed.value,
      entryId: entryId.value,
      name: name.value.trim(),
    },
    { ...origin, expectedHead: value.head, expectedBranch: value.branch || 'detached HEAD' },
  )
  if (!mounted) return
  if (ok) {
    result.value =
      action === 'recovery-undo'
        ? '提交已撤回，暂存区和工作文件保留。原提交已保存在下方恢复点中。'
        : '本地分支已恢复，当前检出分支保持不变。'
    // The completed operation changes HEAD. A new preview belongs to the new context.
    store.modal = null
  } else {
    error.value = store.lastActionResult?.error || '操作未完整完成，请核对仓库状态后重新读取。'
    plan.value = null
  }
}
function close() {
  if (!store.busy) store.modal = null
}
onMounted(() => {
  dialog.value?.showModal()
  void load()
})
onBeforeUnmount(() => {
  mounted = false
  dialog.value?.close()
  void nextTick(() => {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  })
})
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog recovery-dialog"
    aria-labelledby="recovery-title"
    @cancel.prevent="close"
  >
    <div class="dialog-content">
      <header class="recovery-header">
        <h2 id="recovery-title">Git 操作恢复</h2>
        <button
          class="icon-button"
          aria-label="关闭操作恢复"
          :disabled="store.busy"
          @click="close"
        >
          <Icon
            name="X"
            :size="16"
          />
        </button>
      </header>
      <p
        v-if="loading"
        role="status"
      >
        正在核对提交和恢复点…
      </p>
      <p
        v-if="error"
        class="form-error"
        role="alert"
      >
        {{ error }}
      </p>
      <p
        v-if="result"
        role="status"
      >
        {{ result }}
      </p>
      <template v-if="plan">
        <section aria-labelledby="recovery-undo-title">
          <h3 id="recovery-undo-title">撤回本地最近提交</h3>
          <p>
            <strong>{{ plan.branch || '游离 HEAD' }}</strong> · {{ plan.head.slice(0, 8) }}
            {{ plan.subject }}
          </p>
          <p class="recovery-note">
            将分支退回上一个提交，暂存区和工作文件保持原样。原提交会保存为恢复点，可另建分支找回。
          </p>
          <p
            v-if="plan.blocked"
            class="recovery-warning"
            role="status"
          >
            {{ plan.blocked }}
          </p>
          <template v-else
            ><p class="recovery-warning">
              本次未查询服务器。本地远程引用可能过期；若提交已经共享，请使用反向提交。可取消后先执行“获取”核对。
            </p>
            <label class="recovery-confirm"
              ><input
                v-model="confirmed"
                type="checkbox"
                :disabled="store.busy"
              />我已确认该提交尚未共享</label
            ></template
          >
          <button
            class="secondary-button"
            :disabled="store.busy || !!plan.blocked || !confirmed"
            @click="execute('recovery-undo')"
          >
            撤回提交并保留代码
          </button>
        </section>
        <section aria-labelledby="recovery-points-title">
          <h3 id="recovery-points-title">
            本仓库恢复点 <small>{{ plan.entries.length }}</small>
          </h3>
          <p class="recovery-note">
            包含通过 GitCode
            删除分支及撤回提交前保存的提交。重启后仍保留；恢复只创建本地分支，不覆盖同名分支；原上游关联需重新设置。
          </p>
          <p v-if="!plan.entries.length">暂无恢复点。</p>
          <label
            v-else
            class="recovery-field"
            >恢复点<select
              v-model="entryId"
              :disabled="store.busy"
            >
              <option value="">请选择恢复点</option>
              <option
                v-for="entry in plan.entries"
                :key="entry.id"
                :value="entry.id"
              >
                {{ entry.kind === 'deleted' ? '删除分支前' : '撤回提交前' }} · {{ entry.branch }} ·
                {{ entry.oid.slice(0, 8) }} · {{ new Date(entry.createdAt).toLocaleString() }}
              </option>
            </select></label
          >
          <label
            v-if="entryId"
            class="recovery-field"
            >恢复后的本地分支名<input
              autocomplete="off"
              v-model="name"
              :disabled="store.busy"
              spellcheck="false"
          /></label>
          <button
            v-if="plan.entries.length"
            class="secondary-button"
            :disabled="store.busy || !entryId || !name.trim()"
            @click="execute('recovery-restore')"
          >
            恢复为本地分支
          </button>
        </section>
      </template>
      <footer class="recovery-footer">
        <button
          class="secondary-button"
          :disabled="loading || store.busy"
          @click="load(true)"
        >
          刷新</button
        ><button
          class="secondary-button"
          :disabled="store.busy"
          @click="close"
        >
          关闭
        </button>
      </footer>
    </div>
  </dialog>
</template>
<style scoped>
.recovery-dialog {
  width: 660px;
}
.recovery-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.recovery-header h2 {
  margin: 0;
}
.recovery-header .icon-button {
  flex: 0 0 26px;
  height: 26px;
}
section {
  padding: 16px 0;
  border-top: 1px solid var(--line);
}
h3 {
  margin: 0 0 10px;
  font-size: var(--ui-font-size);
}
h3 small {
  color: var(--muted);
}
.recovery-note {
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.recovery-warning {
  color: var(--theme-warning-text, #edc779);
  font-size: var(--ui-font-size);
}
.recovery-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}
.recovery-field {
  display: grid;
  gap: 8px;
  margin: 12px 0;
}
.recovery-field select,
.recovery-field input {
  width: 100%;
  min-width: 0;
}
.recovery-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
