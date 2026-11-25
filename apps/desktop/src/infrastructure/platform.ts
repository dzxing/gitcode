import { currentNativeWindow } from './window'

export type UIPlatform = 'windows' | 'macos' | 'linux' | 'unknown'

export function normalizeUIPlatform(value: unknown): UIPlatform {
  if (typeof value !== 'string') return 'unknown'
  if (/^(?:win32|win64|windows)(?:\b|$)/i.test(value)) return 'windows'
  if (/^(?:darwin|macos|macintel|macppc|macintosh)(?:\b|$)/i.test(value)) return 'macos'
  if (/^linux(?:\b|$)/i.test(value)) return 'linux'
  return 'unknown'
}

// UI belongs to the renderer's host. A Git core may run in WSL/Linux while
// this page is displayed by Windows/macOS; its runtime.platform is unrelated.
export function getUIPlatform(): UIPlatform {
  const native = currentNativeWindow()
  const platform = normalizeUIPlatform(native?.platform)
  if (platform !== 'unknown') return platform
  // Compatibility with older preload bridges that only expose this capability.
  if (native?.nativeControls === true) return 'windows'
  if (typeof navigator === 'undefined') return 'unknown'
  const browser = navigator as Navigator & { userAgentData?: { platform?: string } }
  const detected = normalizeUIPlatform(browser.userAgentData?.platform)
  return detected !== 'unknown' ? detected : normalizeUIPlatform(navigator.platform)
}
