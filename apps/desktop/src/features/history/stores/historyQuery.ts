import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { desktop } from '../../../infrastructure/desktop'
import type { Commit } from '../../../shared/contracts'
export const useHistoryQueryStore = defineStore('history-query', () => {
  const scope = ref('')
  const states = reactive<
    Record<string, { author: string; since: string; until: string; path: string }>
  >({})
  const filters = computed(
    () =>
      states[scope.value] || (states[scope.value] = { author: '', since: '', until: '', path: '' }),
  )
  const commits = ref<Commit[]>([]),
    loading = ref(false),
    error = ref(''),
    nextOffset = ref<number | null>(null)
  const enabled = ref(false)
  let generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined
  const readScope = `history-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let request = { repo: '', token: '', query: '', branch: '' }
  function configure(key: string, value: typeof request, active: boolean) {
    if (loading.value && request.repo)
      void desktop.historyTools(request.repo, { kind: 'cancel', scope: readScope }).catch(() => {})
    const changedScope = scope.value !== key
    scope.value = key
    request = value
    enabled.value = active
    ++generation
    clearTimeout(timer)
    if (changedScope || !active) {
      commits.value = []
      nextOffset.value = null
      error.value = ''
    }
    loading.value = active
    if (active) timer = setTimeout(() => void read(false), 250)
  }
  async function read(more = false) {
    clearTimeout(timer)
    const current = ++generation
    const key = scope.value
    loading.value = true
    error.value = ''
    try {
      const result = await desktop.historyTools(request.repo, {
        kind: 'query',
        scope: readScope,
        ...request,
        ...filters.value,
        offset: more ? nextOffset.value || 0 : 0,
      })
      if (generation !== current || key !== scope.value) return
      commits.value = more ? [...commits.value, ...(result.commits || [])] : result.commits || []
      nextOffset.value = result.nextOffset ?? null
    } catch (e) {
      if (generation === current) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (generation === current) loading.value = false
    }
  }
  function clear() {
    Object.assign(filters.value, { author: '', since: '', until: '', path: '' })
  }
  return { scope, filters, commits, loading, error, nextOffset, enabled, configure, read, clear }
})
