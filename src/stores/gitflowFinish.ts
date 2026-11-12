import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from './repository'
import { useMergeStore } from './merge'
import { useGitFlowStore } from './gitflow'
import type { GitFlowType } from '../types'
export const finishLabels = { feature: '完成功能分支', release: '完成发布', hotfix: '完成热修复' }
export const useGitFlowFinishStore = defineStore('gitflow-finish', () => {
  const repo = useRepositoryStore(),
    canChooseBranch = ref(false),
    branch = ref(''),
    deleteBranch = ref(true),
    createTag = ref(false),
    tagName = ref(''),
    tagMessage = ref(''),
    error = ref(''),
    stopSignature = ref('')
  const flow = computed(() => repo.repo.gitflow),
    progress = computed(() => flow.value?.finish)
  const kind = (name: string) => {
    const config = flow.value?.config
    if (!config || [config.production, config.develop].includes(name)) return null
    return (
      (['feature', 'release', 'hotfix'] as GitFlowType[]).find(
        (type) => name.startsWith(config[type]) && name.length > config[type].length,
      ) || null
    )
  }
  const type = computed(() => kind(branch.value)),
    candidates = computed(() =>
      repo.repo.branches.filter((b) => b.kind === 'local' && kind(b.name)),
    )
  const targets = computed(() =>
    !flow.value || !type.value
      ? []
      : type.value === 'feature'
        ? [flow.value.config.develop]
        : [flow.value.config.production, flow.value.config.develop],
  )
  let captured: ReturnType<typeof repo.captureOperation> | null = null,
    capturedSignature = '',
    sourceOid = '',
    targetOids: Record<string, string> = {}
  const blocked = computed(() => {
    if (repo.busy) return '请等待当前操作完成'
    if (repo.isNewTab) return '打开本地仓库后可执行'
    if (!flow.value?.finishSupported) return '请重启开发服务或桌面应用，加载 GitFlow 完成功能'
    if (!flow.value.ready) return '请先配置并初始化 GitFlow'
    if (progress.value) return '已有未完成流程，请先继续或停止后续步骤'
    if (repo.repo.merge) return '请先完成或中止当前合并'
    if (flow.value.operationError) return flow.value.operationError
    if (!type.value || !candidates.value.some((candidate) => candidate.name === branch.value)) {
      return '请选择有效的待完成分支'
    }
    if (createTag.value && (!tagName.value.trim() || !tagMessage.value.trim())) {
      return '请填写标签名称和说明'
    }
    return ''
  })
  function capture() {
    captured = repo.captureOperation()
    capturedSignature = flow.value?.signature || ''
    sourceOid =
      repo.repo.branches.find((b) => b.kind === 'local' && b.name === branch.value)?.hash || ''
    targetOids = Object.fromEntries(
      targets.value.map((name) => [
        name,
        repo.repo.branches.find((b) => b.kind === 'local' && b.name === name)?.hash || '',
      ]),
    )
  }
  function select(name: string) {
    branch.value = name
    const t = kind(name)
    createTag.value = !!t && t !== 'feature'
    tagName.value =
      t && flow.value
        ? (flow.value.config.versionTag || '') + name.slice(flow.value.config[t].length)
        : ''
    tagMessage.value = tagName.value
      ? `${t === 'hotfix' ? 'Hotfix' : 'Release'} ${tagName.value}`
      : ''
    capture()
    error.value = ''
  }
  function open(name?: string) {
    if (repo.busy) return
    canChooseBranch.value = !name
    repo.gitflowPanel = null
    select(name || candidates.value.find((b) => b.current)?.name || candidates.value[0]?.name || '')
    deleteBranch.value = true
    repo.modal = 'gitflow-finish'
  }
  function close() {
    if (!repo.busy) repo.modal = null
  }
  async function reread() {
    if (await repo.refresh()) {
      capture()
      error.value = ''
    }
  }
  async function finish() {
    if (blocked.value || !captured) {
      error.value = blocked.value
      return
    }
    error.value = ''
    const origin = repo.activeTabId
    const ok = await repo.run(
      'gitflow-finish',
      {
        signature: capturedSignature,
        branch: branch.value,
        sourceOid,
        targetOids,
        deleteBranch: deleteBranch.value,
        createTag: createTag.value,
        tagName: tagName.value,
        tagMessage: tagMessage.value,
      },
      captured,
    )
    if (origin !== repo.activeTabId) return
    if (ok && !progress.value && repo.lastActionResult)
      useGitFlowStore().acknowledgeFinish(repo.lastActionResult)
    if (progress.value) {
      repo.modal = null
      repo.gitflowPanel = null
      if (repo.repo.merge) useMergeStore().open()
    } else if (!ok) error.value = repo.lastActionResult?.error || '操作未完成，请刷新后检查'
  }
  async function resume() {
    if (repo.busy || !progress.value?.signature) return
    error.value = ''
    if (useMergeStore().dirty) {
      error.value = '请先保存或放弃尚未保存的冲突处理草稿。'
      return
    }
    const ok = await repo.run('gitflow-finish-continue', {
      finishSignature: progress.value.signature,
    })
    repo.gitflowPanel = null
    if (ok && !progress.value && repo.lastActionResult)
      useGitFlowStore().acknowledgeFinish(repo.lastActionResult)
    if (repo.repo.merge) useMergeStore().open()
    if (!ok) error.value = repo.lastActionResult?.error || ''
  }
  function requestStop() {
    stopSignature.value = progress.value?.signature || ''
  }
  async function stop() {
    if (repo.busy || !stopSignature.value) return
    const ok = await repo.run('gitflow-finish-stop', { finishSignature: stopSignature.value })
    stopSignature.value = ''
    if (!ok) error.value = repo.lastActionResult?.error || '未能停止，请检查状态'
  }
  watch(
    () => repo.activeTabId,
    () => {
      stopSignature.value = ''
      error.value = ''
      if (repo.modal === 'gitflow-finish') repo.modal = null
    },
  )
  return {
    canChooseBranch,
    branch,
    type,
    deleteBranch,
    createTag,
    tagName,
    tagMessage,
    error,
    stopSignature,
    progress,
    candidates,
    targets,
    blocked,
    open,
    close,
    select,
    reread,
    finish,
    resume,
    requestStop,
    stop,
  }
})
