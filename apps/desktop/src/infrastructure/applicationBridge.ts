import type { ApplicationBridge } from '../shared/contracts/applicationBridge'

declare global {
  interface Window {
    gitcodeApp?: ApplicationBridge
  }
}

export function applicationBridge() {
  return typeof window === 'undefined' ? null : window.gitcodeApp || null
}
