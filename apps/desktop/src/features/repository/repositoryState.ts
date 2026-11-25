import type { Snapshot } from '../../shared/contracts'

export function emptyRepository(): Snapshot {
  return {
    path: '',
    name: '',
    branch: '',
    head: '',
    commits: [],
    branches: [],
    staged: [],
    unstaged: [],
    total: 0,
  }
}
