import fontCatalog from './fontCatalog.json' with { type: 'json' }
import { getUIPlatform, type UIPlatform } from './services/platform'

export interface FontChoice {
  enabled: boolean
  family: string
  fallback: string
  size: number
}
export interface FontPreferences {
  ui: FontChoice
  code: FontChoice & { lineHeight: number; ligatures: boolean }
}
export const bundledFonts = [...new Set(fontCatalog.map((font) => font.family))]
export function platformChineseFont(platform: UIPlatform = getUIPlatform()) {
  return platform === 'windows'
    ? 'Microsoft YaHei'
    : platform === 'macos'
      ? 'PingFang SC'
      : 'Noto Sans SC'
}
export const commonSystemFonts =
  getUIPlatform() === 'windows'
    ? ['Microsoft YaHei']
    : getUIPlatform() === 'macos'
      ? ['PingFang SC']
      : []
export function canonicalFontFamily(name: string) {
  const value = name.trim()
  if (value === '微软雅黑' || value.toLowerCase() === 'microsoft yahei') return 'Microsoft YaHei'
  if (value === '苹方-简' || value === '苹方' || value.toLowerCase() === 'pingfang sc')
    return 'PingFang SC'
  return value
}
export function fontDisplayName(name: string) {
  const family = canonicalFontFamily(name)
  return family === 'Microsoft YaHei'
    ? '微软雅黑 · Microsoft YaHei'
    : family === 'PingFang SC'
      ? '苹方 · PingFang SC'
      : name
}
export function getFontDefaults(platform: UIPlatform = getUIPlatform()): FontPreferences {
  const fallback = platformChineseFont(platform)
  return {
    ui: { enabled: false, family: 'Cascadia Mono', fallback, size: 13 },
    code: {
      enabled: false,
      family: 'Cascadia Mono',
      fallback,
      size: 12,
      lineHeight: 1.75,
      ligatures: false,
    },
  }
}
export const fontDefaults = getFontDefaults()
export function validFontFamily(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 120 &&
    /^[\p{L}\p{M}\p{N} ._'()+-]+$/u.test(value)
  )
}
function number(value: unknown, fallback: number, min: number, max: number, integer = false) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value))
    ? value
    : fallback
}
export function normalizeFonts(value: unknown): FontPreferences {
  const input = value && typeof value === 'object' ? (value as Partial<FontPreferences>) : {}
  function choice(
    raw: Partial<FontChoice> | undefined,
    defaults: FontChoice,
    min: number,
    max: number,
  ): FontChoice {
    return {
      enabled: raw?.enabled === true,
      family: validFontFamily(raw?.family) ? raw.family.trim() : defaults.family,
      fallback: validFontFamily(raw?.fallback) ? raw.fallback.trim() : defaults.fallback,
      size: number(raw?.size, defaults.size, min, max, true),
    }
  }
  return {
    ui: choice(input.ui, fontDefaults.ui, 11, 16),
    code: {
      ...choice(input.code, fontDefaults.code, 10, 24),
      lineHeight: number(input.code?.lineHeight, fontDefaults.code.lineHeight, 1.2, 2.2),
      ligatures: input.code?.ligatures === true,
    },
  }
}
export function fontStack(
  choice: Pick<FontChoice, 'family' | 'fallback'>,
  code = false,
  platform: UIPlatform = getUIPlatform(),
) {
  return (
    [...new Set([choice.family, choice.fallback, platformChineseFont(platform), 'Noto Sans SC'])]
      .map((name) => JSON.stringify(name))
      .join(', ') + (code ? ', monospace' : ', system-ui, sans-serif')
  )
}
