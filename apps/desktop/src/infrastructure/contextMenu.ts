export type NativeMenuItem =
  { type: 'separator' } | { id: string; label: string; enabled: boolean; checked?: boolean }

export interface NativeContextMenuBridge {
  popup(request: { requestId: number; items: NativeMenuItem[] }): Promise<string | null>
  close(requestId: number): Promise<void>
}

declare global {
  interface Window {
    gitcodeContextMenu?: NativeContextMenuBridge
  }
}
export function nativeContextMenu() {
  return typeof window === 'undefined' ? null : window.gitcodeContextMenu || null
}
