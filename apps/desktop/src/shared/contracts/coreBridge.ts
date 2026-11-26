import type { ActionResult, GitAction } from './actions'
import type {
  ActivitySettings,
  GitActivity,
  OperationLogQuery,
  OperationLogResult,
} from './activityLog'
import type {
  DiffResult,
  PartialStagePlan,
  PartialStageRequest,
  SelectedCommitPlan,
} from './changes'
import type { CommitOperationRead, CommitOperationRequest } from './commitOperations'
import type { DirectoryListing } from './directories'
import type { GitConsoleReply, GitConsoleRequest } from './gitConsole'
import type { GitFlowConfig, GitFlowInitPlan } from './gitflow'
import type {
  CommitDetails,
  CommitMetadata,
  HistoryPage,
  HistoryRequest,
  HistoryToolRequest,
  HistoryToolResult,
} from './history'
import type { MergeRead } from './merge'
import type { RebaseMenuRequest } from './rebase'
import type { RecoveryPlan } from './recovery'
import type { NavigationInfo, NavigationRequest } from './references'
import type {
  BackgroundReadRequest,
  BackgroundReadResult,
  OperationContext,
  RepositoryChanges,
  RepositoryFetchSettings,
  RepositoryTrustInfo,
  Snapshot,
} from './repository'
import type { GitRuntimeSelection, GitRuntimeSettings, RuntimeInfo } from './runtime'
import type { StashDetails } from './stash'
import type { AutomaticFetchResult, FetchStatus, SyncContext, SyncPlan } from './sync'
import type { TerminalReply, TerminalRequest } from './terminal'

export interface CoreBridge {
  gitConsole?(repo: string, request: GitConsoleRequest): Promise<GitConsoleReply>
  terminal?(repo: string, request: TerminalRequest): Promise<TerminalReply | void>
  refreshReferences?(repo: string, signature: string): Promise<Snapshot | null>
  fetchSettingsRead?(repo: string): Promise<RepositoryFetchSettings>
  openCommit?(repo: string, request: CommitOperationRequest, remote: string): Promise<void>
  commitOperationRead?(repo: string, request: CommitOperationRequest): Promise<CommitOperationRead>
  historyMetadata?(repo: string, sha: string): Promise<CommitMetadata>
  historyTools?(repo: string, request: HistoryToolRequest): Promise<HistoryToolResult>
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
  openResource(resource: 'git-docs' | 'git-book' | 'git-install'): Promise<void>
}
