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
