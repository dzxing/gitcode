import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useMergeStore } from '../../merge/stores/merge'
import { desktop } from '../../../infrastructure/desktop'
import type { Branch, NavigationInfo, NavigationRequest } from '../../../shared/contracts'
import { branchReference } from '../../../shared/lib/references'
export type NavigationMode =
  | 'merge-branch'
  | 'fast-forward'
  | 'create-tag'
  | 'create-annotated-tag'
  | 'delete-remote-branch'
  | 'compare-head'
  | 'compare-working'
export const useNavigationStore = defineStore('navigation', () => {
  const repo = useRepositoryStore()
  const target = ref<Branch | null>(null),
    mode = ref<NavigationMode>('merge-branch'),
    info = ref<NavigationInfo | null>(null),
    error = ref(''),
    loading = ref(false),
    writing = ref(false)
  const name = ref(''),
    message = ref(''),
    file = ref('')
  const tagAnnotated = ref(false)
  const annotated = computed(() => mode.value === 'create-annotated-tag' || tagAnnotated.value)
  const intent = ref<ReturnType<typeof repo.captureOperation> | null>(null)
  let version = 0
  const comparing = computed(() => mode.value.startsWith('compare-'))
  const stale = computed(
    () =>
      !!intent.value &&
      (repo.repo.path !== intent.value.repo ||
        repo.activeTabId !== intent.value.tabId ||
        repo.repo.head !== intent.value.expectedHead ||
        repo.repo.branch !== intent.value.expectedBranch),
  )
  const heading = computed(
    () =>
      ({
        'merge-branch': '合并分支',
        'fast-forward': '快进当前分支',
        'create-tag': '创建标签',
        'create-annotated-tag': '创建附注标签',
        'delete-remote-branch': '删除远程分支',
        'compare-head': '与当前分支比较',
        'compare-working': '与工作区比较',
      })[mode.value],
  )
  const blocked = computed(() =>
    loading.value || writing.value || repo.busy
      ? '正在处理，请稍候'
      : stale.value
        ? '仓库或当前分支已变化，请关闭后重新打开'
        : !info.value
          ? '请先重新读取操作目标'
          : mode.value === 'merge-branch' || mode.value === 'fast-forward'
            ? !info.value.branch || !info.value.head
              ? '请先检出一个本地分支'
              : info.value.alreadyMerged
                ? '该引用的提交已包含在当前分支中'
                : !info.value.related
                  ? '未找到共同历史，请先检查仓库历史是否完整'
                  : mode.value === 'fast-forward' && !info.value.canFastForward
                    ? '当前不能快进，可以改用合并'
                    : ''
            : mode.value === 'delete-remote-branch' && !info.value.remote
              ? '请重新核对服务器上的分支状态'
              : '',
  )
  function request(path?: string): NavigationRequest {
    return {
      ...intent.value!,
      fullRef: branchReference(target.value!),
      expectedOid: target.value!.hash,
      kind: comparing.value
        ? (mode.value as 'compare-head' | 'compare-working')
        : mode.value === 'delete-remote-branch'
          ? 'delete-remote'
          : 'info',
      ...(path ? { file: path } : {}),
    }
  }
  async function read(path?: string) {
    if (!target.value || !intent.value || repo.busy || writing.value) return
    const attempt = ++version
    loading.value = true
    error.value = ''
    if (comparing.value && info.value) info.value = { ...info.value, diff: null }
    else info.value = null
    if (path) file.value = path
    else if (comparing.value) file.value = ''
    try {
      const value = await desktop.navigationRead(intent.value.repo, request(path))
      if (attempt !== version || stale.value) return
      info.value = value
      if (path) file.value = path
    } catch (failure) {
      if (attempt === version) error.value = (failure as Error).message
    } finally {
      if (attempt === version) loading.value = false
    }
  }
  async function open(nextMode: NavigationMode, branch: Branch, origin = repo.captureOperation()) {
    if (
      repo.busy ||
      repo.modal ||
      origin.repo !== repo.repo.path ||
      origin.tabId !== repo.activeTabId
    )
      return
    version++
    mode.value = nextMode
    tagAnnotated.value = false
    target.value = { ...branch }
    intent.value = { ...origin }
    info.value = null
    error.value = ''
    name.value = ''
    message.value = ''
    file.value = ''
    repo.modal = 'navigation'
    await read()
  }
  function close() {
    if (writing.value || repo.busy) return
    version++
    loading.value = false
    repo.modal = null
    target.value = null
    info.value = null
  }
  async function execute() {
    if (blocked.value || !target.value || !intent.value || comparing.value) return
    const origin = { ...intent.value },
      branch = { ...target.value }
    writing.value = true
    error.value = ''
    const action = mode.value === 'create-annotated-tag' ? 'create-tag' : mode.value
    try {
      const ok = await repo.run(
        action,
        {
          fullRef: branchReference(branch),
          expectedOid: branch.hash,
          confirm: true,
          name: name.value.trim(),
          message: message.value,
          annotated: annotated.value,
          remoteSignature: info.value?.remote?.signature,
        },
        origin,
      )
      if (repo.repo.path !== origin.repo || repo.activeTabId !== origin.tabId) return
      if (repo.repo.merge) {
        repo.modal = null
        target.value = null
        useMergeStore().open()
        return
      }
      if (ok) {
        target.value = null
        info.value = null
      } else {
        info.value = null
        error.value =
          repo.lastActionResult?.error ||
          repo.lastActionResult?.warning ||
          '操作未完成，请重新读取目标后核对。'
      }
    } finally {
      writing.value = false
    }
  }
  watch([() => repo.activeTabId, () => repo.repo.path], () => {
    version++
    loading.value = false
    target.value = null
    info.value = null
    if (repo.modal === 'navigation') repo.modal = null
  })
  return {
    target,
    mode,
    info,
    error,
    loading,
    writing,
    name,
    message,
    annotated,
    tagAnnotated,
    file,
    stale,
    comparing,
    heading,
    blocked,
    open,
    close,
    read,
    execute,
  }
})
