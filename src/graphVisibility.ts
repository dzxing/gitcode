import type { Branch, Commit } from './types'
import { branchReference } from './references'
export interface GraphVisibility {
  hidden: string[]
  solo: string[]
}
export function activeSolo(state: GraphVisibility, branches: Branch[]) {
  const refs = new Set(branches.map(branchReference))
  return state.solo.filter((ref) => refs.has(ref))
}
export function graphReferenceVisible(state: GraphVisibility, branch: Branch, branches: Branch[]) {
  const solo = activeSolo(state, branches),
    ref = branchReference(branch)
  return solo.length ? solo.includes(ref) : !state.hidden.includes(ref)
}
export function visibleReferenceBranches(state: GraphVisibility, branches: Branch[]) {
  const solo = new Set(activeSolo(state, branches)),
    hidden = new Set(state.hidden)
  return branches.filter((branch) =>
    solo.size ? solo.has(branchReference(branch)) : !hidden.has(branchReference(branch)),
  )
}
export function visibleHistory(commits: Commit[], branches: Branch[], state: GraphVisibility) {
  const refs = new Set(branches.map(branchReference))
  if (!state.hidden.some((ref) => refs.has(ref)) && !activeSolo(state, branches).length)
    return commits
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]))
  const pending = visibleReferenceBranches(state, branches).map(
    (branch) => branch.commitHash || branch.hash,
  )
  const reachable = new Set<string>()
  while (pending.length) {
    const hash = pending.pop()!
    if (reachable.has(hash)) continue
    reachable.add(hash)
    pending.push(...(byHash.get(hash)?.parents || []))
  }
  return commits.filter((commit) => reachable.has(commit.hash))
}
export function knownAncestor(commits: Commit[], ancestor: string, descendant: string) {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit])),
    pending = [descendant],
    visited = new Set<string>()
  while (pending.length) {
    const hash = pending.pop()!
    if (hash === ancestor) return true
    if (visited.has(hash)) continue
    visited.add(hash)
    pending.push(...(byHash.get(hash)?.parents || []))
  }
  return false
}

// Collapse omitted commits into explicit dotted ancestry. A hidden parent is
// never silently replaced by the next displayed row or an unrelated branch.
export function projectHistory(commits: Commit[], visible: Commit[]) {
  const visibleHashes = new Set(visible.map((commit) => commit.hash))
  const targets = new Map<string, string[]>()
  for (let row = commits.length - 1; row >= 0; row--) {
    const commit = commits[row]
    targets.set(
      commit.hash,
      visibleHashes.has(commit.hash)
        ? [commit.hash]
        : [...new Set(commit.parents.flatMap((parent) => targets.get(parent) || [parent]))],
    )
  }
  const dotted = new Set<string>()
  const projected = visible.map((commit) => {
    const parents = [
      ...new Set(
        commit.parents.flatMap((parent) => {
          const nearest = targets.get(parent) || [parent]
          for (const hash of nearest)
            if (hash !== parent && !commit.parents.includes(hash))
              dotted.add(`${commit.hash}:${hash}`)
          return nearest
        }),
      ),
    ].filter((parent) => parent !== commit.hash)
    return { ...commit, parents }
  })
  return { commits: projected, dotted }
}
