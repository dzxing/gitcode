import type { GitFlowConfig, GitFlowType } from './gitflow'
import type { RebaseStep } from './rebase'
import type { CheckoutProtection, OperationContext, Snapshot } from './repository'

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
