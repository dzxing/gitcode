import type { DiffResult, FileChange } from './changes'

// branch is descriptive creation metadata, not stash ownership or a restore restriction.
export interface StashEntry {
  ref: string
  oid: string
  message: string
  date: string
  branch: string
  base: string
}
export interface StashDetails {
  files: FileChange[]
  stagedPaths: string[]
  base: string
  diff: DiffResult | null
  indexDiff?: DiffResult | null
}
