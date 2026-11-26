import type { ActionResult } from './actions'
import type { OperationContext, Snapshot } from './repository'

export interface FetchStatus {
  lastAttempt: number
  lastSuccess: number
  error: string
  remotes: Record<
    string,
    { lastAttempt: number; lastSuccess: number; error: string; paused: boolean }
  >
}
export interface AutomaticFetchResult {
  skipped: boolean
  snapshot?: Snapshot | null
  status?: FetchStatus
  outcome?: ActionResult['outcome']
}
export interface PublishTarget {
  remote: string
  branch: string
}
export interface SyncContext extends OperationContext {
  commitOid?: string
  detachedSource?: boolean
  publish?: PublishTarget
  sourceRef?: string
  sourceOid?: string
  method?: 'ff-only' | 'merge'
}
export interface SyncPlan {
  id: string
  kind: 'fetch' | 'pull' | 'push'
  method?: 'ff-only' | 'merge'
  head: string
  branch: string
  worktreeBranch?: string
  sourceRef: string
  destinationRef: string
  expiresAt: number
  remoteCheck?: {
    state: 'absent' | 'deleted' | 'current' | 'forward' | 'behind' | 'diverged' | 'error'
    oid?: string
    ahead?: number
    behind?: number
    checkedAt: number
    message?: string
  }
  publish?: PublishTarget & { remotes: string[] }
  remotes: { name: string; address: string }[]
}
