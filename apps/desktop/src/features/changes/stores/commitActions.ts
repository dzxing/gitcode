import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useMergeStore } from '../../merge/stores/merge'
import { desktop } from '../../../infrastructure/desktop'
import type {
  Commit,
  CommitOperation,
  CommitOperationRead,
  CommitOperationRequest,
  RebaseStep,
  SyncPlan,
} from '../../../shared/contracts'

type Mode = CommitOperation | 'browse' | 'patch' | 'browser' | 'push' | 'checkout'
export const useCommitActionsStore = defineStore('commit-actions', () => {
  const repo = useRepositoryStore()
  const mode = ref<Mode>('browse'),
    commits = ref<Commit[]>([])
  const origin = ref<ReturnType<typeof repo.captureOperation> | null>(null)
  const data = ref<CommitOperationRead | null>(null),
    loading = ref(false),
    error = ref('')
  const message = ref(''),
    resetMode = ref(localStorage.getItem('gitcode.reset-mode') || 'mixed')
  const hardConfirmed = ref(false),
    partialConfirmed = ref(false),
    paths = ref<string[]>([])
  const file = ref(''),
    content = ref(''),
    steps = ref<RebaseStep[]>([])
  const sources = ref<{ fullRef: string; oid: string }[]>([]),
    sourceRef = ref('')
  const remote = ref(''),
    destination = ref(''),
    sync = ref<SyncPlan | null>(null)
  const checkoutBranch = ref('')
  let generation = 0
  const stale = computed(
    () =>
      !!origin.value &&
      (origin.value.repo !== repo.repo.path ||
        origin.value.tabId !== repo.activeTabId ||
        origin.value.expectedHead !== repo.repo.head ||
        origin.value.expectedBranch !== repo.repo.branch),
  )
  const title = computed(
    () =>
      ({
        reset: '将当前 HEAD 重置到此处',
        cherry: '优选提交',
        revert: '还原提交',
        undo: '撤销提交',
        reword: '编辑提交说明',
        fixup: 'Fixup',
        'squash-into': '压缩到',
        drop: '删除提交',
        squash: '压缩提交',
        interactive: '从这里进行交互式变基',
        browse: '在修订版中显示仓库',
        patch: '创建补丁',
        browser: '在浏览器中查看',
        push: '推送此前所有提交',
        checkout: '检出修订',
      })[mode.value],
  )
  const writing = computed(() => !['browse', 'patch', 'browser'].includes(mode.value))
  function request(
    kind: CommitOperationRequest['kind'],
    extra: Partial<CommitOperationRequest> = {},
  ): CommitOperationRequest {
    return { ...origin.value!, kind, oids: commits.value.map((c) => c.hash), ...extra }
  }
  function close() {
    if (repo.busy) return
    generation++
    if (repo.modal === 'commit-operation') repo.modal = null
    data.value = null
    error.value = ''
  }
  async function readPush(publish = false) {
    if (!origin.value || stale.value) return
    const version = generation
    const oid = commits.value[0].hash
    sync.value = null
    const source = sources.value.find((s) => s.fullRef === sourceRef.value)
    const result = await desktop.syncPlan(origin.value.repo, 'push', {
      ...origin.value,
      commitOid: commits.value[0].hash,
      ...(source ? { sourceRef: source.fullRef, sourceOid: source.oid } : { detachedSource: true }),
      ...(publish || !source
        ? {
            publish: {
              remote: remote.value || repo.repo.remotes?.[0] || 'origin',
              branch: destination.value || `commit-${commits.value[0].hash.slice(0, 7)}`,
            },
          }
        : {}),
    })
    if (version !== generation) return
    if (result.head !== oid) throw Error('推送源末端与选中提交不一致，请重启本地 Git 服务。')
    sync.value = result
    if (stale.value) {
      sync.value = null
      throw Error('仓库已变化，请重新打开菜单。')
    }
    remote.value = sync.value.remotes[0]?.name || remote.value
    destination.value = sync.value.destinationRef.replace(/^refs\/heads\//, '')
  }
  async function open(nextMode: Mode, selection: Commit[], intent = repo.captureOperation()) {
    if (repo.busy || repo.modal) return
    const version = ++generation
    mode.value = nextMode
    commits.value = JSON.parse(JSON.stringify(selection)) as Commit[]
    origin.value = { ...intent }
    data.value = null
    error.value = ''
    message.value = ''
    file.value = ''
    content.value = ''
    hardConfirmed.value = false
    partialConfirmed.value = false
    paths.value = []
    steps.value = []
    sync.value = null
    checkoutBranch.value = ''
    repo.modal = 'commit-operation'
    loading.value = true
    try {
      if (nextMode === 'checkout') {
        data.value = {}
        return
      }
      if (nextMode === 'push') {
        const value = await desktop.commitOperationRead(intent.repo, request('push-sources'))
        if (version !== generation || stale.value) return
        sources.value = value.sources || []
        sourceRef.value =
          sources.value.find((s) => s.fullRef === `refs/heads/${repo.repo.branch}`)?.fullRef ||
          sources.value[0]?.fullRef ||
          ''
        remote.value = repo.repo.remotes?.[0] || 'origin'
        destination.value =
          sourceRef.value.replace(/^refs\/heads\//, '') || `commit-${selection[0].hash.slice(0, 7)}`
        await readPush()
        data.value = {}
        return
      }
      const kind =
        nextMode === 'browser'
          ? 'hosting'
          : nextMode === 'browse' || nextMode === 'patch'
            ? nextMode
            : 'plan'
      const value = await desktop.commitOperationRead(
        intent.repo,
        request(kind, kind === 'plan' ? { operation: nextMode as CommitOperation } : {}),
      )
      if (version !== generation || stale.value) return
      if (
        kind === 'plan' &&
        (!value.id ||
          value.head !== intent.expectedHead ||
          (value.branch || 'detached HEAD') !== intent.expectedBranch ||
          value.commits?.length !== selection.length ||
          selection.some((c) => !value.commits?.some((s) => s.sha === c.hash)))
      )
        throw Error('提交操作计划与当前上下文不一致，请关闭后重新打开。')
      data.value = value
      content.value = value.content || ''
      if (value.commits) {
        message.value =
          nextMode === 'fixup'
            ? `fixup! ${selection[0].subject}`
            : nextMode === 'squash-into'
              ? `squash! ${selection[0].subject}`
              : nextMode === 'squash'
                ? value.commits.map((c) => c.message).join('\n\n')
                : value.commits[0].message
        paths.value = [
          ...new Set((value.files || []).filter((f) => f.status !== '?').map((f) => f.path)),
        ]
        steps.value = value.rebase?.steps.map((s) => ({ ...s })) || []
      }
      if (nextMode === 'browser' && !value.urls?.length)
        error.value = '未识别出支持的托管平台地址；目前支持 GitHub、GitLab 和 Bitbucket。'
    } catch (failure) {
      if (version === generation) error.value = (failure as Error).message
    } finally {
      if (version === generation) loading.value = false
    }
  }
  async function selectFile(path: string) {
    if (!origin.value || loading.value || stale.value) return
    const version = generation
    file.value = path
    content.value = ''
    error.value = ''
    loading.value = true
    try {
      const result = await desktop.commitOperationRead(
        origin.value.repo,
        request('blob', { file: path }),
      )
      if (version === generation && !stale.value) content.value = result.content || ''
    } catch (failure) {
      if (version === generation) error.value = (failure as Error).message
    } finally {
      if (version === generation) loading.value = false
    }
  }
  function savePatch() {
    if (!content.value || stale.value) return
    const url = URL.createObjectURL(new Blob([content.value], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `commits-${commits.value[0].hash.slice(0, 7)}.patch`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function openBrowser(remoteName: string) {
    if (!origin.value || stale.value || loading.value) return
    try {
      await desktop.openCommit(origin.value.repo, request('hosting'), remoteName)
    } catch (failure) {
      error.value = (failure as Error).message
    }
  }
  async function refreshPush() {
    if (repo.busy || loading.value) return
    loading.value = true
    error.value = ''
    try {
      await readPush(!!sync.value?.publish)
    } catch (failure) {
      error.value = (failure as Error).message
    } finally {
      loading.value = false
    }
  }
  async function submit() {
    if (!origin.value || stale.value || repo.busy || loading.value) return
    const intent = { ...origin.value }
    let ok = false
    if (mode.value === 'checkout')
      ok = checkoutBranch.value
        ? await repo.run(
            'checkout',
            { name: checkoutBranch.value, expectedOid: commits.value[0].hash },
            intent,
          )
        : await repo.run('checkout-revision', { oid: commits.value[0].hash }, intent)
    else if (mode.value === 'push' && sync.value)
      ok = await repo.run('push', { planId: sync.value.id }, intent)
    else if (data.value?.id) {
      if (mode.value === 'reset') localStorage.setItem('gitcode.reset-mode', resetMode.value)
      ok = await repo.run(
        'commit-operation',
        {
          planId: data.value.id,
          confirm: true,
          mode: resetMode.value,
          confirmHard: hardConfirmed.value,
          confirmPartial: partialConfirmed.value,
          message: message.value,
          paths: paths.value,
          ...(mode.value === 'interactive' ? { steps: steps.value } : {}),
        },
        intent,
      )
    }
    if (ok || repo.lastActionResult?.outcome === 'partial') {
      close()
      if (repo.repo.merge) {
        repo.clearSelection()
        useMergeStore().open()
      } else if (mode.value !== 'push') {
        repo.clearSelection()
        if (
          [
            'reword',
            'fixup',
            'squash-into',
            'drop',
            'squash',
            'interactive',
            'cherry',
            'revert',
          ].includes(mode.value)
        ) {
          const head = repo.repo.commits.find((c) => c.hash === repo.repo.head)
          if (head) await repo.selectCommit(head)
        }
      }
    } else {
      error.value = repo.lastActionResult?.error || '操作未完成，请核对状态后重新读取计划。'
      data.value = null
      sync.value = null
    }
  }
  watch(
    () => [repo.activeTabId, repo.repo.path],
    () => {
      generation++
      data.value = null
      sync.value = null
      loading.value = false
    },
  )
  return {
    mode,
    commits,
    origin,
    data,
    loading,
    error,
    message,
    resetMode,
    hardConfirmed,
    partialConfirmed,
    paths,
    file,
    content,
    steps,
    sources,
    sourceRef,
    remote,
    destination,
    sync,
    checkoutBranch,
    title,
    writing,
    stale,
    open,
    close,
    selectFile,
    savePatch,
    submit,
    refreshPush,
    openBrowser,
  }
})
