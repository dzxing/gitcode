import type { OperationContext } from './repository'

export interface FileChange {
  path: string
  oldPath?: string
  status: string
}
export interface DiffResult {
  diff: string
  truncated: boolean
}
export interface SelectedCommitPlan {
  id: string
  paths: string[]
  files: { path: string; oldPath?: string; status: string; partialStaged: boolean }[]
  partialPaths: string[]
  selectedCount: number
  scope: 'working-tree'
  expiresAt: number
}
export interface PartialStagePlan {
  id: string
  file: string
  source: 'staged' | 'unstaged'
  diff: string
  hunks: { id: number; lines: number[]; hunkOnly: boolean }[]
}
export type PartialStageRequest = OperationContext & { file: string; source: 'staged' | 'unstaged' }
