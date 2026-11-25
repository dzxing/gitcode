import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { desktop } from '../../../infrastructure/desktop'
import type { Commit, HistoryToolRequest, HistoryToolResult } from '../../../shared/contracts'

type Revision = Commit & { path?: string; oldPath?: string }
interface FileTab {
  key: string
  repo: string
  tabId: number
  kind: 'file' | 'three'
  path: string
  revision: string
  rows: Revision[]
  nextOffset: number | null
  selected: string[]
  diff: string
  versions: NonNullable<HistoryToolResult['versions']>
  loading: boolean
  error: string
  generation: number
  stale: boolean
  preview: 'revision' | 'pair' | 'local'
}
export const useHistoryToolsStore = defineStore('history-tools', () => {
  const tabs = reactive<FileTab[]>([])
  const active = ref('')
  const savedActive = new Map<string, string>()
  const context = reactive({ repo: '', tabId: 0 })
  function setContext(repo: string, tabId: number) {
    if (context.repo !== repo || context.tabId !== tabId) {
      savedActive.set(`${context.tabId}:${context.repo}`, active.value)
      const saved = savedActive.get(`${tabId}:${repo}`) || ''
      active.value = tabs.some((t) => t.key === saved) ? saved : ''
    }
    Object.assign(context, { repo, tabId })
  }
  function close(key: string) {
    const index = tabs.findIndex((t) => t.key === key)
    if (index >= 0) {
      tabs[index].generation++
      tabs.splice(index, 1)
    }
    if (active.value === key) active.value = ''
  }
  function valid(tab: FileTab, generation: number) {
    return tabs.some((t) => t.key === tab.key) && tab.generation === generation
  }
  async function load(tab: FileTab, more = false) {
    const generation = ++tab.generation
    tab.loading = true
    tab.error = ''
    tab.stale = false
    try {
      const data = await desktop.historyTools(tab.repo, {
        kind: tab.kind,
        path: tab.path,
        revision: tab.revision,
        offset: more ? tab.nextOffset || 0 : 0,
      })
      if (!valid(tab, generation)) return
      if (tab.kind === 'three') tab.versions = data.versions || []
      else {
        tab.rows = more ? [...tab.rows, ...(data.commits || [])] : data.commits || []
        tab.nextOffset = data.nextOffset ?? null
        if (!more) {
          tab.selected = []
          tab.diff = ''
          if (tab.rows[0]) await select(tab, tab.rows[0])
        }
      }
    } catch (e) {
      if (valid(tab, generation)) tab.error = String(e instanceof Error ? e.message : e)
    } finally {
      if (valid(tab, generation)) tab.loading = false
    }
  }
  function open(kind: 'file' | 'three', path: string, revision: string) {
    const key = JSON.stringify([
      context.repo,
      context.tabId,
      kind,
      path,
      kind === 'file' ? revision : '',
    ])
    let tab = tabs.find((t) => t.key === key)
    if (!tab) {
      tabs.push({
        key,
        ...context,
        kind,
        path,
        revision,
        rows: [],
        nextOffset: null,
        selected: [],
        diff: '',
        versions: [],
        loading: false,
        error: '',
        generation: 0,
        stale: false,
        preview: 'revision',
      })
      tab = tabs[tabs.length - 1]!
      void load(tab)
    }
    active.value = key
  }
  async function select(tab: FileTab, row: Revision, compare = false) {
    tab.selected =
      compare && tab.selected.length === 1 && tab.selected[0] !== row.hash
        ? [tab.selected[0], row.hash]
        : [row.hash]
    tab.preview = tab.selected.length === 2 ? 'pair' : 'revision'
    const selection = tab.selected.join(':')
    const generation = tab.generation
    tab.loading = true
    tab.error = ''
    const ordered = tab.rows.filter((r) => tab.selected.includes(r.hash))
    const newer = ordered[0],
      older = ordered[1]
    const request: HistoryToolRequest = {
      kind: 'diff',
      revision: newer.hash,
      path: newer.path || tab.path,
      oldPath: older?.path || newer.oldPath,
      base: older?.hash,
    }
    try {
      const result = await desktop.historyTools(tab.repo, request)
      if (valid(tab, generation) && selection === tab.selected.join(':'))
        tab.diff = result.diff || ''
    } catch (e) {
      if (valid(tab, generation) && selection === tab.selected.join(':'))
        tab.error = String(e instanceof Error ? e.message : e)
    } finally {
      if (valid(tab, generation) && selection === tab.selected.join(':')) tab.loading = false
    }
  }
  async function compareLocal(path: string, currentPath: string, revision: string) {
    const tab = tabs.find((t) => t.key === active.value)
    if (!tab) return
    const generation = ++tab.generation
    tab.loading = true
    tab.error = ''
    tab.preview = 'local'
    try {
      const result = await desktop.historyTools(tab.repo, {
        kind: 'diff',
        path: currentPath,
        oldPath: path,
        revision,
        local: true,
      })
      if (valid(tab, generation)) tab.diff = result.diff || '与本地版本相同。'
    } catch (e) {
      if (valid(tab, generation)) tab.error = e instanceof Error ? e.message : String(e)
    } finally {
      if (valid(tab, generation)) tab.loading = false
    }
  }
  function markStale() {
    for (const tab of tabs)
      if (tab.repo === context.repo && tab.kind === 'three' && tab.versions.length) tab.stale = true
  }
  return { markStale, compareLocal, tabs, active, context, setContext, close, open, load, select }
})
