import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Branch } from '../types'
import {
  activeSolo,
  visibleReferenceBranches,
  graphReferenceVisible,
  type GraphVisibility,
} from '../graphVisibility'
import { branchReference } from '../references'
import type { ReferenceLabelStyle } from '../referenceLabels'
const key = 'gitcode.graph-visibility'
export const useGraphViewStore = defineStore('graph-view', () => {
  const preferences = ref<Record<string, GraphVisibility>>({})
  const warning = ref('')
  const labelStyle = ref<ReferenceLabelStyle>('gitkraken')
  try {
    const saved = localStorage.getItem('gitcode.graph-label-style')
    if (saved === 'current' || saved === 'idea' || saved === 'gitkraken') labelStyle.value = saved
  } catch {
    /* Optional preference. */
  }
  function setLabelStyle(value: ReferenceLabelStyle) {
    if (!['current', 'gitkraken', 'idea'].includes(value)) return
    labelStyle.value = value
    try {
      localStorage.setItem('gitcode.graph-label-style', value)
    } catch {
      warning.value = '图谱显示设置仅在本次会话保留。'
    }
  }
  const showLongEdges = ref(false)
  const dimMergeCommits = ref(true)
  const labelsAfterMessage = ref(true)
  try {
    const saved = localStorage.getItem('gitcode.graph-labels-after-message')
    if (saved === 'true' || saved === 'false') labelsAfterMessage.value = saved === 'true'
  } catch {
    /* Optional preference. */
  }
  function toggleLabelsAfterMessage() {
    labelsAfterMessage.value = !labelsAfterMessage.value
    try {
      localStorage.setItem('gitcode.graph-labels-after-message', String(labelsAfterMessage.value))
    } catch {
      warning.value = '图谱显示设置仅在本次会话保留。'
    }
  }
  try {
    dimMergeCommits.value = localStorage.getItem('gitcode.graph-dim-merges') !== 'false'
  } catch {
    /* Optional preference. */
  }
  function toggleMergeCommits() {
    dimMergeCommits.value = !dimMergeCommits.value
    try {
      localStorage.setItem('gitcode.graph-dim-merges', String(dimMergeCommits.value))
    } catch {
      warning.value = '图谱显示设置仅在本次会话保留。'
    }
  }
  try {
    showLongEdges.value = localStorage.getItem('gitcode.graph-long-edges') === 'true'
  } catch {
    /* Optional preference. */
  }
  function toggleLongEdges() {
    showLongEdges.value = !showLongEdges.value
    try {
      localStorage.setItem('gitcode.graph-long-edges', String(showLongEdges.value))
    } catch {
      warning.value = '图谱显示设置仅在本次会话保留。'
    }
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      for (const [path, value] of Object.entries(saved)) {
        if (path === '__proto__' || !value || typeof value !== 'object') continue
        const state = value as Partial<GraphVisibility>
        const clean = (value: unknown) =>
          Array.isArray(value)
            ? [
                ...new Set(
                  value.filter(
                    (ref): ref is string =>
                      typeof ref === 'string' && /^refs\/(heads|remotes|tags)\//.test(ref),
                  ),
                ),
              ]
            : []
        preferences.value[path] = { hidden: clean(state.hidden), solo: clean(state.solo) }
      }
  } catch {
    /* Optional display preferences. */
  }
  const state = (path: string): GraphVisibility =>
    Object.hasOwn(preferences.value, path) ? preferences.value[path] : { hidden: [], solo: [] }
  function set(path: string, next: GraphVisibility) {
    preferences.value = { ...preferences.value, [path]: next }
    try {
      localStorage.setItem(key, JSON.stringify(preferences.value))
      warning.value = ''
    } catch {
      warning.value = '图谱显示设置仅在本次会话保留。'
    }
  }
  const visibleBranches = (path: string, branches: Branch[]) =>
    visibleReferenceBranches(state(path), branches)
  const isVisible = (path: string, branch: Branch, branches: Branch[]) =>
    graphReferenceVisible(state(path), branch, branches)
  const soloActive = (path: string, branches: Branch[]) =>
    activeSolo(state(path), branches).length > 0
  const isSolo = (path: string, branch: Branch) =>
    state(path).solo.includes(branchReference(branch))
  const isHidden = (path: string, branch: Branch) =>
    state(path).hidden.includes(branchReference(branch))
  function toggleHide(path: string, branch: Branch) {
    const current = state(path),
      ref = branchReference(branch)
    set(path, {
      ...current,
      hidden: current.hidden.includes(ref)
        ? current.hidden.filter((item) => item !== ref)
        : [...current.hidden, ref],
    })
  }
  function toggleSolo(path: string, branch: Branch) {
    const current = state(path),
      ref = branchReference(branch)
    set(path, {
      ...current,
      solo: current.solo.includes(ref)
        ? current.solo.filter((item) => item !== ref)
        : [...current.solo, ref],
    })
  }
  function group(path: string, branches: Branch[], hidden: boolean) {
    const current = state(path),
      refs = branches.map(branchReference)
    set(path, {
      ...current,
      hidden: hidden
        ? [...new Set([...current.hidden, ...refs])]
        : current.hidden.filter((ref) => !refs.includes(ref)),
    })
  }
  const reset = (path: string) => set(path, { hidden: [], solo: [] })
  return {
    labelStyle,
    setLabelStyle,
    labelsAfterMessage,
    toggleLabelsAfterMessage,
    showLongEdges,
    toggleLongEdges,
    dimMergeCommits,
    toggleMergeCommits,
    state,
    visibleBranches,
    warning,
    isVisible,
    soloActive,
    isSolo,
    isHidden,
    toggleHide,
    toggleSolo,
    group,
    reset,
  }
})
