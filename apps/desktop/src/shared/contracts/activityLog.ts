export interface ActivitySettings {
  autoFetchInterval: number
  extended: boolean
}
export interface OperationLogQuery {
  focus?: 'fetch-failure'
  id?: string
  scope: 'application' | 'repository'
  repo?: string
}
export interface OperationLogEntry {
  detailLoaded?: boolean
  steps?: { remote: string; ok: boolean; message?: string }[]
  refreshError?: string
  warning?: string
  repeatCount?: number
  lastSeenAt?: number
  id: string
  operation: string
  repo: string
  target: string
  background: boolean
  startedAt: number
  finishedAt?: number
  duration?: number
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'
  message: string
  output: string
  commands: string
  truncated: boolean
}
export interface OperationLogResult {
  records: OperationLogEntry[]
  settings: ActivitySettings
  storageError: string
}
export interface GitActivity {
  id: string
  operation: string
  repo: string
  phase: string
  percent: number | null
  state: 'running' | 'finished'
}
