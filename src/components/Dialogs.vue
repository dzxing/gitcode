<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import { desktop, isDesktop, joinPath, pathName } from '../services/desktop'
import DirectoryBrowser from './DirectoryBrowser.vue'
import { branchReference } from '../references'

const store = useRepositoryStore()
const localReady = computed(() => isDesktop() || store.connected)
const path = ref('')
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
  if (!check) return '本机核心尚不支持远端检查，请重启开发服务或桌面应用。'
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

const remoteUrl = ref('')
const cloneDestination = ref(''),
  createDestination = ref('')
const destination = computed({
  get: () => (store.modal === 'clone' ? cloneDestination.value : createDestination.value),
  set: (value) => {
    if (store.modal === 'clone') cloneDestination.value = value
    else createDestination.value = value
  },
})
const canClose = computed(() => !store.busy || store.modal === 'help')
const directoryMode = ref<'repo' | 'parent' | null>(null)
const pickingDirectory = ref(false)
const pickerError = ref('')
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const destinationInput = ref<HTMLInputElement>()
let previousFocus: HTMLElement | null = null
watch(
  () => store.modal,
  async (value) => {
    publishRemotes.value = []
    publishRemote.value = ''
    publishBranch.value = ''
    if (value) {
      if (
        [
          'stash-delete',
          'merge-conflicts',
          'gitflow-finish',
          'checkout-protected',
          'navigation',
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
      pickerError.value = ''
      await nextTick()
      dialog.value?.showModal()
      if (value === 'create') destinationInput.value?.focus()
      else input.value?.focus()
    } else {
      dialog.value?.close()
      previousFocus?.focus()
    }
  },
)
function close() {
  if (canClose.value) store.modal = null
}
function browseRepository() {
  return browse('repo')
}
function browseParent() {
  return browse('parent')
}
async function browse(mode: 'repo' | 'parent') {
  if (!isDesktop()) {
    directoryMode.value = mode
    return
  }
  if (pickingDirectory.value) return
  pickingDirectory.value = true
  pickerError.value = ''
  try {
    const selected = await desktop.chooseDirectory(
      mode === 'repo' ? path.value || (!store.isNewTab ? store.repo.path : undefined) : undefined,
    )
    if (selected) choosePath(selected, mode)
  } catch (reason) {
    pickerError.value = (reason as Error).message
  } finally {
    pickingDirectory.value = false
  }
}
function choosePath(selected: string, mode = directoryMode.value) {
  if (mode === 'repo') path.value = selected
  else {
    const remoteName =
      store.modal === 'clone'
        ? remoteUrl.value
            .replace(/[\\/]+$/, '')
            .split(/[\\/:]/)
            .pop()
            ?.replace(/\.git$/, '')
        : ''
    const name = destination.value ? pathName(destination.value) : remoteName || 'new-project'
    destination.value = joinPath(selected, name)
  }
  directoryMode.value = null
}
function openRecent(recent: string) {
  path.value = recent
  void store.open(recent)
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
    aria-labelledby="dialog-title"
  >
    <div
      v-if="
        store.modal &&
        ![
          'stash-delete',
          'merge-conflicts',
          'gitflow-finish',
          'checkout-protected',
          'navigation',
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
      <div
        v-if="['open', 'clone', 'create'].includes(store.modal) && !isDesktop()"
        class="local-core-note"
        :class="{ unavailable: !store.connected }"
        role="status"
      >
        <template v-if="store.connected"
          ><strong>本机 Git 核心已连接</strong
          ><span>{{
            store.runtime?.environment === 'wsl'
              ? '正在访问 WSL 目录；Windows 磁盘可从 /mnt/c、/mnt/d 进入。'
              : '选择本机目录，仓库由本机 Git 核心处理。'
          }}</span></template
        >
        <template v-else
          ><strong>{{
            store.connecting ? '正在连接本机 Git 核心…' : '尚未连接本机 Git 核心'
          }}</strong
          ><span>{{ store.connectionError || '连接后即可选择目录并管理本地仓库。' }}</span
          ><button
            type="button"
            class="secondary-button"
            :disabled="store.connecting || store.busy"
            @click="store.init()"
          >
            {{ store.connecting ? '连接中…' : '连接本机核心' }}
          </button></template
        >
      </div>
      <template v-if="store.modal === 'open'">
        <span class="dialog-icon"
          ><Icon
            name="FolderOpen"
            :size="26"
        /></span>
        <h2 id="dialog-title">打开本地仓库</h2>
        <p>连接你的项目，让每一次更改都清晰可见。</p>
        <form @submit.prevent="store.open(path)">
          <label for="repo-path">仓库路径</label>
          <div class="path-picker">
            <input
              id="repo-path"
              ref="input"
              v-model="path"
              class="form-input"
              placeholder="选择本机 Git 仓库目录"
              required
              :disabled="store.busy"
            /><button
              type="button"
              class="secondary-button"
              :disabled="store.busy || pickingDirectory || !localReady"
              @click="browseRepository"
            >
              <Icon
                name="FolderOpen"
                :size="15"
              />浏览
            </button>
          </div>
          <small class="form-help">{{
            isDesktop()
              ? '浏览将打开系统目录选择窗口，也可输入本机绝对路径。'
              : '浏览本机核心可访问的目录，也可输入该环境中的绝对路径。'
          }}</small
          ><button
            v-if="isDesktop()"
            type="button"
            class="text-button"
            :disabled="store.busy || pickingDirectory || !localReady"
            @click="directoryMode = 'repo'"
          >
            使用内置目录浏览器</button
          ><button
            class="primary-button dialog-submit"
            :disabled="store.busy || !localReady || !path.trim()"
          >
            <Icon
              :name="store.busy ? 'LoaderCircle' : 'FolderOpen'"
              :class="{ spin: store.busy }"
            />{{ store.busy ? '正在读取仓库…' : '打开仓库' }}
          </button>
        </form>
        <div
          v-if="store.recent.length"
          class="recent-repos"
        >
          <h3>最近打开</h3>
          <button
            v-for="recent in store.recent"
            :key="recent"
            :disabled="store.busy"
            @click="openRecent(recent)"
          >
            <Icon name="FolderGit2" /><span
              ><strong>{{ pathName(recent) }}</strong
              ><small>{{ recent }}</small></span
            ><Icon
              name="ChevronRight"
              :size="14"
            />
          </button>
        </div>
        <div class="privacy-note">
          <Icon
            name="ShieldCheck"
            :size="14"
          />仓库由本机 Git 核心读取，不上传到云端。
        </div>
      </template>
      <template v-else-if="store.modal === 'clone' || store.modal === 'create'">
        <span class="dialog-icon"
          ><Icon
            :name="store.modal === 'clone' ? 'Cloud' : 'Plus'"
            :size="26"
        /></span>
        <h2 id="dialog-title">{{ store.modal === 'clone' ? '克隆仓库' : '创建本地仓库' }}</h2>
        <p>
          {{
            store.modal === 'clone'
              ? '将远程项目克隆到本机，然后在新标签中打开。'
              : '在新目录中初始化 Git 仓库，从 main 分支开始。'
          }}
        </p>
        <form
          @submit.prevent="
            store.createRepository(
              store.modal === 'clone' ? 'clone' : 'init',
              destination,
              remoteUrl,
            )
          "
        >
          <template v-if="store.modal === 'clone'"
            ><label for="remote-url">仓库地址</label
            ><input
              id="remote-url"
              ref="input"
              v-model="remoteUrl"
              class="form-input"
              placeholder="https://github.com/owner/project.git"
              required
              :disabled="store.busy"
            /><small class="form-help"
              >支持 HTTPS、SSH 地址及本地仓库绝对路径，使用本机 Git 凭据。</small
            ></template
          >
          <label
            for="destination-path"
            :class="{ 'spaced-label': store.modal === 'clone' }"
            >新仓库路径</label
          >
          <div class="path-picker">
            <input
              id="destination-path"
              ref="destinationInput"
              v-model="destination"
              class="form-input"
              placeholder="选择父目录后填写新项目名称"
              required
              :disabled="store.busy"
            /><button
              type="button"
              class="secondary-button"
              :disabled="store.busy || pickingDirectory || !localReady"
              @click="browseParent"
            >
              <Icon
                name="FolderOpen"
                :size="15"
              />父目录
            </button>
          </div>
          <small class="form-help">父目录须已存在；填写尚未创建的新目录作为仓库路径。</small
          ><button
            v-if="isDesktop()"
            type="button"
            class="text-button"
            :disabled="store.busy || pickingDirectory || !localReady"
            @click="directoryMode = 'parent'"
          >
            使用内置目录浏览器
          </button>
          <button
            class="primary-button dialog-submit"
            :disabled="
              store.busy ||
              !localReady ||
              !destination.trim() ||
              (store.modal === 'clone' && !remoteUrl.trim())
            "
          >
            <Icon
              :name="store.busy ? 'LoaderCircle' : store.modal === 'clone' ? 'Cloud' : 'Plus'"
              :class="{ spin: store.busy }"
            />{{
              store.busy
                ? '正在处理，请稍候…'
                : store.modal === 'clone'
                  ? '克隆并打开'
                  : '创建并打开'
            }}
          </button>
        </form>
        <button
          v-if="store.busy"
          class="text-button cancel-operation"
          type="button"
          :disabled="store.cancelling"
          @click="store.cancelOperation()"
        >
          {{ store.cancelling ? '正在取消…' : '取消当前 Git 操作' }}
        </button>
        <div class="privacy-note">
          <Icon
            name="Info"
            :size="14"
          />{{
            store.modal === 'clone'
              ? '克隆最多等待 5 分钟；取消或失败后，目标目录可能留有部分文件。'
              : '只初始化新目录，不会覆盖或重新初始化已有目录。'
          }}
        </div>
      </template>
      <template v-else-if="store.modal === 'close'">
        <span class="dialog-icon"
          ><Icon
            name="FileText"
            :size="26"
        /></span>
        <h2 id="dialog-title">关闭这个仓库标签？</h2>
        <p>
          这个标签里有尚未保存的提交说明或冲突处理草稿，关闭后草稿将被丢弃。本地文件、Git
          暂存区和提交记录都会保留。
        </p>
        <div class="dialog-actions">
          <button
            class="secondary-button"
            @click="close"
          >
            保留标签</button
          ><button
            class="primary-button"
            @click="store.pendingCloseId !== null && store.closeTab(store.pendingCloseId, true)"
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
        <p>重置会移动本地分支；未推送提交将不再属于该分支。本地文件更改会自动贮藏并尝试恢复。</p>
        <form @submit.prevent="confirmRemote('create')">
          <label for="remote-checkout-name">新本地分支名称</label>
          <input
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
        <form @submit.prevent="store.confirmUpstream(upstreamRef)">
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
            重试检查
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
            本机核心需要重启，才能加载新增的合并处理功能。
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
            重新读取目标</button
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
            {{ store.modal === 'push' ? pushLabel : '确认拉取' }}
          </button>
        </div>
      </template>
      <template v-else>
        <span class="dialog-icon"
          ><Icon
            name="Keyboard"
            :size="26"
        /></span>
        <h2 id="dialog-title">让 Git 工作更顺手</h2>
        <p>GitCode · 本地 Git 工作台</p>
        <div class="shortcut-list">
          <div><span>新标签页</span><kbd>Alt T</kbd></div>
          <div><span>打开仓库</span><kbd>Ctrl / ⌘ O</kbd></div>
          <div><span>搜索提交</span><kbd>Ctrl / ⌘ K</kbd></div>
          <div><span>刷新仓库</span><kbd>Ctrl / ⌘ R</kbd></div>
          <div><span>创建提交</span><kbd>Ctrl / ⌘ Enter</kbd></div>
          <div><span>关闭弹窗 / 差异</span><kbd>Esc</kbd></div>
        </div>
        <p class="help-note">
          顶部 +
          打开新标签页，支持打开、克隆、创建仓库。侧栏单击分支筛选历史，双击本地分支打开切换确认。提交树中的本地分支标签单击尝试切换；“+N”查看全部引用，远程引用和标签查看引用详情。点击文件查看差异，使用文件右侧的
          + / − 暂存或取消暂存。远程操作使用本机已有的 Git 凭据。
        </p>
        <div class="privacy-note">
          <Icon
            name="Info"
            :size="14"
          />标签页状态在本次会话中保留，刷新页面后可从最近打开重新进入。
        </div>
      </template>
      <p
        v-if="pickerError"
        class="directory-error"
        role="alert"
      >
        {{ pickerError }}
      </p>
    </div>
  </dialog>
  <DirectoryBrowser
    v-if="directoryMode"
    :mode="directoryMode"
    :initial-path="
      directoryMode === 'repo' ? path || (!store.isNewTab ? store.repo.path : undefined) : undefined
    "
    @select="choosePath($event)"
    @close="directoryMode = null"
  />
</template>
