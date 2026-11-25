import type { Branch } from '../../shared/contracts'

// upstream:track compares local refs. It is not a live query of the server.
export function branchTracking(branch?: Branch) {
  const empty = { ahead: 0, behind: 0, label: '', description: '', state: 'none' as string }
  if (!branch || branch.kind !== 'local') return empty
  if (!branch.upstream) return { ...empty, state: 'untracked' }
  if (branch.track === '[gone]')
    return {
      ...empty,
      state: 'gone',
      label: '上游不存在',
      description: `上游 ${branch.upstream} 的本地跟踪引用已不存在，请获取并检查远端。`,
    }
  const raw = branch.track || '',
    ahead = Number(raw.match(/\bahead (\d+)\b/)?.[1] || 0),
    behind = Number(raw.match(/\bbehind (\d+)\b/)?.[1] || 0)
  if (
    raw.replace(/\bahead \d+\b|\bbehind \d+\b/g, '').replace(/[\s,[\]]/g, '') ||
    !Number.isSafeInteger(ahead) ||
    !Number.isSafeInteger(behind)
  )
    return {
      ...empty,
      state: 'unknown',
      label: '状态未知',
      description: `无法识别上游 ${branch.upstream} 的同步状态，请获取并检查。`,
    }
  const label = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ')
  const comparison =
    [ahead ? `领先 ${ahead} 个提交` : '', behind ? `落后 ${behind} 个提交` : '']
      .filter(Boolean)
      .join('，') || '提交一致'
  return {
    ahead,
    behind,
    label,
    state: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'synced',
    description: `与上游 ${branch.upstream} 相比：${comparison}。基于本地已获取的引用；获取后才会获知远端更新。`,
  }
}
