import type {
  DesktopBridge,
  GitAction,
  GitFlowConfig,
  OperationContext,
  SyncContext,
} from '../types'
import type { NativeWindow } from './window'
import { createLocalCoreClient } from './localCore'

declare global {
  interface Window {
    gitk?: DesktopBridge
    gitkWindow?: NativeWindow
  }
}

// A narrow preload bridge; the Vue renderer never receives Node.js or raw IPC.
export function isDesktop() {
  return typeof window !== 'undefined' && typeof window.gitk?.runtime === 'function'
}

export function canConnectLocalCore() {
  return (
    typeof window !== 'undefined' &&
    window.location?.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  )
}
let local: ReturnType<typeof createLocalCoreClient> | null = null
const disconnectListeners = new Set<() => void>()
export function onLocalCoreDisconnected(listener: () => void) {
  disconnectListeners.add(listener)
  return () => {
    disconnectListeners.delete(listener)
  }
}
function bridge() {
  if (isDesktop()) return window.gitk!
  if (!canConnectLocalCore())
    throw new Error('当前仅支持界面体验。管理本地仓库需要连接 GitCode 本机核心。')
  if (!local) {
    local = createLocalCoreClient(
      (...args) => fetch(...args),
      window.location.origin,
      () => disconnectListeners.forEach((listener) => listener()),
    )
    window.addEventListener('pagehide', () => local?.close())
  }
  return local.bridge
}

async function invoke<T>(work: (bridge: DesktopBridge) => Promise<T>): Promise<T> {
  try {
    return await work(bridge())
  } catch (error: unknown) {
    throw error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : '本机操作失败，请重试。')
  }
}

export const desktop = {
  mergeRead: (repo: string, file: string | null = null) =>
    invoke((bridge) => {
      if (!bridge.mergeRead) throw new Error('本机核心尚不支持合并处理，请重启开发服务或桌面应用。')
      return bridge.mergeRead(repo, file)
    }),
  stashRead: (repo: string, oid: string, file: string | null = null) =>
    invoke((bridge) => {
      if (!bridge.stashRead) throw new Error('本机核心尚不支持贮藏预览，请重启开发服务或桌面应用。')
      return bridge.stashRead(repo, oid, file)
    }),
  selectedCommitPlan: (repo: string, request: OperationContext & { paths: string[] }) =>
    invoke((bridge) => {
      if (!bridge.selectedCommitPlan)
        throw new Error('本机核心尚不支持所选文件提交，请重启桌面应用后重试。')
      return bridge.selectedCommitPlan(repo, request)
    }),
  gitflowPlan: (
    repo: string,
    request: OperationContext & {
      signature: string
      config: GitFlowConfig
      sources: Record<string, string>
    },
  ) => invoke((bridge) => bridge.gitflowPlan(repo, request)),
  runtime: () => invoke((bridge) => bridge.runtime()),
  syncPlan: (repo: string, kind: 'fetch' | 'pull' | 'push', expected: SyncContext) =>
    invoke((bridge) => bridge.syncPlan(repo, kind, expected)),
  snapshot: (repo: string) => invoke((bridge) => bridge.snapshot(repo)),
  commit: (repo: string, commit: string) => invoke((bridge) => bridge.commit(repo, commit)),
  diff: (repo: string, path: string, staged: boolean | 'working', commit?: string) =>
    invoke((bridge) => bridge.diff(repo, path, staged, commit || null)),
  action: (repo: string, request: GitAction) => invoke((bridge) => bridge.action(repo, request)),
  create: (kind: 'clone' | 'init', path: string, url: string) =>
    invoke((bridge) => bridge.create(kind, path, url)),
  chooseDirectory: (initialPath?: string) =>
    invoke((bridge) => bridge.chooseDirectory(initialPath)),
  listDirectory: (initialPath?: string) => invoke((bridge) => bridge.listDirectory(initialPath)),
  cancel: () => invoke((bridge) => bridge.cancel()),
  openResource: async (resource: 'git-docs' | 'git-book') => {
    if (!isDesktop() && typeof window !== 'undefined') {
      const url =
        resource === 'git-docs'
          ? 'https://git-scm.com/docs'
          : resource === 'git-book'
            ? 'https://git-scm.com/book/zh/v2'
            : null
      if (!url) throw new Error('未知的帮助资源。')
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    await invoke((bridge) => bridge.openResource(resource))
  },
}

export function pathName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

export function joinPath(parent: string, name: string) {
  const separator = /^[A-Za-z]:[\\/]/.test(parent) || parent.startsWith('\\\\') ? '\\' : '/'
  return parent.replace(/[\\/]+$/, '') + separator + name
}
