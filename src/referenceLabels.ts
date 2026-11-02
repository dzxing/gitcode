import type { Branch, Commit } from './types'
import { branchReference } from './references'

export interface CommitReference {
  key: string
  label: string
  rawLabel: string
  kind: Branch['kind'] | 'unknown'
  current: boolean
  branch?: Branch
}
export interface ReferenceGroup {
  key: string
  primary: CommitReference
  members: CommitReference[]
  current: boolean
}
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const priority = (ref: CommitReference) =>
  ref.current
    ? 0
    : ref.kind === 'local'
      ? 1
      : ref.kind === 'remote'
        ? 2
        : ref.kind === 'tag'
          ? 3
          : 4

export function resolveCommitReferences(
  commit: Commit,
  branches: readonly Branch[],
): CommitReference[] {
  const resolved = new Map<string, CommitReference>()
  for (const branch of branches) {
    if (
      branch.kind === 'remote' &&
      branch.name.endsWith('/HEAD') &&
      (branch.symbolicTarget !== undefined
        ? !!branch.symbolicTarget
        : branch.name.split('/').length === 2)
    )
      continue
    const pointsHere = branch.commitHash
      ? branch.commitHash === commit.hash
      : branch.hash === commit.hash ||
        (branch.kind === 'tag' && commit.refs.includes(`tag: ${branch.name}`))
    if (!pointsHere) continue
    const current = branch.kind === 'local' && branch.current
    const rawLabel =
      branch.kind === 'tag'
        ? `tag: ${branch.name}`
        : current
          ? `HEAD -> ${branch.name}`
          : branch.name
    resolved.set(branchReference(branch), {
      key: branchReference(branch),
      label: branch.name,
      rawLabel,
      kind: branch.kind,
      current,
      branch,
    })
  }
  for (const raw of commit.refs) {
    const tag = raw.startsWith('tag: '),
      name = raw.replace(/^HEAD -> /, '').replace(/^tag: /, '')
    // Known references at another commit and remote symbolic aliases must not
    // become fallback labels. An unresolved decoration is always read-only.
    if (
      branches.some(
        (branch) => branch.name === name && (tag ? branch.kind === 'tag' : branch.kind !== 'tag'),
      )
    )
      continue
    const key = `unresolved:${raw}`
    resolved.set(key, {
      key,
      label: name,
      rawLabel: raw,
      kind: tag ? 'tag' : 'unknown',
      current: false,
    })
  }
  return [...resolved.values()].sort(
    (a, b) =>
      priority(a) - priority(b) || collator.compare(a.label, b.label) || a.key.localeCompare(b.key),
  )
}

export function groupCommitReferences(references: readonly CommitReference[]): ReferenceGroup[] {
  const consumed = new Set<string>(),
    groups: ReferenceGroup[] = []
  // Resolve current local first so a shared upstream is consumed only once.
  for (const ref of [...references].sort(
    (a, b) =>
      priority(a) - priority(b) || collator.compare(a.label, b.label) || a.key.localeCompare(b.key),
  )) {
    if (consumed.has(ref.key)) continue
    const members = [ref]
    consumed.add(ref.key)
    if (ref.kind === 'local' && ref.branch?.upstream) {
      const upstream = ref.branch.upstream.startsWith('refs/')
        ? ref.branch.upstream
        : `refs/remotes/${ref.branch.upstream}`
      const remote = references.find(
        (candidate) =>
          candidate.kind === 'remote' && candidate.key === upstream && !consumed.has(candidate.key),
      )
      if (remote) {
        members.push(remote)
        consumed.add(remote.key)
      }
    }
    groups.push({ key: ref.key, primary: ref, members, current: ref.current })
  }
  return groups
}
