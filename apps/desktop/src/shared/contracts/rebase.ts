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
export interface RebaseMenuRequest {
  head: string
  oid: string
}
