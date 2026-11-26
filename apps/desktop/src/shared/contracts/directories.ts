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
  locations?: { name: string; path: string }[]
}
