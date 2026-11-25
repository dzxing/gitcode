export interface TerminalShell {
  id: string
  label: string
}
export type TerminalRequest =
  | { action: 'shells' }
  | { action: 'create'; tabId: number; cols: number; rows: number; shell?: string }
  | { action: 'read'; id: string; cursor: number }
  | { action: 'write'; id: string; data: string }
  | { action: 'resize'; id: string; cols: number; rows: number }
  | { action: 'close'; id: string }
export interface TerminalReply {
  id?: string
  shell?: string
  shells?: TerminalShell[]
  data?: string
  cursor?: number
  dropped?: boolean
  more?: boolean
  state?: 'running' | 'exited'
  exitCode?: number | null
}
