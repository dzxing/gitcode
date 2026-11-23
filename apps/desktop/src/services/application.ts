import type { ThemeSource, ThemePalette, ThemePreference } from '../themePresets'
import type { ReferenceLabelStyle } from '../referenceLabels'
export interface ApplicationMenuState {
  wsl?: boolean
  theme?: ThemeSource
  themePreference?: ThemePreference
  palette?: ThemePalette
  resolvedTheme?: 'dark' | 'light'
  labelStyle?: ReferenceLabelStyle
  enabled: string[]
  recent: string[]
  author: boolean
  time: boolean
  sha: boolean
  longEdges?: boolean
  mergeCommits?: boolean
  labelsAfterMessage?: boolean
}
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
export type StartupPhase =
  'renderer-start' | 'core-ready' | 'restore-start' | 'ready' | 'failed' | 'skipped'
export interface ApplicationBridge {
  installedFonts?(): Promise<string[]>
  repositoryLocation?(repo: string, action: 'copy-path' | 'show-folder'): Promise<void>
  startupPhase?(phase: StartupPhase): Promise<void>
  flushDraftStorage?(): Promise<void>
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
