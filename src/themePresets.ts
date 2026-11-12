import presets from '../electron/theme-presets.json'

export const themePresets = presets
export type ThemePalette = keyof typeof presets
export type ThemeSource = 'dark' | 'light' | 'system'
export type ThemePreference = ThemePalette | 'system'
export const featuredThemes: ThemePalette[] = [
  'vscode-dark',
  'idea-dark',
  'github-dark',
  'github-light',
]
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (value === 'system' || Object.hasOwn(presets, value))
}
export const themeTokenNames = [
  ...new Set(Object.values(presets).flatMap((preset) => Object.keys(preset.tokens))),
]
