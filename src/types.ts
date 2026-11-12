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
export interface HistoryPage {
  commits: Commit[]
  history: HistoryState
}
export interface Snapshot {
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
export interface Notice {
  logId?: string
  details?: string
  expanded?: boolean
  id: number
  text: string
  error: boolean
}
export interface GitRuntimeSelection {
  mode: 'auto' | 'system' | 'custom'
  path?: string
}
export interface GitRuntimeSettings {
  selection: GitRuntimeSelection
  runtime: RuntimeInfo
  restartRequired?: boolean
}
export interface ActivitySettings {
  autoFetchInterval: number
  extended: boolean
}
export interface OperationLogQuery {
  focus?: 'fetch-failure'
  id?: string
  scope: 'application' | 'repository'
  repo?: string
}
export interface OperationLogEntry {
  detailLoaded?: boolean
  steps?: { remote: string; ok: boolean; message?: string }[]
  refreshError?: string
  warning?: string
  repeatCount?: number
  lastSeenAt?: number
  id: string
  operation: string
  repo: string
  target: string
  background: boolean
  startedAt: number
  finishedAt?: number
  duration?: number
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown'
  message: string
  output: string
  commands: string
  truncated: boolean
}
export interface FetchStatus {
  lastAttempt: number
  lastSuccess: number
  error: string
  remotes: Record<
    string,
    { lastAttempt: number; lastSuccess: number; error: string; paused: boolean }
  >
}
export interface OperationLogResult {
  records: OperationLogEntry[]
  settings: ActivitySettings
  storageError: string
}
export interface AutomaticFetchResult {
  skipped: boolean
  snapshot?: Snapshot | null
  status?: FetchStatus
  outcome?: ActionResult['outcome']
}
export interface GitActivity {
  id: string
  operation: string
  repo: string
  phase: string
  percent: number | null
  state: 'running' | 'finished'
}
export interface RuntimeInfo {
  transport?: 'local'
  environment?: 'wsl' | 'native'
  // Platform running Git, which can differ from the renderer's host (e.g. WSL).
  platform: string
  gitAvailable: boolean
  gitVersion: string
  gitPath: string
  gitSource?: string
  gitError: string
}
export type CommitMetadata = Pick<Commit, 'hash' | 'subject' | 'author' | 'date'>
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
export interface SelectedCommitPlan {
  id: string
  paths: string[]
  files: { path: string; oldPath?: string; status: string; partialStaged: boolean }[]
  partialPaths: string[]
  selectedCount: number
  scope: 'working-tree'
  expiresAt: number
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
export interface RebaseState {
  sourceBranch: string
  targetName: string
  targetOid: string
  originalHead: string
  pausedOid: string
  step: number
  total: number
  backend: string
  owned: boolean
  message: string
  signature: string
}
export interface RebaseStep {
  author: string
  email: string
  date: string
  sha: string
  parents: string[]
  subject: string
  message: string
  type: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'
}
export interface RebasePlan {
  fromHere?: boolean
  upstream?: string
  root?: boolean
  signature: string
  steps: RebaseStep[]
  canInteractive: boolean
  reason: string
  dirty: boolean
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
  remoteBases?: GitFlowRemoteBase[]
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
export interface GitFlowRemoteBase {
  fullRef: string
  oid: string
  name: string
  remote: string
  remoteRef: string
}
export interface GitFlowInitPlan {
  id: string
  config: GitFlowConfig
  creates: { name: string; sourceRef: string; oid: string; tracking?: GitFlowRemoteBase }[]
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
export interface CheckoutProtection {
  id: string
  branch: string
  paths: string[]
}
export interface ActionResult {
  worktree?: Pick<Snapshot, 'path' | 'head' | 'branch' | 'staged' | 'unstaged'>
  logId?: string
  branchDeleteBlocked?: 'unmerged'
  checkoutProtection?: CheckoutProtection
  remoteCheckoutProtection?: {
    id: string
    branch: string
    remote: string
    localOid: string
    remoteOid: string
  }
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
export interface RebaseMenuRequest {
  head: string
  oid: string
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
export interface RecoveryEntry {
  id: string
  ref: string
  oid: string
  kind: 'deleted' | 'commit'
  branch: string
  createdAt: number
}
export interface RecoveryPlan {
  id: string
  repo: string
  head: string
  branch: string
  parent: string
  subject: string
  blocked: string
  published: string[]
  entries: RecoveryEntry[]
}
export interface PartialStagePlan {
  id: string
  file: string
  source: 'staged' | 'unstaged'
  diff: string
  hunks: { id: number; lines: number[]; hunkOnly: boolean }[]
}
export type PartialStageRequest = OperationContext & { file: string; source: 'staged' | 'unstaged' }
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
export interface DesktopBridge {
  fetchSettingsRead?(repo: string): Promise<RepositoryFetchSettings>
  openCommit?(repo: string, request: CommitOperationRequest, remote: string): Promise<void>
  commitOperationRead?(repo: string, request: CommitOperationRequest): Promise<CommitOperationRead>
  historyMetadata?(repo: string, sha: string): Promise<CommitMetadata>
  historyRead?(repo: string, request: HistoryRequest): Promise<HistoryPage>
  repositoryTrust?(repo: string): Promise<RepositoryTrustInfo>
  approveRepositoryTrust?(repo: string, token: string): Promise<{ path: string }>

  partialStageRead?(repo: string, request: PartialStageRequest): Promise<PartialStagePlan>
  recoveryRead?(repo: string): Promise<RecoveryPlan>
  rebaseMenuRead?(repo: string, request: RebaseMenuRequest): Promise<{ canInteractive: boolean }>
  navigationRead?(repo: string, request: NavigationRequest): Promise<NavigationInfo>
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
  operationLog?(request: OperationLogQuery): Promise<OperationLogResult>
  clearOperationLog?(request: OperationLogQuery): Promise<void>
  activitySettings?(value?: ActivitySettings): Promise<ActivitySettings>
  automaticFetch?(repo: string): Promise<AutomaticFetchResult>
  fetchStatus?(repo: string): Promise<FetchStatus>
  repositoryChanges?(repo: string): Promise<RepositoryChanges | null>
  backgroundSnapshot?(
    repo: string,
    request: BackgroundReadRequest | null,
  ): Promise<BackgroundReadResult>
  activity?(): Promise<GitActivity | null>
  runtime(): Promise<RuntimeInfo>
  gitSettings?(value?: GitRuntimeSelection): Promise<GitRuntimeSettings>
  refreshGitRuntime?(): Promise<GitRuntimeSettings>
  chooseGit?(): Promise<string | null>
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
  ): Promise<{
    snapshot: Snapshot | null
    path?: string
    warning?: string
    requiresTrust?: boolean
  }>
  chooseDirectory(initialPath?: string, purpose?: 'repository' | 'parent'): Promise<string | null>
  listDirectory(initialPath?: string): Promise<DirectoryListing>
  cancel(): Promise<void>
  openResource(resource: 'git-docs' | 'git-book'): Promise<void>
}
export type GitAction =
  | ({
      action: 'set-fetch-scope'
      remote: string
      mode: 'all' | 'selected'
      branches: string[]
      signature: string
    } & OperationContext)
  | ({ action: 'unshallow'; remote: string; signature: string } & OperationContext)
  | ({ action: 'checkout-revision'; oid: string } & OperationContext)
  | ({
      action: 'commit-operation'
      planId: string
      confirm: boolean
      mode?: string
      message?: string
      paths?: string[]
      steps?: RebaseStep[]
      confirmHard?: boolean
      confirmPartial?: boolean
    } & OperationContext)
  | ({
      action: 'commit-sequence'
      command: 'continue' | 'abort' | 'skip'
      mergeSignature: string
      confirm?: boolean
    } & OperationContext)
  | ({ action: 'checkout-remote'; fullRef: string; expectedOid: string } & OperationContext)
  | ({
      action: 'checkout-remote-confirm'
      planId: string
      choice: 'create' | 'reset'
      name?: string
    } & OperationContext)
  | ({
      action: 'rebase-start'
      fullRef: string
      expectedOid: string
      planSignature: string
      steps?: RebaseStep[]
    } & OperationContext)
  | ({
      action: 'rebase-continue' | 'rebase-skip' | 'rebase-abort'
      mergeSignature: string
      confirm?: boolean
    } & OperationContext)
  | ({
      action: 'merge-branch' | 'fast-forward'
      fullRef: string
      expectedOid: string
      confirm: boolean
    } & OperationContext)
  | ({
      action: 'create-tag'
      fullRef: string
      expectedOid: string
      name: string
      annotated: boolean
      message: string
    } & OperationContext)
  | ({
      action: 'delete-remote-branch'
      fullRef: string
      expectedOid: string
      confirm: boolean
      remoteSignature: string
    } & OperationContext)
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
  | ({ action: 'stage' | 'unstage'; paths: string[]; refresh?: 'worktree' } & OperationContext)
  | ({ action: 'commit'; message: string } & OperationContext)
  | ({ action: 'partial-stage'; planId: string; lines: number[] } & OperationContext)
  | ({ action: 'recovery-undo'; planId: string; confirmUnpublished: boolean } & OperationContext)
  | ({
      action: 'recovery-restore'
      planId: string
      entryId: string
      name: string
    } & OperationContext)
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
      force?: boolean
      name: string
      expectedOid: string
      expectedHead: string
      expectedBranch: string
    }
  | { action: 'fetch' | 'pull' | 'push' | 'pull-and-push'; planId: string }

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
