import type { FileChange } from './changes'
import type { RebaseState } from './rebase'

export interface MergeConflict {
  path: string
  type: string
  stages: Record<string, { mode: string; oid: string }>
}
export interface MergeState {
  sequence?: 'cherry-pick' | 'revert'
  rebase?: RebaseState
  active: boolean
  incoming: string
  head: string
  branch: string
  signature: string
  unsupported: boolean
  unsupportedReason?: string
  files: MergeConflict[]
  staged: FileChange[]
  message: string
}
export interface MergeVersion {
  exists: boolean
  text: string | null
  binary: boolean
}
export interface MergeFile {
  markerSize?: number
  manualReason?: string
  path: string
  token: string
  base: MergeVersion
  ours: MergeVersion
  theirs: MergeVersion
  working: string | null
  editable: boolean
  supported: boolean
  branch: string
  incoming: string
}
export interface MergeRead {
  state: MergeState | null
  file: MergeFile | null
}
