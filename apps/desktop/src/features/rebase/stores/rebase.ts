import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from '../../repository/stores/repository'
import { useMergeStore } from '../../merge/stores/merge'
import { desktop } from '../../../infrastructure/desktop'
import { branchReference } from '../../../shared/lib/references'
import type { Branch, Commit, RebasePlan, RebaseStep } from '../../../shared/contracts'

export const useRebaseStore = defineStore('rebase', () => {
  const repo = useRepositoryStore()
  const target = ref<Branch | null>(null),
    plan = ref<RebasePlan | null>(null)
  const intent = ref<ReturnType<typeof repo.captureOperation> | null>(null)
  const steps = ref<RebaseStep[]>([]),
    loading = ref(false),
    error = ref(''),
    selected = ref('')
  const active = computed(() => repo.rebasePlanning && !!plan.value)
  const previewMessage = computed(() => {
    let index = steps.value.findIndex((step) => step.sha === selected.value)
    if (index < 0) return ''
    if (steps.value[index].type === 'drop') return steps.value[index].message
    if (steps.value[index]?.type === 'squash') {
      while (index > 0 && ['squash', 'drop'].includes(steps.value[index].type)) index--
    }
    const messages = [steps.value[index].message]
    for (const step of steps.value.slice(index + 1)) {
      if (step.type === 'drop') continue
      if (step.type !== 'squash') break
      messages.push(step.message)
    }
    return messages.join('\n\n')
  })
  const stale = computed(
    () =>
      !!intent.value &&
      (repo.repo.path !== intent.value.repo ||
        repo.activeTabId !== intent.value.tabId ||
        repo.repo.head !== intent.value.expectedHead ||
        repo.repo.branch !== intent.value.expectedBranch),
  )
  let version = 0
  function commitFor(step: RebaseStep): Commit {
    return (
      repo.repo.commits.find((commit) => commit.hash === step.sha) || {
        hash: step.sha,
        parents: step.parents,
        subject: step.subject,
        author: step.author,
        email: step.email,
        date: step.date,
        refs: [],
      }
    )
  }
  function reset() {
    steps.value = plan.value?.steps.map((step) => ({ ...step })) || []
    error.value = ''
  }
  function cancel() {
    if (repo.busy) return
    version++
    repo.rebasePlanning = false
    target.value = null
    plan.value = null
    steps.value = []
    error.value = ''
  }
  async function start(interactive = true) {
    if (repo.busy || loading.value || !plan.value || !target.value || !intent.value || stale.value)
      return
    error.value = ''
    const origin = { ...intent.value }
    const ok = await repo.run(
      'rebase-start',
      {
        fullRef: branchReference(target.value),
        expectedOid: target.value.hash,
        planSignature: plan.value.signature,
        ...(interactive ? { steps: steps.value } : {}),
      },
      origin,
    )
    if (ok || repo.repo.merge?.rebase || repo.lastActionResult?.outcome === 'partial') cancel()
    else error.value = repo.lastActionResult?.error || '变基未开始，请重新读取目标后再试。'
  }
  async function open(branch: Branch, interactive: boolean, origin = repo.captureOperation()) {
    if (repo.busy || repo.modal || loading.value || repo.rebasePlanning) return
    if (repo.repo.merge || repo.gitflowPanel || useMergeStore().dirty) {
      repo.notify('请先完成当前操作或保存冲突处理草稿，再开始变基。', true)
      return
    }
    const attempt = ++version
    intent.value = { ...origin }
    target.value = { ...branch }
    loading.value = true
    error.value = ''
    try {
      const value = await desktop.navigationRead(origin.repo, {
        ...origin,
        kind: 'rebase',
        fullRef: branchReference(branch),
        expectedOid: branch.hash,
      })
      if (attempt !== version || stale.value) return
      if (!value.rebase) throw new Error('本地 Git 服务尚未支持变基，请重启服务或桌面应用。')
      if (interactive && !value.rebase.canInteractive) throw new Error(value.rebase.reason)
      plan.value = value.rebase
      reset()
      if (interactive) {
        repo.rebasePlanning = true
        selected.value = steps.value[0]?.sha || ''
        if (steps.value[0]) await repo.selectCommit(commitFor(steps.value[0]))
      }
    } catch (failure) {
      repo.notify((failure as Error).message, true)
      plan.value = null
    } finally {
      if (attempt === version) loading.value = false
    }
    if (!interactive && attempt === version && plan.value && !stale.value) await start(false)
  }
  async function reload() {
    if (!target.value || !intent.value || repo.busy) return
    const branch = { ...target.value },
      origin = repo.captureOperation()
    cancel()
    await open(branch, true, origin)
  }
  function canSquash(index: number) {
    return steps.value.slice(0, index).some((s) => s.type !== 'drop')
  }
  function normalize() {
    const first = steps.value.find((s) => s.type !== 'drop')
    if (first?.type === 'squash') first.type = 'pick'
  }
  function move(index: number, offset: number) {
    const destination = index + offset
    if (repo.busy || destination < 0 || destination >= steps.value.length) return
    const [step] = steps.value.splice(index, 1)
    steps.value.splice(destination, 0, step)
    normalize()
  }
  async function select(step: RebaseStep) {
    selected.value = step.sha
    await repo.selectCommit(commitFor(step))
  }
  async function perform(action: 'rebase-continue' | 'rebase-skip' | 'rebase-abort') {
    const state = repo.repo.merge
    if (!state?.rebase || repo.busy) return
    if (useMergeStore().dirty) {
      repo.notify('请先保存或放弃当前冲突处理草稿。', true)
      return
    }
    await repo.run(action, { mergeSignature: state.signature, confirm: action === 'rebase-skip' })
  }
  watch([() => repo.activeTabId, () => repo.repo.path], () => {
    if (!repo.busy) cancel()
  })
  return {
    previewMessage,
    active,
    target,
    plan,
    steps,
    loading,
    error,
    selected,
    stale,
    open,
    start,
    cancel,
    reset,
    reload,
    move,
    select,
    canSquash,
    normalize,
    perform,
  }
})
