import type { Branch, Commit, Snapshot } from './types'
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
