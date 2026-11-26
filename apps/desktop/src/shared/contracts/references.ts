import type { DiffResult, FileChange } from './changes'
import type { RebasePlan } from './rebase'
import type { OperationContext } from './repository'

export interface Branch {
  worktreePath?: string
  commitHash?: string
  symbolicTarget?: string
  fullRef?: string
  name: string
  hash: string
  current: boolean
  upstream: string
  track: string
  kind: 'local' | 'remote' | 'tag'
}
export interface NavigationRequest extends OperationContext {
  kind: 'info' | 'rebase' | 'delete-remote' | 'compare-head' | 'compare-working'
  fullRef: string
  expectedOid: string
  file?: string
}
export interface NavigationInfo {
  rebase?: RebasePlan
  fullRef: string
  referenceOid: string
  oid: string
  head: string
  branch: string
  canFastForward: boolean
  alreadyMerged: boolean
  related: boolean
  remote?: { remote: string; remoteRef: string; oid: string; signature: string; checkedAt: number }
  files?: FileChange[]
  diff?: DiffResult | null
}
