export interface GitConsoleEntry {
  repo: string
  operationId: string
  commandId: string
  sequence: number
  at: number
  kind: 'start' | 'stdout' | 'stderr' | 'finish'
  text: string
  progress?: boolean
  code?: number | null
  state?: 'cancelled' | 'failed' | 'succeeded'
  elapsed?: number
}
export interface GitConsoleRequest {
  action: 'read' | 'tail'
  epoch?: string
  cursor?: number
}
export interface GitConsoleReply {
  epoch: string
  cursor: number
  entries: GitConsoleEntry[]
  reset: boolean
  dropped: boolean
  more: boolean
  running: { commandId: string; operationId: string; repo: string; command: string; at: number }[]
}
