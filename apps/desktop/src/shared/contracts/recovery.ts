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
