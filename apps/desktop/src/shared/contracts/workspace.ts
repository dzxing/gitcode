import type { Snapshot, Commit, StashEntry, FileChange } from './git'

// Renderer session and notification models; never sent as Git commands.
export interface Notice {
  logId?: string
  details?: string
  expanded?: boolean
  id: number
  text: string
  error: boolean
}

export interface WorkspaceState {
  repo: Snapshot
  query: string
  historyFilter: { fullRef: string; source: string } | null
  sidebarQuery?: string
  selectedCommit: Commit | null
  selectedStash?: StashEntry | null
  stashDiffSource?: 'working' | 'staged'
  selectedFile: FileChange | null
  fileStaged: boolean
  fileDiffSource?: 'working' | 'staged' | null
  diffText: string
  diffTruncated: boolean
  diffError?: string
  commitFiles: FileChange[]
  commitBody: string
  commitError?: string
  commitMessage: string
  commitDescription: string
}
export interface WorkspaceTab {
  id: number
  kind: 'repository' | 'new'
  name: string
  path?: string
  state?: WorkspaceState
}
