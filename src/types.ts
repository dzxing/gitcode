export interface Commit {
  hash: string
  parents: string[]
  subject: string
  author: string
  email: string
  date: string
  refs: string[]
}
export interface Branch {
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
export interface FileChange {
  path: string
  oldPath?: string
  status: string
}
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
export interface Snapshot {
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
export interface Notice {
  id: number
  text: string
  error: boolean
}
export interface RuntimeInfo {
  transport?: 'local'
  environment?: 'wsl' | 'native'
  platform: string
  gitAvailable: boolean
  gitVersion: string
  gitPath: string
  gitError: string
}
export interface CommitDetails {
  files: FileChange[]
  body: string
}
export interface DiffResult {
  diff: string
  truncated: boolean
}
export interface DirectoryEntry {
  name: string
  path: string
  isGit: boolean
  hidden: boolean
  symlink: boolean
}
export interface DirectoryListing {
  path: string
  parent: string | null
  home: string
  root: string
  folders: DirectoryEntry[]
  truncated: boolean
}
export interface OperationContext {
  expectedHead: string
  expectedBranch: string
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
export interface SyncContext extends OperationContext {
  sourceRef?: string
  sourceOid?: string
  method?: 'ff-only' | 'merge'
}
export interface MergeConflict {
  path: string
  type: string
  stages: Record<string, { mode: string; oid: string }>
}
export interface MergeState {
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
export type GitFlowType = 'feature' | 'release' | 'hotfix'
export interface GitFlowConfig {
  production: string
  develop: string
  feature: string
  release: string
  hotfix: string
  versionTag: string
}
export interface GitFlowFinishState {
  id?: string
  signature: string
  type: GitFlowType
  branch: string
  index: number
  steps: { label: string; done: boolean }[]
  current: string
  error: string
  tagName?: string
  deleteBranch?: boolean
  pending?: boolean
  blocked?: boolean
}
export interface GitFlowState {
  finishSupported?: boolean
  finish?: GitFlowFinishState | null
  config: GitFlowConfig
  signature: string
  configured: boolean
  ready: boolean
  missing: string[]
  error: string
  writeError: string
  operationError?: string
}
export interface GitFlowInitPlan {
  id: string
  config: GitFlowConfig
  creates: { name: string; sourceRef: string; oid: string }[]
  retained: string[]
  references?: { fullRef: string; oid: string }[]
  expiresAt: number
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
  remotes: { name: string; address: string }[]
}
export interface CheckoutProtection {
  id: string
  branch: string
  paths: string[]
}
export interface ActionResult {
  checkoutProtection?: CheckoutProtection
  syncProblem?: 'diverged' | 'push-rejected'
  details?: string
  snapshot: Snapshot | null
  output: string
  outcome: 'succeeded' | 'failed' | 'partial' | 'cancelled'
  error?: string
  warning?: string
  refreshError?: string
  cleanupError?: string
  steps?: { remote: string; ok: boolean; message?: string }[]
}
export interface DesktopBridge {
  mergeRead?(repo: string, file: string | null): Promise<MergeRead>
  stashRead?(repo: string, oid: string, file: string | null): Promise<StashDetails>
  selectedCommitPlan?(
    repo: string,
    request: OperationContext & { paths: string[] },
  ): Promise<SelectedCommitPlan>
  gitflowPlan(
    repo: string,
    request: OperationContext & {
      signature: string
      config: GitFlowConfig
      sources: Record<string, string>
    },
  ): Promise<GitFlowInitPlan>
  runtime(): Promise<RuntimeInfo>
  syncPlan(repo: string, kind: 'fetch' | 'pull' | 'push', expected: SyncContext): Promise<SyncPlan>
  snapshot(repo: string): Promise<Snapshot>
  commit(repo: string, commit: string): Promise<CommitDetails>
  diff(
    repo: string,
    path: string,
    staged: boolean | 'working',
    commit?: string | null,
  ): Promise<DiffResult>
  action(repo: string, request: GitAction): Promise<ActionResult>
  create(
    kind: 'clone' | 'init',
    path: string,
    url: string,
  ): Promise<{ snapshot: Snapshot | null; path?: string; warning?: string }>
  chooseDirectory(initialPath?: string): Promise<string | null>
  listDirectory(initialPath?: string): Promise<DirectoryListing>
  cancel(): Promise<void>
  openResource(resource: 'git-docs' | 'git-book'): Promise<void>
}
export type GitAction =
  | ({
      action: 'gitflow-finish'
      branch: string
      signature: string
      sourceOid: string
      targetOids: Record<string, string>
      deleteBranch: boolean
      createTag: boolean
      tagName: string
      tagMessage: string
    } & OperationContext)
  | ({
      action: 'gitflow-finish-continue' | 'gitflow-finish-stop'
      finishSignature: string
    } & OperationContext)
  | ({
      action: 'merge-resolve'
      mergeSignature: string
      file: string
      token: string
      choice: 'ours' | 'theirs' | 'manual'
      content?: string
    } & OperationContext)
  | ({
      action: 'merge-finish' | 'merge-abort'
      mergeSignature: string
      message?: string
    } & OperationContext)
  | ({
      action: 'stash-create'
      message: string
      includeUntracked: boolean
      stashSignature: string
    } & OperationContext)
  | ({
      action: 'stash-apply' | 'stash-pop' | 'stash-drop'
      stashOid: string
      stashRef: string
      stashSignature: string
      restoreIndex?: boolean
      confirmDelete?: boolean
    } & OperationContext)
  | ({ action: 'gitflow-save'; signature: string; config: GitFlowConfig } & OperationContext)
  | ({ action: 'gitflow-init'; planId: string } & OperationContext)
  | ({
      action: 'gitflow-start'
      signature: string
      type: GitFlowType
      name: string
      sourceOid: string
      switchAfter: boolean
    } & OperationContext)
  | ({ action: 'stage' | 'unstage'; paths: string[] } & OperationContext)
  | ({ action: 'commit'; message: string } & OperationContext)
  | ({
      action: 'commit-selected'
      planId: string
      message: string
      confirmPartial?: boolean
    } & OperationContext)
  | ({ action: 'stash-checkout'; planId: string } & OperationContext)
  | ({ action: 'branch' | 'checkout'; name: string; expectedOid?: string } & OperationContext)
  | {
      action: 'create-branch'
      name: string
      startOid: string
      switchAfter: boolean
      expectedHead?: string
      expectedBranch?: string
    }
  | {
      action: 'track-branch'
      name: string
      fullRef: string
      expectedOid: string
      switchAfter: boolean
      expectedHead?: string
      expectedBranch?: string
    }
  | {
      action: 'rename-branch'
      name: string
      newName: string
      expectedOid: string
      expectedHead: string
      expectedBranch: string
    }
  | {
      action: 'delete-branch'
      name: string
      expectedOid: string
      expectedHead: string
      expectedBranch: string
    }
  | { action: 'fetch' | 'pull' | 'push'; planId: string }

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
