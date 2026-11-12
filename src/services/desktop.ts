import type {
  DesktopBridge,
  GitAction,
  GitFlowConfig,
  OperationContext,
  NavigationRequest,
  RebaseMenuRequest,
  SyncContext,
  ActivitySettings,
  OperationLogQuery,
  AutomaticFetchResult,
  BackgroundReadRequest,
  PartialStageRequest,
  HistoryRequest,
  CommitOperationRequest,
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
  if (!canConnectLocalCore()) throw new Error('管理本地仓库需要连接 GitCode 本地 Git 服务。')
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
  fetchSettingsRead: (repo: string) =>
    invoke((bridge) => {
      if (!bridge.fetchSettingsRead) throw Error('请重启本地 Git 服务以加载仓库获取设置。')
      return bridge.fetchSettingsRead(repo)
    }),
  openCommit: (repo: string, request: CommitOperationRequest, remote: string) =>
    invoke(async (bridge) => {
      if (isDesktop()) {
        if (!bridge.openCommit) throw Error('请重启桌面应用以打开提交链接。')
        return bridge.openCommit(repo, request, remote)
      }
      const result = await bridge.commitOperationRead?.(repo, { ...request, kind: 'hosting' })
      const entry = result?.urls?.find((link) => link.name === remote)
      if (!entry) throw Error('托管地址已变化，请重新读取。')
      window.open(entry.url, '_blank', 'noopener,noreferrer')
    }),
  commitOperationRead: (repo: string, request: CommitOperationRequest) =>
    invoke((bridge) => {
      if (!bridge.commitOperationRead) throw Error('请重启本地 Git 服务以加载提交操作。')
      return bridge.commitOperationRead(repo, request)
    }),
  historyMetadata: (repo: string, sha: string) =>
    invoke((bridge) => {
      if (!bridge.historyMetadata)
        throw Error('当前 Git 服务不支持读取提交摘要，请更新并重启服务。')
      return bridge.historyMetadata(repo, sha)
    }),
  historyRead: (repo: string, request: HistoryRequest) =>
    invoke((bridge) => {
      if (!bridge.historyRead) throw Error('请重启本地 Git 服务以加载历史分页。')
      return bridge.historyRead(repo, request)
    }),
  repositoryTrust: (repo: string) =>
    invoke((bridge) => {
      if (!bridge.repositoryTrust) throw Error('请重启本地 Git 服务以加载仓库信任保护。')
      return bridge.repositoryTrust(repo)
    }),
  approveRepositoryTrust: (repo: string, token: string) =>
    invoke((bridge) => {
      if (!bridge.approveRepositoryTrust) throw Error('请重启本地 Git 服务以加载仓库信任保护。')
      return bridge.approveRepositoryTrust(repo, token)
    }),
  repositoryChanges: (repo: string) =>
    invoke((bridge) => bridge.repositoryChanges?.(repo) ?? Promise.resolve(null)),
  backgroundSnapshot: (repo: string, request: BackgroundReadRequest | null) =>
    invoke(
      (bridge) => bridge.backgroundSnapshot?.(repo, request) ?? Promise.resolve({ snapshot: null }),
    ),
  operationLog: (request: OperationLogQuery) =>
    invoke((bridge) => {
      if (!bridge.operationLog) throw new Error('请重启本地 Git 服务以加载活动日志。')
      return bridge.operationLog(request)
    }),
  clearOperationLog: (request: OperationLogQuery) =>
    invoke((bridge) => {
      if (!bridge.clearOperationLog) throw new Error('请重启本地 Git 服务以加载活动日志。')
      return bridge.clearOperationLog(request)
    }),
  activitySettings: (value?: ActivitySettings) =>
    invoke((bridge) => bridge.activitySettings?.(value) ?? Promise.resolve(null)),
  automaticFetch: (repo: string): Promise<AutomaticFetchResult> =>
    invoke((bridge) => bridge.automaticFetch?.(repo) ?? Promise.resolve({ skipped: true })),
  fetchStatus: (repo: string) =>
    invoke((bridge) => bridge.fetchStatus?.(repo) ?? Promise.resolve(null)),
  activity: () => invoke((bridge) => (bridge.activity ? bridge.activity() : Promise.resolve(null))),
  partialStageRead: (repo: string, request: PartialStageRequest) =>
    invoke((bridge) => {
      if (!bridge.partialStageRead) throw Error('请重启本地 Git 服务以加载局部暂存。')
      return bridge.partialStageRead(repo, request)
    }),
  recoveryRead: (repo: string) =>
    invoke((bridge) => {
      if (!bridge.recoveryRead) throw Error('请重启本地 Git 服务以加载操作恢复。')
      return bridge.recoveryRead(repo)
    }),
  rebaseMenuRead: (repo: string, request: RebaseMenuRequest) =>
    invoke((bridge) => {
      if (!bridge.rebaseMenuRead) throw new Error('请重启本地 Git 服务以加载变基历史菜单。')
      return bridge.rebaseMenuRead(repo, request)
    }),
  navigationRead: (repo: string, request: NavigationRequest) =>
    invoke((bridge) => {
      if (!bridge.navigationRead) throw new Error('请重启开发服务或桌面应用以加载导航操作。')
      return bridge.navigationRead(repo, request)
    }),
  mergeRead: (repo: string, file: string | null = null) =>
    invoke((bridge) => {
      if (!bridge.mergeRead)
        throw new Error('本地 Git 服务尚不支持合并处理，请重启开发服务或桌面应用。')
      return bridge.mergeRead(repo, file)
    }),
  stashRead: (repo: string, oid: string, file: string | null = null) =>
    invoke((bridge) => {
      if (!bridge.stashRead)
        throw new Error('本地 Git 服务尚不支持贮藏预览，请重启开发服务或桌面应用。')
      return bridge.stashRead(repo, oid, file)
    }),
  selectedCommitPlan: (repo: string, request: OperationContext & { paths: string[] }) =>
    invoke((bridge) => {
      if (!bridge.selectedCommitPlan)
        throw new Error('本地 Git 服务尚不支持所选文件提交，请重启桌面应用后重试。')
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
  action: (repo: string, request: GitAction) => {
    // GitAction is a JSON DTO. Snapshot nested Vue proxies before Electron's
    // structured clone boundary; selections must not change while IPC is pending.
    const payload = JSON.parse(JSON.stringify(request)) as GitAction
    return invoke((bridge) => bridge.action(repo, payload))
  },
  create: (kind: 'clone' | 'init', path: string, url: string) =>
    invoke((bridge) => bridge.create(kind, path, url)),
  chooseDirectory: (initialPath?: string, purpose?: 'repository' | 'parent') =>
    invoke((bridge) => bridge.chooseDirectory(initialPath, purpose)),
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
