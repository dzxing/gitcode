import type { Branch, Commit, HistoryPage, Snapshot } from '../../shared/contracts'
export const isCommitShaQuery = (value: string) => /^[a-f0-9]{7,64}$/i.test(value.trim())
function labels(commit: Commit, branches: Branch[], head: string) {
  return branches
    .filter((b) => (b.commitHash || b.hash) === commit.hash)
    .map((b) =>
      b.kind === 'tag'
        ? `tag: ${b.name}`
        : b.current && commit.hash === head
          ? `HEAD -> ${b.name}`
          : b.name,
    )
}
export function decorateHistory(commits: Commit[], branches: Branch[], head: string) {
  return commits.map((c) => ({ ...c, refs: labels(c, branches, head) }))
}
// Only immutable history rooted at the same tips can be retained. Status and
// reference decorations still come from the newest snapshot.
export function retainHistory(current: Snapshot, next: Snapshot): Snapshot {
  const old = current.history,
    fresh = next.history
  if (current.path !== next.path || !old || !fresh || old.basis !== fresh.signature) return next
  if (!old.focus && current.commits.length <= next.commits.length) return next
  return {
    ...next,
    commits: decorateHistory(current.commits, next.branches, next.head),
    history: { ...old, token: old.focus ? old.token : fresh.token },
  }
}

// When refs move, the old pages cannot be reused. Refill the already displayed
// window from the new fixed-tip frame instead of silently shrinking to page 1.
export async function refillHistoryWindow(
  current: Snapshot,
  next: Snapshot,
  read: (request: { token: string; offset: number }) => Promise<HistoryPage>,
  valid: () => boolean,
): Promise<Snapshot> {
  const old = current.history,
    fresh = next.history
  if (
    current.path !== next.path ||
    !old ||
    !fresh ||
    old.focus ||
    fresh.focus ||
    old.basis === fresh.signature ||
    current.commits.length <= next.commits.length
  )
    return next
  let result = next
  while (
    result.commits.length < current.commits.length &&
    result.history?.nextOffset !== null &&
    result.history?.nextOffset !== undefined
  ) {
    if (!valid()) return next
    const offset = result.history.nextOffset
    const page = await read({ token: fresh.token, offset })
    if (
      page.history.token !== fresh.token ||
      page.history.signature !== fresh.signature ||
      page.history.focus ||
      (page.history.nextOffset !== null && page.history.nextOffset <= offset)
    )
      throw Error('历史分页状态已变化，请重新刷新仓库。')
    const seen = new Set(result.commits.map((commit) => commit.hash))
    const added = page.commits.filter((commit) => !seen.has(commit.hash))
    if (!added.length && page.history.nextOffset !== null)
      throw Error('历史分页未能继续，请重新刷新仓库。')
    result = {
      ...next,
      commits: [...result.commits, ...added],
      history: page.history,
    }
  }
  return result
}
