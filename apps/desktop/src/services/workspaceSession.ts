import type { WorkspaceTab } from '../types'

const key = 'gitcode.workspaceSession.v1'
interface Session {
  version: 1
  active: number
  tabs: { kind: 'new' | 'repository'; path?: string; name?: string }[]
}

export function readWorkspaceSession(): Session | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw || raw.length > 250_000) return null
    const saved: unknown = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return null
    const value = saved as Partial<Session>
    if (
      value.version !== 1 ||
      !Array.isArray(value.tabs) ||
      !value.tabs.length ||
      value.tabs.length > 100 ||
      !Number.isInteger(value.active) ||
      value.active! < 0 ||
      value.active! >= value.tabs.length
    )
      return null
    const paths = new Set<string>()
    for (const tab of value.tabs) {
      if (!tab || (tab.kind !== 'new' && tab.kind !== 'repository')) return null
      if (tab.kind === 'repository') {
        if (
          typeof tab.path !== 'string' ||
          !tab.path ||
          tab.path.length > 4096 ||
          /[\0\r\n]/.test(tab.path)
        )
          return null
        if (tab.name !== undefined && typeof tab.name !== 'string') return null
        if (paths.has(tab.path)) return null
        paths.add(tab.path)
      }
    }
    return value as Session
  } catch {
    return null
  }
}

export function writeWorkspaceSession(tabs: WorkspaceTab[], activeId: number) {
  const entries = tabs.map((tab) =>
    tab.kind === 'new'
      ? { kind: 'new' as const }
      : { kind: 'repository' as const, path: tab.path, name: tab.name },
  )
  if (entries.some((tab) => tab.kind === 'repository' && !tab.path)) return
  const encoded = JSON.stringify({
    version: 1,
    active: Math.max(
      0,
      tabs.findIndex((tab) => tab.id === activeId),
    ),
    tabs: entries,
  })
  if (entries.length > 100 || encoded.length > 250_000)
    throw new Error('仓库标签数量或路径长度超过本机保存上限。')
  localStorage.setItem(key, encoded)
  return window.gitcodeApp?.flushDraftStorage?.()
}
