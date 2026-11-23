import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watchEffect } from 'vue'

import {
  isThemePreference,
  themePresets,
  themeTokenNames,
  type ThemePreference,
  type ThemePalette,
  type ThemeSource,
} from '../themePresets'
export type { ThemePreference } from '../themePresets'
const key = 'gitcode.theme'

export const useAppearanceStore = defineStore('appearance', () => {
  const theme = ref<ThemePreference>('dark')
  const warning = ref('')
  try {
    const saved = localStorage.getItem(key)
    if (isThemePreference(saved)) theme.value = saved
  } catch {
    /* Appearance still works when storage is unavailable. */
  }
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  const systemDark = ref(media?.matches ?? true)
  const palette = computed<ThemePalette>(() =>
    theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value,
  )
  const resolvedTheme = computed<'dark' | 'light'>(() =>
    themePresets[palette.value].mode === 'light' ? 'light' : 'dark',
  )
  const themeSource = computed<ThemeSource>(() =>
    theme.value === 'system' ? 'system' : resolvedTheme.value,
  )
  const updateSystem = () => {
    systemDark.value = media?.matches ?? true
  }
  const updateStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === key || event.key === null))
      theme.value = isThemePreference(event.newValue) ? event.newValue : 'dark'
  }
  media?.addEventListener('change', updateSystem)
  if (typeof window !== 'undefined') window.addEventListener?.('storage', updateStorage)
  onScopeDispose(() => {
    media?.removeEventListener('change', updateSystem)
    if (typeof window !== 'undefined') window.removeEventListener?.('storage', updateStorage)
  })
  watchEffect(
    () => {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      root.dataset.palette = palette.value
      for (const token of themeTokenNames) root.style.removeProperty(token)
      for (const [token, value] of Object.entries(themePresets[palette.value].tokens))
        root.style.setProperty(token, value)
      document.documentElement.dataset.theme = resolvedTheme.value
      document.documentElement.style.colorScheme = resolvedTheme.value
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', themePresets[palette.value].tokens['--bg'])
    },
    { flush: 'sync' },
  )
  function setTheme(value: ThemePreference) {
    if (!isThemePreference(value)) return
    theme.value = value
    try {
      localStorage.setItem(key, value)
      warning.value = ''
    } catch {
      warning.value = '主题仅在本次会话保留，未能保存到本机。'
    }
  }
  function previewTheme(value: ThemePreference) {
    if (isThemePreference(value)) theme.value = value
  }
  return { theme, palette, themeSource, resolvedTheme, setTheme, previewTheme, warning }
})
