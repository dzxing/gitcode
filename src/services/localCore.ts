import type { DesktopBridge } from '../types'

export class LocalConnectionError extends Error {}
class LocalRequestError extends Error {}

// HTTP is a transport for the existing named bridge, not a second Git implementation.
export function createLocalCoreClient(
  request: typeof fetch,
  origin: string,
  disconnected: () => void,
) {
  let token = ''
  let session: Promise<string> | null = null
  const pendingReads = new Set<AbortController>()
  async function post(path: string, payload: unknown, auth?: string, signal?: AbortSignal) {
    try {
      const response = await request(`${origin}/__gitcode/${path}`, {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-GitCode-Client': 'gitcode-browser-v1',
          ...(auth ? { 'X-GitCode-Token': auth } : {}),
        },
        body: JSON.stringify(payload),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(330000)])
          : AbortSignal.timeout(path === 'session' ? 8000 : 330000),
      })
      if ([401, 404, 503].includes(response.status)) {
        token = ''
        session = null
        throw new LocalConnectionError(
          '本机 Git 核心尚未连接或连接已失效。请重新连接并核对仓库状态。',
        )
      }
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new LocalRequestError('本机核心返回了无效响应。')
      const value = data as Record<string, unknown>
      if (!response.ok || value.error)
        throw new LocalRequestError(
          typeof value.error === 'string' ? value.error : '本机操作未完成。',
        )
      return value
    } catch (error) {
      if (signal?.aborted) throw new LocalRequestError('已停止读取操作。')
      if (error instanceof LocalRequestError) throw error
      disconnected()
      if (error instanceof LocalConnectionError) throw error
      // Never replay a mutation after a transport failure: Git may have completed it.
      throw new LocalConnectionError(
        '与本机 Git 核心的连接中断。请重新连接并核对仓库状态，刚才的操作可能已经生效。',
      )
    }
  }
  function connect() {
    if (token) return Promise.resolve(token)
    if (!session) {
      session = post('session', {})
        .then((value) => {
          if (
            value.protocol !== 1 ||
            typeof value.token !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.token)
          ) {
            disconnected()
            throw new LocalConnectionError('本机 Git 核心版本不匹配，请重新启动 GitCode。')
          }
          token = value.token
          return token
        })
        .finally(() => {
          session = null
        })
    }
    return session
  }
  async function rpc<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    const auth = await connect()
    return (await post('rpc', { method, args }, auth, signal)).result as T
  }
  async function cancellableRead<T>(method: string, args: unknown[]) {
    const controller = new AbortController()
    pendingReads.add(controller)
    try {
      return await rpc<T>(method, args, controller.signal)
    } finally {
      pendingReads.delete(controller)
    }
  }
  const bridge: DesktopBridge = {
    navigationRead: (repo, request) => cancellableRead('navigation-read', [repo, request]),
    mergeRead: (repo, file) => cancellableRead('merge-read', [repo, file]),
    stashRead: (repo, oid, file) => cancellableRead('stash-read', [repo, oid, file]),
    selectedCommitPlan: (repo, request) => cancellableRead('selected-commit-plan', [repo, request]),
    runtime: () => rpc('runtime', []),
    snapshot: (repo) => cancellableRead('snapshot', [repo]),
    commit: (repo, oid) => rpc('commit', [repo, oid]),
    diff: (repo, file, staged, oid) => rpc('diff', [repo, file, staged, oid || null]),
    action: (repo, value) => rpc('action', [repo, value]),
    gitflowPlan: (repo, value) => rpc('gitflow-plan', [repo, value]),
    syncPlan: (repo, kind, expected) => cancellableRead('sync-plan', [repo, kind, expected]),
    create: (kind, target, url) => rpc('create', [kind, target, url]),
    listDirectory: (path) => rpc('directory', [path || null]),
    cancel: async () => {
      const reads = [...pendingReads]
      // Keep the session alive and wait for the core's cancellation acknowledgement.
      await rpc('cancel', [])
      for (const controller of reads) controller.abort()
    },
    chooseDirectory: () => Promise.reject(new Error('请使用本机目录浏览器选择目录。')),
    openResource: (resource) => {
      const url =
        resource === 'git-docs'
          ? 'https://git-scm.com/docs'
          : resource === 'git-book'
            ? 'https://git-scm.com/book/zh/v2'
            : null
      if (!url) return Promise.reject(new Error('未知的帮助资源。'))
      window.open(url, '_blank', 'noopener,noreferrer')
      return Promise.resolve()
    },
  }
  function close() {
    if (!token) return
    const auth = token
    token = ''
    session = null
    disconnected()
    void request(`${origin}/__gitcode/close`, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        'X-GitCode-Client': 'gitcode-browser-v1',
        'X-GitCode-Token': auth,
      },
      body: '{}',
    }).catch(() => {})
  }
  return { bridge, close }
}
