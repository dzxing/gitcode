import { parseJsonObject } from '../../../infrastructure/json'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type FileViewContext = 'history' | 'worktree'
export type FileViewMode = 'compact' | 'detailed'
const storageKey = 'gitcode.file-list-views'
export const useFileViewStore = defineStore('file-view', () => {
  const modes = ref<Record<FileViewContext, FileViewMode>>({
    history: 'compact',
    worktree: 'compact',
  })
  const warning = ref('')
  try {
    const saved = parseJsonObject(localStorage.getItem(storageKey) || 'null')
    for (const context of ['history', 'worktree'] as const) {
      if (saved?.[context] === 'compact' || saved?.[context] === 'detailed')
        modes.value[context] = saved[context]
    }
  } catch {
    /* Optional display preferences. */
  }
  function setMode(context: FileViewContext, mode: FileViewMode) {
    modes.value = { ...modes.value, [context]: mode }
    try {
      localStorage.setItem(storageKey, JSON.stringify(modes.value))
      warning.value = ''
    } catch {
      warning.value = '文件列表显示方式仅在本次会话保留。'
    }
  }
  return { modes, warning, setMode }
})
