type Unlisten = () => void

export interface NativeWindow {
  readonly platform?: string
  readonly nativeControls?: boolean
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  isFullscreen(): Promise<boolean>
  isFocused(): Promise<boolean>
  onResized(handler: () => void): Promise<Unlisten>
  onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<Unlisten>
}

export function currentNativeWindow(): NativeWindow | null {
  return typeof window === 'undefined' ? null : window.gitcodeWindow || null
}
