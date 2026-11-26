import type { FileChange } from './changes'
import type { RebasePlan } from './rebase'
import type { OperationContext } from './repository'

export type CommitOperation =
  | 'reset'
  | 'cherry'
  | 'revert'
  | 'undo'
  | 'reword'
  | 'fixup'
  | 'squash-into'
  | 'drop'
  | 'squash'
  | 'interactive'
export interface CommitOperationRequest extends OperationContext {
  kind: 'plan' | 'browse' | 'blob' | 'patch' | 'hosting' | 'relations' | 'push-sources'
  oids: string[]
  operation?: CommitOperation
  file?: string
}
export interface CommitOperationPlan {
  id: string
  operation: CommitOperation
  commits: { sha: string; parents: string[]; message: string; subject: string }[]
  rebase: RebasePlan | null
  dirty: boolean
  files: FileChange[]
  head: string
  branch: string
  expiresAt: number
}
export interface CommitOperationRead extends Partial<CommitOperationPlan> {
  sources?: { fullRef: string; oid: string }[]
  content?: string
  entries?: { mode: string; type: string; oid: string; path: string }[]
  urls?: { name: string; url: string }[]
  parents?: string[]
  children?: string[]
}
