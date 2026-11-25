import type { Branch } from '../contracts'

export function branchReference(branch: Branch) {
  return (
    branch.fullRef ||
    `refs/${branch.kind === 'local' ? 'heads' : branch.kind === 'remote' ? 'remotes' : 'tags'}/${branch.name}`
  )
}

export function sidebarBranchKey(section: string, branch: Branch) {
  return JSON.stringify([section, branchReference(branch)])
}
