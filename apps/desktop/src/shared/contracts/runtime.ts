export interface GitRuntimeSelection {
  mode: 'auto' | 'system' | 'custom'
  path?: string
}
export interface GitRuntimeSettings {
  selection: GitRuntimeSelection
  runtime: RuntimeInfo
  restartRequired?: boolean
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
