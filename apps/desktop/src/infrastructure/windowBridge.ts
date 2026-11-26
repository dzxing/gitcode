import type { NativeWindow } from '../shared/contracts/windowBridge'

export function currentNativeWindow(): NativeWindow | null {
  return typeof window === 'undefined' ? null : window.gitcodeWindow || null
}
