import { defineStore } from 'pinia'
import { onScopeDispose, ref, watchEffect } from 'vue'
import { fontDefaults, fontStack, normalizeFonts, type FontPreferences } from '../fontPreferences'

const key = 'gitcode.fonts'
export const useFontStore = defineStore('fonts', () => {
  const settings = ref(normalizeFonts(null))
  const warning = ref('')
  try {
    const saved = localStorage.getItem(key)
    if (saved) settings.value = normalizeFonts(JSON.parse(saved))
  } catch {
    /* Defaults remain usable when settings are unreadable. */
  }
  watchEffect(
    () => {
      if (typeof document === 'undefined') return
      const style = document.documentElement.style,
        value = settings.value
      // Defaults and custom choices share the same platform-aware font stacks.
      style.setProperty('--font-ui-default', fontStack(fontDefaults.ui))
      style.setProperty('--font-code-default', fontStack(fontDefaults.code, true))
      style.setProperty('--font-mono-default', fontStack(fontDefaults.ui, true))
      for (const name of [
        '--font-ui',
        '--font-ui-custom',
        '--mono',
        '--ui-font-delta',
        '--font-code',
        '--code-font-size',
        '--code-line-height',
        '--code-ligatures',
      ])
        style.removeProperty(name)
      if (value.ui.enabled) {
        style.setProperty('--font-ui', fontStack(value.ui))
        style.setProperty('--font-ui-custom', fontStack(value.ui))
        style.setProperty('--mono', fontStack(value.ui, true))
        style.setProperty('--ui-font-delta', `${value.ui.size - 13}px`)
      }
      if (value.code.enabled) {
        style.setProperty('--font-code', fontStack(value.code, true))
        style.setProperty('--code-font-size', `${value.code.size}px`)
        style.setProperty('--code-line-height', String(value.code.lineHeight))
        style.setProperty('--code-ligatures', value.code.ligatures ? 'normal' : 'none')
      }
    },
    { flush: 'sync' },
  )
  function set(group: 'ui' | 'code', patch: Partial<FontPreferences['code']>, persist = true) {
    settings.value = normalizeFonts({
      ...settings.value,
      [group]: { ...settings.value[group], ...patch },
    })
    if (!persist) return
    try {
      localStorage.setItem(key, JSON.stringify(settings.value))
      warning.value = ''
    } catch {
      warning.value = '字体设置仅在本次会话生效，未能保存到本机。'
    }
  }
  function reset(group: 'ui' | 'code', persist = true) {
    set(group, { ...fontDefaults[group] }, persist)
  }
  function preview(value: FontPreferences) {
    settings.value = normalizeFonts(value)
  }
  function storage(event: StorageEvent) {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return
    try {
      settings.value = normalizeFonts(event.newValue ? JSON.parse(event.newValue) : null)
    } catch {
      settings.value = normalizeFonts(null)
    }
  }
  if (typeof window !== 'undefined') window.addEventListener?.('storage', storage)
  onScopeDispose(() => {
    if (typeof window !== 'undefined') window.removeEventListener?.('storage', storage)
  })
  return { settings, warning, set, reset, preview }
})
