import type { DiffResult, FileChange } from './changes'
import type { GitFlowState } from './gitflow'
import type { Commit, HistoryState } from './history'
import type { MergeState } from './merge'
import type { Branch } from './references'
import type { StashEntry } from './stash'

export interface Snapshot {
  execution?: { kind: 'wsl'; distribution: string; gitPath: string; gitVersion: string }
  referenceSignature?: string
  history?: HistoryState
  remotes?: string[]
  merge?: MergeState | null
  stashes?: StashEntry[]
  stashSignature?: string
  gitflow?: GitFlowState
  path: string
  name: string
  branch: string
  commits: Commit[]
  branches: Branch[]
  staged: FileChange[]
  unstaged: FileChange[]
  total: number
  head: string
}
export interface RepositoryChanges {
  revision: string
  fallback: boolean
  watched: number
}
export interface BackgroundReadRequest {
  file?: { path: string; source: 'working' | 'staged' | 'unstaged' }
}
export interface BackgroundReadResult {
  snapshot: Snapshot | null
  deferred?: 'busy' | 'locked'
  diff?:
    | ({
        file: FileChange
        source: 'working' | 'staged' | 'unstaged'
        error?: string
      } & Partial<DiffResult>)
    | null
}
export interface OperationContext {
  expectedHead: string
  expectedBranch: string
}
export interface CheckoutProtection {
  id: string
  branch: string
  paths: string[]
}
export interface RepositoryTrustInfo {
  path: string
  gitDir: string
  trusted: boolean
  token: string
}
export interface RepositoryFetchSettings {
  path: string
  shallow: boolean
  signature: string
  remotes: {
    name: string
    mode: 'all' | 'selected' | 'custom'
    branches: string[]
    mappings: string[]
    editable: boolean
    skipped: boolean
    reason: string
  }[]
}
