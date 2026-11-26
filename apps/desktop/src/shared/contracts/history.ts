import type { FileChange } from './changes'

export interface Commit {
  hash: string
  parents: string[]
  subject: string
  author: string
  email: string
  date: string
  refs: string[]
}
export interface HistoryState {
  // Renderer-only scope; never persisted or sent as a Git command parameter.
  focusSource?: 'sha' | 'branch'
  token: string
  signature: string
  basis: string
  focus: string | null
  nextOffset: number | null
  total: number
}
export interface HistoryRequest {
  token: string
  offset?: number
  sha?: string
}
export interface HistoryToolRequest {
  kind: 'file' | 'diff' | 'three' | 'query' | 'cancel'
  scope?: string
  local?: boolean
  path?: string
  oldPath?: string
  revision?: string
  base?: string
  token?: string
  offset?: number
  query?: string
  author?: string
  branch?: string
  since?: string
  until?: string
}
export interface HistoryToolResult {
  commits?: (Commit & { path?: string; oldPath?: string })[]
  nextOffset?: number | null
  diff?: string
  versions?: { exists: boolean; text: string | null; binary: boolean }[]
  signature?: string
}
export interface HistoryPage {
  commits: Commit[]
  history: HistoryState
}
export type CommitMetadata = Pick<Commit, 'hash' | 'subject' | 'author' | 'date'>
export interface CommitDetails {
  files: FileChange[]
  body: string
}
