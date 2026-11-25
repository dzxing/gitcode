<script setup lang="ts">
import { vOverflowTitle } from '../../shared/ui/overflowTitle'
import { computed, nextTick, ref, watch } from 'vue'
import { useRepositoryStore } from '../../features/repository/stores/repository'
import Icon from '../../shared/ui/Icon.vue'
import { branchReference } from '../../shared/lib/references'
import { getUIPlatform } from '../../infrastructure/platform'

const store = useRepositoryStore()
const modifierKey = computed(() => (getUIPlatform() === 'macos' ? '⌘' : 'Ctrl'))
const branch = ref('')
const switchAfter = ref(false)
const upstreamRef = ref(''),
  choiceError = ref('')
const upstreamChoices = computed(() =>
  store.repo.branches.filter((b) => b.kind === 'remote' && !b.symbolicTarget),
)
async function confirmRemote(choice: 'create' | 'reset') {
  const p = store.remoteCheckout
  if (!p || store.busy) return
  choiceError.value = ''
  const ok = await store.run(
    'checkout-remote-confirm',
    { planId: p.id, choice, ...(choice === 'create' ? { name: branch.value.trim() } : {}) },
    p.intent,
  )
  if (ok || ['partial', 'cancelled'].includes(store.lastActionResult?.outcome || '')) {
    store.remoteCheckout = null
    store.modal = null
  } else choiceError.value = store.lastActionResult?.error || '检出未完成，请刷新后重试。'
}
async function fetchUpstream() {
  const p = store.upstreamRequest
  if (!p || store.busy) return
  await store.run('fetch', {}, p.intent)
  if (store.repo.path === p.intent.repo) store.modal = 'upstream'
}
const frozen = ref<ReturnType<typeof store.captureOperation> | null>(null)
const publishRemote = ref(''),
  publishBranch = ref(''),
  publishRemotes = ref<string[]>([])
const publishDirty = computed(
  () =>
    publishRemotes.value.length > 0 &&
    (!store.syncPreview?.publish ||
      publishRemote.value !== store.syncPreview.publish.remote ||
      publishBranch.value !== store.syncPreview.publish.branch),
)
watch(
  () => store.syncPreview?.publish,
  (target) => {
    if (target) {
      publishRemote.value = target.remote
      publishBranch.value = target.branch
      publishRemotes.value = [...target.remotes]
    }
  },
)

const pushBlocked = computed(() =>
  ['error', 'behind', 'diverged'].includes(store.syncPreview?.remoteCheck?.state || ''),
)
const pushStatus = computed(() => {
  const check = store.syncPreview?.remoteCheck
  if (store.busy) return '正在检查远端目标…'
  if (publishDirty.value) return '目标已修改，请核对远端状态。'
  if (!check) return '本地 Git 服务尚不支持远端检查，请重启开发服务或桌面应用。'
  if (check.state === 'error') return check.message
  if (check.state === 'absent')
    return store.syncPreview?.publish
      ? '远端未找到目标分支，将创建并关联此分支。'
      : '远端未找到目标分支，将创建此分支。'
  if (check.state === 'deleted') return '关联的远端分支已被删除，继续将重新创建。'
  if (check.state === 'behind' || check.state === 'diverged')
    return check.behind
      ? `远端有 ${check.behind} 个未整合的提交，请先获取并检查。`
      : '无法确认本地包含远端历史，请先获取完整历史并检查。'
  if (check.state === 'current')
    return store.syncPreview?.publish ? '提交一致，推送后建立关联。' : '已与远端同步。'
  return `将推送 ${check.ahead || 0} 个提交${store.syncPreview?.publish ? '并建立关联' : ''}。`
})
const pushLabel = computed(() => {
  if (store.busy) return '正在处理…'
  const check = store.syncPreview?.remoteCheck
  if (check?.state === 'absent') return '创建并推送'
  if (check?.state === 'deleted') return '重新创建并推送'
  return store.syncPreview?.publish ? '推送并关联' : '推送'
})
async function checkPublishTarget() {
  if (!store.busy && publishDirty.value && publishRemote.value && publishBranch.value.trim())
    await store.setPublishTarget(publishRemote.value, publishBranch.value.trim())
}

const canClose = computed(() => !store.busy || store.modal === 'help')
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
let previousFocus: HTMLElement | null = null
watch(
  () => store.modal,
  async (value) => {
    if (value !== 'push' || !store.syncPreview?.publish) {
      publishRemotes.value = []
      publishRemote.value = ''
      publishBranch.value = ''
    }
    if (value) {
      if (value === 'branch' && store.inlineBranchActive) {
        dialog.value?.close()
        return
      }
      if (
        [
          'open',
          'clone',
          'create',
          'stash-delete',
          'gitflow-finish',
          'checkout-protected',
          'navigation',
          'recovery',
          'commit-operation',
        ].includes(value)
      ) {
        dialog.value?.close()
        return
      }
      previousFocus = document.activeElement as HTMLElement
      branch.value = ''
      choiceError.value = ''
      upstreamRef.value = ''
      if (value === 'checkout-remote' && store.remoteCheckout)
        branch.value = `${store.remoteCheckout.branch}-local`
      switchAfter.value = false
      frozen.value = store.captureOperation()
      await nextTick()
      dialog.value?.showModal()
      input.value?.focus()
    } else {
      dialog.value?.close()
      previousFocus?.focus()
    }
  },
)
function close() {
  if (canClose.value) store.modal = null
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    :class="{
      'dialog-confirmation': store.modal === 'close',
      'prompt-bar': ['branch', 'upstream', 'push', 'pull', 'checkout-remote'].includes(
        store.modal || '',
      ),
    }"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
    aria-labelledby="dialog-title"
  >
    <div
      v-if="
        store.modal &&
        ![
          'open',
          'clone',
          'create',
          'stash-delete',
          'gitflow-finish',
          'checkout-protected',
          'navigation',
          'recovery',
          'commit-operation',
        ].includes(store.modal)
      "
      class="dialog-content"
    >
      <button
        class="icon-button dialog-close"
        aria-label="关闭弹窗"
        :disabled="!canClose"
        @click="close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <template v-if="store.modal === 'close'">
        <span class="dialog-icon"
          ><Icon
            name="FileText"
            :size="26"
        /></span>
        <h2 id="dialog-title">
          {{
            store.pendingCloseTabs.length > 1
              ? `关闭这 ${store.pendingCloseTabs.length} 个标签？`
              : '关闭这个仓库标签？'
          }}
        </h2>
        <p>
          标签中有尚未完成的提交说明或冲突处理草稿，关闭后这些草稿将被丢弃。本地文件、Git
          暂存区和提交记录都会保留。
        </p>
        <ul
          v-if="store.pendingCloseTabs.length > 1"
          class="close-tabs-list"
        >
          <li
            v-for="tab in store.pendingCloseTabs"
            :key="tab.id"
            v-overflow-title="tab.path"
          >
            {{ tab.name }}
          </li>
        </ul>
        <div class="dialog-actions">
          <button
            class="secondary-button"
            @click="close"
          >
            保留标签</button
          ><button
            class="primary-button"
            @click="store.closeTabs([...store.pendingCloseIds], true)"
          >
            丢弃草稿并关闭
          </button>
        </div>
      </template>
      <template v-else-if="store.modal === 'checkout-remote' && store.remoteCheckout">
        <h2 id="dialog-title">检出 {{ store.remoteCheckout.remote }}</h2>
        <p>
          本地分支
          {{ store.remoteCheckout.branch }}
          与远程分支指向不同提交。可以新建本地分支，或将同名本地分支重置到远程提交。
        </p>
        <p>
          重置会将本地分支移到远程提交，本地独有的提交可能不再属于该分支。本地文件更改会自动贮藏并尝试恢复。
        </p>
        <form
          autocomplete="off"
          @submit.prevent="confirmRemote('create')"
        >
          <label for="remote-checkout-name">新本地分支名称</label>
          <input
            autocomplete="off"
            id="remote-checkout-name"
            ref="input"
            v-model="branch"
            class="form-input"
            required
            :disabled="store.busy"
          />
          <p
            v-if="choiceError"
            class="directory-error"
            role="alert"
          >
            {{ choiceError }}
          </p>
          <div class="dialog-actions">
            <button
              type="button"
              class="secondary-button"
              :disabled="store.busy"
              @click="close"
            >
              取消
            </button>
            <button
              type="button"
              class="danger-button"
              :disabled="store.busy"
              @click="confirmRemote('reset')"
            >
              重置本地分支并检出
            </button>
            <button
              class="primary-button"
              :disabled="store.busy || !branch.trim()"
            >
              新建分支并检出
            </button>
          </div>
        </form>
      </template>
      <template v-else-if="store.modal === 'upstream' && store.upstreamRequest">
        <h2 id="dialog-title">设置上游分支</h2>
        <p>
          {{ store.upstreamRequest.branch.name }} 尚未关联远程分支。请选择拉取目标，设置后继续拉取。
        </p>
        <form
          autocomplete="off"
          @submit.prevent="store.confirmUpstream(upstreamRef)"
        >
          <label for="pull-upstream">远程分支</label>
          <select
            id="pull-upstream"
            v-model="upstreamRef"
            class="form-input"
            :disabled="store.busy"
            required
          >
            <option
              disabled
              value=""
            >
              选择远程分支
            </option>
            <option
              v-for="item in upstreamChoices"
              :key="branchReference(item)"
              :value="branchReference(item)"
            >
              {{ item.name }}
            </option>
          </select>
          <p v-if="!upstreamChoices.length">尚未获取到远程分支，请先获取远端更新。</p>
          <div class="dialog-actions">
            <button
              type="button"
              class="secondary-button"
              :disabled="store.busy"
              @click="close"
            >
              取消
            </button>
            <button
              type="button"
              class="secondary-button"
              :disabled="store.busy"
              @click="fetchUpstream"
            >
              获取远程分支
            </button>
            <button
              class="primary-button"
              :disabled="store.busy || !upstreamRef"
            >
              设置并继续拉取
            </button>
          </div>
        </form>
      </template>
      <template v-else-if="store.modal === 'branch'">
        <span class="dialog-icon"
          ><Icon
            name="GitBranch"
            :size="26"
        /></span>
        <h2 id="dialog-title">从这里，开启新分支</h2>
        <p>基于下方显示的提交创建分支，可选择创建后切换。</p>
        <form
          autocomplete="off"
          @submit.prevent="
            frozen &&
            store.run(
              'create-branch',
              { name: branch.trim(), startOid: frozen.expectedHead, switchAfter },
              frozen,
            )
          "
        >
          <label for="branch-name">分支名称</label
          ><input
            autocomplete="off"
            id="branch-name"
            ref="input"
            v-model="branch"
            class="form-input"
            placeholder="feature/your-next-idea"
            required
            :disabled="store.busy"
          />
          <div class="branch-base">
            <Icon
              name="GitCommitHorizontal"
              :size="14"
            />{{ frozen?.expectedBranch
            }}<code>{{ frozen?.expectedHead.slice(0, 7) || '暂无提交' }}</code>
          </div>
          <label class="context-switch-option"
            ><input
              v-model="switchAfter"
              type="checkbox"
              :disabled="store.busy"
            />创建后切换到新分支</label
          ><button
            type="button"
            class="secondary-button prompt-cancel"
            :disabled="store.busy"
            @click="close"
          >
            取消
          </button>
          <button
            class="primary-button dialog-submit"
            :disabled="store.busy || !branch.trim() || !frozen?.expectedHead"
          >
            {{ switchAfter ? '创建并切换' : '创建分支' }}
          </button>
        </form>
      </template>
      <template v-else-if="store.modal === 'push' || store.modal === 'pull'">
        <span class="dialog-icon"
          ><Icon
            :name="store.modal === 'push' ? 'ArrowUpFromLine' : 'ArrowDownToLine'"
            :size="26"
        /></span>
        <h2 id="dialog-title">
          {{ store.modal === 'push' ? '推送指定分支' : '拉取远程分支' }}
        </h2>
        <p
          v-if="store.syncTarget"
          class="sync-branch-name"
        >
          操作分支：{{ store.syncTarget.name }}
        </p>
        <p v-if="store.busy && !store.syncPreview">
          {{ store.modal === 'push' ? '正在检查远端目标…' : '正在读取同步目标…' }}
        </p>
        <section
          v-if="store.modal === 'push' && publishRemotes.length"
          class="publish-targets"
          aria-label="首次推送目标"
        >
          <strong>{{ store.syncPreview?.branch || store.syncTarget?.name }} → 远端目标</strong>
          <label for="publish-remote">远程</label>
          <select
            id="publish-remote"
            v-model="publishRemote"
            @change="checkPublishTarget"
            class="form-input"
            :disabled="store.busy"
          >
            <option
              v-for="remote in publishRemotes"
              :key="remote"
              :value="remote"
            >
              {{ remote }}
            </option>
          </select>
          <label for="publish-branch">远端分支</label>
          <input
            autocomplete="off"
            id="publish-branch"
            v-model="publishBranch"
            @blur="checkPublishTarget"
            @keydown.enter.prevent="checkPublishTarget"
            class="form-input"
            :disabled="store.busy"
            spellcheck="false"
          />

          <button
            v-if="publishDirty"
            class="secondary-button"
            :disabled="store.busy || !publishRemote || !publishBranch.trim()"
            @click="store.setPublishTarget(publishRemote, publishBranch)"
          >
            核对目标
          </button>
        </section>
        <div
          v-if="store.syncPreview && store.modal !== 'push'"
          class="sync-preview"
        >
          <small>本地分支</small><strong>{{ store.syncPreview.sourceRef }}</strong
          ><code>{{ store.syncPreview.head }}</code
          ><small>远程上游</small
          ><strong
            >{{ store.syncPreview.remotes[0]?.name }} /
            {{ store.syncPreview.destinationRef }}</strong
          ><small>{{ store.syncPreview.remotes[0]?.address }}</small>
          <p v-if="store.pullMethod === 'ff-only'">
            将上述远程上游仅快进合入 {{ store.syncPreview.branch }}，不产生合并提交。
            本地更改会自动贮藏，成功后恢复；发生冲突或操作中断时保留贮藏记录。
          </p>
        </div>
        <section
          v-if="store.modal === 'push' && store.syncPreview"
          class="push-check"
          aria-label="远端检查结果"
        >
          <strong v-if="!store.syncPreview.publish"
            >{{ store.syncPreview.branch }} → {{ store.syncPreview.remotes[0]?.name }} /
            {{ store.syncPreview.destinationRef.replace(/^refs\/heads\//, '') }}</strong
          >
          <p
            role="status"
            :class="{
              'directory-error': pushBlocked || store.syncPreview.remoteCheck?.state === 'deleted',
            }"
          >
            {{ pushStatus }}
          </p>
          <button
            v-if="pushBlocked"
            class="secondary-button"
            :disabled="store.busy"
            @click="
              store.syncPreview.publish
                ? store.setPublishTarget(publishRemote, publishBranch)
                : store.retrySync('push')
            "
          >
            重新检查
          </button>
          <button
            v-if="
              ['behind', 'diverged'].includes(store.syncPreview.remoteCheck?.state || '') &&
              !store.syncPreview.publish
            "
            class="primary-button"
            :disabled="store.busy"
            title="获取并合并当前分支的远端更新；成功后重新核对并推送，冲突或目标变化时停止"
            @click="store.pullAndPush()"
          >
            拉取并推送
          </button>
          <button
            v-if="
              ['behind', 'diverged'].includes(store.syncPreview.remoteCheck?.state || '') &&
              !store.syncPreview.publish
            "
            class="secondary-button"
            :disabled="store.busy"
            @click="store.fetchBeforePull()"
          >
            获取并检查
          </button>
          <p
            v-if="
              ['behind', 'diverged'].includes(store.syncPreview.remoteCheck?.state || '') &&
              store.syncPreview.publish
            "
          >
            请先获取并整合目标分支的更新，或选择另一个远端分支名称。
          </p>
          <details>
            <summary>详细信息</summary>
            <p>{{ store.syncPreview.sourceRef }} → {{ store.syncPreview.destinationRef }}</p>
            <code>{{ store.syncPreview.head }}</code>
            <p>{{ store.syncPreview.remotes[0]?.address }}</p>
            <p>
              仅推送已提交内容，工作区保留在
              {{ store.syncPreview.worktreeBranch || store.repo.branch }}。不附带标签。
            </p>
          </details>
        </section>
        <p
          v-if="store.syncError"
          class="directory-error"
          role="alert"
        >
          {{ store.syncError }}
        </p>
        <details
          v-if="store.syncError && store.lastActionResult?.details"
          class="sync-error-details"
        >
          <summary>查看 Git 原始信息</summary>
          <pre>{{ store.lastActionResult.details }}</pre>
        </details>
        <div
          v-if="
            store.modal === 'push' &&
            store.lastActionResult?.syncProblem === 'push-rejected' &&
            store.syncError
          "
          class="sync-next-step"
        >
          <p>若远端已有新提交，请先获取并检查，再整合提交。</p>
          <button
            class="secondary-button"
            :disabled="store.busy"
            @click="store.fetchBeforePull()"
          >
            获取并检查更新
          </button>
        </div>
        <div
          v-if="store.modal === 'pull'"
          class="pull-method"
          role="group"
          aria-label="拉取整合方式"
        >
          <button
            class="secondary-button"
            :aria-pressed="store.pullMethod === 'ff-only'"
            :disabled="store.busy"
            @click="store.setPullMethod('ff-only')"
          >
            仅快进</button
          ><button
            class="secondary-button"
            :aria-pressed="store.pullMethod === 'merge'"
            :disabled="store.busy || store.repo.merge === undefined"
            :title="
              store.repo.merge === undefined ? '请重启开发服务或桌面应用以加载合并功能' : undefined
            "
            @click="store.setPullMethod('merge')"
          >
            尽可能快进（否则合并）
          </button>
          <p v-if="store.repo.merge === undefined">
            本地 Git 服务需要重启，才能加载新增的合并处理功能。
          </p>
          <p>
            {{
              store.pullMethod === 'merge'
                ? '尽可能快进；分叉时合并并提交，有冲突则进入处理界面。本地更改自动贮藏，成功后恢复。不自动推送。'
                : '只允许快进；双方都有独有提交时停止，可选择合并远端更新。'
            }}
          </p>
        </div>
        <div
          v-if="store.busy"
          class="sync-cancellation"
          role="status"
        >
          <button
            class="text-button"
            :disabled="store.cancelling"
            @click="store.cancelOperation()"
          >
            {{
              store.cancelling
                ? '正在取消…'
                : ['prepare-sync', 'refresh'].includes(store.activeOperation)
                  ? '取消读取同步目标'
                  : '取消当前 Git 操作'
            }}</button
          ><small>取消会尝试终止当前任务，已完成的操作不会自动回滚。请等待结果核对。</small>
        </div>
        <div class="dialog-actions">
          <button
            class="secondary-button"
            :disabled="store.busy"
            @click="close"
          >
            取消</button
          ><button
            v-if="!store.syncPreview && !store.busy"
            class="secondary-button"
            @click="store.retrySync(store.modal === 'push' ? 'push' : 'pull')"
          >
            重试</button
          ><button
            class="primary-button"
            :disabled="
              store.busy ||
              !store.syncPreview ||
              publishDirty ||
              (store.modal === 'push' && (pushBlocked || !store.syncPreview.remoteCheck))
            "
            @click="store.confirmSync()"
          >
            {{ store.modal === 'push' ? pushLabel : '拉取' }}
          </button>
        </div>
      </template>
      <template v-else>
        <span class="dialog-icon"
          ><Icon
            name="Keyboard"
            :size="26"
        /></span>
        <h2 id="dialog-title">快捷键与操作说明</h2>
        <p>GitCode · 本地 Git 工作台</p>
        <div class="shortcut-list">
          <div><span>新标签页</span><kbd>Alt+T</kbd></div>
          <div><span>切换标签</span><kbd>Ctrl+Tab / Ctrl+Shift+Tab</kbd></div>
          <div>
            <span>关闭当前标签</span><kbd>{{ modifierKey }}+W</kbd>
          </div>
          <div>
            <span>打开仓库</span><kbd>{{ modifierKey }}+O</kbd>
          </div>
          <div>
            <span>搜索提交</span><kbd>{{ modifierKey }}+K</kbd>
          </div>
          <div><span>筛选分支</span><kbd>/</kbd></div>
          <div>
            <span>刷新本地状态</span><kbd>{{ modifierKey }}+R</kbd>
          </div>
          <div>
            <span>创建提交</span><kbd>{{ modifierKey }}+Enter</kbd>
          </div>
          <div><span>关闭弹窗 / 差异</span><kbd>Esc</kbd></div>
        </div>
        <p class="help-note">
          顶部 +
          打开新标签页，支持打开、克隆、创建仓库。侧栏单击分支筛选历史，双击本地分支尝试切换；本地修改阻碍切换时提示处理。提交树中的本地分支标签单击尝试切换；“+N”查看全部引用，远程引用和标签查看引用详情。点击文件查看差异，使用文件右侧的
          + / − 暂存或取消暂存。远程操作使用本机已有的 Git 凭据。
        </p>
        <div class="privacy-note">
          <Icon
            name="Info"
            :size="14"
          />每个仓库分别保留搜索条件和提交说明草稿。
        </div>
      </template>
    </div>
  </dialog>
</template>
