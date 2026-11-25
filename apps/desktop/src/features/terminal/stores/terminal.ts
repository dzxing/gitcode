import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { desktop } from '../../../infrastructure/desktop'
import { useRepositoryStore } from '../../repository/stores/repository'
import type { TerminalShell } from '../../../shared/contracts/terminalTypes'

export interface TerminalSession {
  id: string
  number: number
  repo: string
  tabId: number
  shell: string
  state: 'running' | 'exited'
  exitCode: number | null
  error: string
}
export const useTerminalStore = defineStore('terminal', () => {
  const repository = useRepositoryStore()
  const sessions = ref<TerminalSession[]>([])
  const tools = ref<Record<string, 'terminal' | 'console'>>({})
  const numbers = new Map<string, number>()
  const shown = ref(new Set<string>())
  const selected = ref<Record<string, string>>({})
  const creating = ref(false)
  const error = ref('')
  const shells = ref<TerminalShell[]>([])
  const focusVersion = ref(0)
  const focusShell = ref(true)
  const key = computed(() => `${repository.activeTabId}\0${repository.repo.path}`)
  const tool = computed({
    get: () => tools.value[key.value] || 'console',
    set: (value: 'terminal' | 'console') => {
      tools.value[key.value] = value
    },
  })
  const available = computed(
    () =>
      repository.connected &&
      !repository.isNewTab &&
      !!repository.repo.path &&
      !repository.starting,
  )
  const current = computed(() =>
    sessions.value.filter(
      (s) => s.tabId === repository.activeTabId && s.repo === repository.repo.path,
    ),
  )
  const active = computed(
    () => current.value.find((s) => s.id === selected.value[key.value]) || current.value.at(-1),
  )
  const visible = computed(() => available.value && shown.value.has(key.value))
  const running = computed(() => sessions.value.filter((s) => s.state === 'running').length)
  let shellVersion = 0
  watch(
    [key, available],
    async () => {
      const version = ++shellVersion
      shells.value = []
      error.value = ''
      if (!available.value) return
      try {
        const reply = await desktop.terminal(repository.repo.path, { action: 'shells' })
        if (version === shellVersion) shells.value = reply?.shells || []
      } catch {
        /* Opening a terminal reports any unavailable service in its panel. */
      }
    },
    { immediate: true },
  )
  async function create(shellId = '') {
    if (!available.value || creating.value) return
    const repo = repository.repo.path,
      tabId = repository.activeTabId,
      context = key.value
    shown.value.add(context)
    tool.value = 'terminal'
    focusShell.value = true
    error.value = ''
    creating.value = true
    try {
      const reply = await desktop.terminal(repo, {
        action: 'create',
        tabId,
        cols: 80,
        rows: 24,
        ...(shellId ? { shell: shellId } : {}),
      })
      if (!reply?.id) throw Error('终端服务未返回会话。')
      if (!repository.tabs.some((tab) => tab.id === tabId && tab.path === repo)) {
        await desktop.terminal(repo, { action: 'close', id: reply.id })
        return
      }
      const number = (numbers.get(context) || 0) + 1
      numbers.set(context, number)
      sessions.value.push({
        id: reply.id,
        number,
        repo,
        tabId,
        shell: reply.shell || '终端',
        state: 'running',
        exitCode: null,
        error: '',
      })
      selected.value[context] = reply.id
      if (key.value === context && tool.value === 'terminal') focusVersion.value++
    } catch (reason) {
      if (key.value === context)
        error.value = reason instanceof Error ? reason.message : '无法启动终端。'
    } finally {
      creating.value = false
    }
  }
  async function toggle() {
    if (!available.value) return
    if (visible.value && tool.value === 'terminal') shown.value.delete(key.value)
    else {
      tool.value = 'terminal'
      focusShell.value = true
      shown.value.add(key.value)
      if (!current.value.length) await create()
      focusVersion.value++
    }
  }
  function showConsole() {
    if (!available.value) return
    shown.value.add(key.value)
    tool.value = 'console'
  }
  function hide() {
    shown.value.delete(key.value)
  }
  function select(id: string, focusInput = true) {
    if (!current.value.some((session) => session.id === id)) return
    shown.value.add(key.value)
    tool.value = 'terminal'
    focusShell.value = focusInput
    selected.value[key.value] = id
    focusVersion.value++
  }
  function update(id: string, change: Partial<TerminalSession>) {
    const session = sessions.value.find((s) => s.id === id)
    if (session) Object.assign(session, change)
  }
  async function close(id: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return
    try {
      await desktop.terminal(session.repo, { action: 'close', id })
      const context = `${session.tabId}\0${session.repo}`
      const owned = sessions.value.filter(
        (s) => s.tabId === session.tabId && s.repo === session.repo,
      )
      const index = owned.findIndex((s) => s.id === id)
      const wasSelected = selected.value[context] === id
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (
        wasSelected &&
        repository.tabs.some((tab) => tab.id === session.tabId && tab.path === session.repo)
      ) {
        const replacement = owned[index + 1] || owned[index - 1]
        if (replacement) selected.value[context] = replacement.id
        else {
          delete selected.value[context]
          tools.value[context] = 'console'
        }
        if (key.value === context && tool.value === 'terminal') focusVersion.value++
      }
    } catch (reason) {
      session.error = reason instanceof Error ? reason.message : '无法关闭终端。'
    }
  }
  // Closing a repository tab terminates only sessions owned by that tab.
  watch(
    () => repository.tabs.map((t) => `${t.id}\0${t.path || ''}`),
    (contexts) => {
      const retained = new Set(contexts)
      for (const session of sessions.value)
        if (!retained.has(`${session.tabId}\0${session.repo}`)) void close(session.id)
      for (const context of shown.value) if (!retained.has(context)) shown.value.delete(context)
      for (const context of Object.keys(selected.value))
        if (!retained.has(context)) delete selected.value[context]
      for (const context of Object.keys(tools.value))
        if (!retained.has(context)) delete tools.value[context]
      for (const context of numbers.keys()) if (!retained.has(context)) numbers.delete(context)
    },
  )
  return {
    sessions,
    tool,
    showConsole,
    creating,
    error,
    shells,
    focusVersion,
    focusShell,
    available,
    current,
    active,
    visible,
    running,
    create,
    toggle,
    hide,
    select,
    close,
    update,
  }
})
