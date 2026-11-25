import type { Commit } from '../../shared/contracts'

// Return null when the loaded graph cannot prove the answer. Never guess across
// omitted history: the core can read the frozen commit range on demand.
export function interactiveRebaseFromHistory(commits: Commit[], head: string, target: string) {
  if (head === target) return false
  const graph = new Map(commits.map((commit) => [commit.hash, commit]))
  const excluded = new Set<string>(),
    pending = [target]
  let complete = true
  while (pending.length) {
    const sha = pending.pop()!
    if (excluded.has(sha)) continue
    excluded.add(sha)
    const commit = graph.get(sha)
    if (!commit) complete = false
    else pending.push(...commit.parents)
  }
  if (excluded.has(head)) return false
  let sha = head,
    count = 0
  const visited = new Set<string>()
  while (!visited.has(sha)) {
    visited.add(sha)
    if (sha === target) return count > 0 && count <= 200
    if (excluded.has(sha)) return complete ? count > 0 && count <= 200 : null
    const commit = graph.get(sha)
    if (!commit) return null
    if (commit.parents.length !== 1) return complete ? false : null
    count++
    if (count > 200) return complete ? false : null
    sha = commit.parents[0]!
  }
  return null
}
