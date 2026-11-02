import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useRepositoryStore } from './repository'
import { desktop } from '../services/desktop'
import type { MergeFile, MergeState } from '../types'

interface Session {
  file: MergeFile | null
  state: MergeState | null
  draft: string
  editor: boolean
  message: string
  error: string
  resolved: string[]
  operation: string
}
export const useMergeStore = defineStore('merge', () => {
  const repo = useRepositoryStore(),
    sessions = reactive<Record<string, Session>>({}),
    loading = ref(false),
    abortSignature = ref('')
  const key = computed(() => `${repo.activeTabId}\0${repo.repo.path}`)
  const session = computed(
    () =>
      sessions[key.value] ??
      (sessions[key.value] = {
        file: null,
        state: null,
        draft: '',
        editor: false,
        message: '',
        error: '',
        resolved: [],
        operation: '',
      }),
  )
  const state = computed(() => repo.repo.merge),
    dirty = computed(
      () => !!session.value.file && session.value.draft !== (session.value.file.working || ''),
    )
  const stale = computed(
    () => !!session.value.file && session.value.state?.signature !== state.value?.signature,
  )
  let readVersion = 0,
    announced = ''
  watch(
    () =>
      Object.entries(sessions)
        .filter(([, s]) => s.file && s.draft !== (s.file.working || ''))
        .map(([id]) => Number(id.split('\0')[0])),
    (ids) => {
      repo.mergeDraftTabs = new Set(ids)
    },
    { deep: true },
  )
  watch(
    [key, () => state.value?.incoming, () => state.value?.files.length, () => repo.busy],
    () => {
      if (repo.busy || repo.isNewTab) return
      const operation = state.value ? `${state.value.head}\0${state.value.incoming}` : ''
      if (operation && operation !== session.value.operation && !dirty.value) {
        session.value.message = state.value!.message
        session.value.resolved = []
        session.value.file = null
        session.value.editor = false
        session.value.operation = operation
      }
      const id = state.value
        ? `${key.value}\0${state.value.incoming}\0${state.value.files.map((f) => f.path).join('\0')}`
        : ''
      if (
        state.value &&
        (state.value.active || state.value.files.length) &&
        !state.value.unsupported &&
        id !== announced
      ) {
        announced = id
        if (!repo.modal || repo.modal === 'pull' || repo.modal === 'push') open()
      }
      if (!state.value) {
        announced = ''
        if (repo.modal === 'merge-conflicts') repo.modal = null
        if (!dirty.value) {
          session.value.editor = false
          session.value.file = null
        }
      }
    },
    { immediate: true },
  )
  watch(key, () => {
    readVersion++
    loading.value = false
    abortSignature.value = ''
  })
  watch(
    () => repo.tabs.map((tab) => tab.id),
    (ids) => {
      for (const id of Object.keys(sessions))
        if (!ids.includes(Number(id.split('\0')[0]))) delete sessions[id]
    },
  )
  function open() {
    if (repo.busy) return
    if (!state.value) {
      repo.modal = null
      session.value.editor = !!session.value.file
      return
    }
    repo.clearSelection()
    if (!session.value.message && state.value?.active) session.value.message = state.value.message
    repo.modal = 'merge-conflicts'
    abortSignature.value = ''
  }
  function close() {
    if (repo.busy) return
    repo.modal = null
    abortSignature.value = ''
  }
  async function openFile(file: string, discard = false) {
    if (repo.busy || loading.value) return
    const s = session.value
    if (s.file?.path === file && !discard) {
      s.editor = true
      repo.modal = null
      return
    }
    if (dirty.value && !discard) {
      s.error = '当前文件有未保存的结果。请先保存，或放弃草稿后重新读取。'
      return
    }
    const intent = repo.captureOperation(),
      origin = key.value,
      version = ++readVersion
    loading.value = true
    s.error = ''
    try {
      const result = await desktop.mergeRead(intent.repo, file)
      if (version !== readVersion || origin !== key.value) return
      if (!result.file || !result.state) throw new Error('冲突文件已变化，请刷新。')
      s.file = result.file
      s.state = result.state
      s.draft = result.file.working || ''
      s.editor = true
      repo.clearSelection()
      repo.modal = null
    } catch (error) {
      if (origin === key.value) s.error = (error as Error).message
    } finally {
      if (version === readVersion) loading.value = false
    }
  }
  async function resolve(choice: 'ours' | 'theirs' | 'manual') {
    const s = session.value,
      file = s.file
    if (!file || !s.state || repo.busy || loading.value) return
    s.error = ''
    const origin = key.value
    const content = file.working?.includes('\r\n') ? s.draft.replace(/\r?\n/g, '\r\n') : s.draft
    const ok = await repo.run(
      'merge-resolve',
      { mergeSignature: s.state.signature, file: file.path, token: file.token, choice, content },
      {
        repo: repo.repo.path,
        tabId: repo.activeTabId,
        expectedHead: s.state.head,
        expectedBranch: s.state.branch,
      },
    )
    if (origin !== key.value) return
    if (ok) {
      s.resolved.push(file.path)
      s.file = null
      s.draft = ''
      s.editor = false
      if (state.value) open()
      else if (!s.state?.active) repo.notify('恢复冲突已处理，修改保留在工作区；贮藏记录未删除。')
    } else
      s.error =
        repo.lastActionResult?.error || '未能完成文件处理，请核对状态后重新读取；当前草稿已保留。'
  }
  async function finish() {
    if (!state.value || repo.busy) return
    session.value.error = ''
    if (dirty.value) {
      session.value.error = '请先保存或放弃当前文件草稿。'
      return
    }
    const origin = key.value
    const ok = await repo.run('merge-finish', {
      mergeSignature: state.value.signature,
      message: session.value.message,
    })
    if (origin === key.value && !ok)
      session.value.error =
        repo.lastActionResult?.error ||
        (repo.repo.gitflow?.finish && repo.repo.merge ? '' : '合并未完成，请检查仓库状态。')
  }
  function requestAbort() {
    if (dirty.value) {
      session.value.error = '请先保存或放弃当前文件草稿，再中止合并。'
      return
    }
    abortSignature.value = state.value?.signature || ''
  }
  async function abort() {
    if (!abortSignature.value || repo.busy) return
    const origin = key.value
    const ok = await repo.run('merge-abort', { mergeSignature: abortSignature.value })
    if (origin === key.value) {
      abortSignature.value = ''
      if (!ok) session.value.error = repo.lastActionResult?.error || '中止未完成，请检查仓库。'
    }
  }
  function dismissEditor() {
    if (repo.busy) return
    session.value.editor = false
    if (state.value) open()
    else repo.modal = null
  }
  function discard() {
    session.value.file = null
    session.value.draft = ''
    session.value.editor = false
    session.value.error = ''
  }
  return {
    state,
    session,
    loading,
    dirty,
    stale,
    abortSignature,
    open,
    close,
    openFile,
    resolve,
    finish,
    requestAbort,
    abort,
    dismissEditor,
    discard,
  }
})
