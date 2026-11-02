export interface ApplicationMenuState {
  enabled: string[]
  recent: string[]
  author: boolean
  time: boolean
  sha: boolean
}
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
export interface ApplicationBridge {
  setMenuState(state: ApplicationMenuState): Promise<void>
  edit(command: EditCommand): Promise<void>
  requestQuit(): Promise<void>
  acknowledgeClose(id: number): Promise<boolean>
  approveClose(id: number): Promise<boolean>
  cancelClose(id: number): Promise<void>
  info(): Promise<{ name: string; version: string; electron: string; platform: string }>
  onCommand(handler: (command: string) => void): () => void
  onCloseRequested(handler: (id: number) => void): () => void
}
declare global {
  interface Window {
    gitkApp?: ApplicationBridge
  }
}
export function applicationBridge() {
  return typeof window === 'undefined' ? null : window.gitkApp || null
}
