// Portions adapted from IntelliJ IDEA graph layout and element comparison.
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under Apache-2.0; see third-party/jetbrains-graph/NOTICE.txt.
// TypeScript adaptation for GitCode: explicit boundary vertices and SVG row slots.
import type { Branch } from './types'

export interface LayoutCommit {
  hash: string
  parents: string[]
}
export interface LayoutEdge {
  child: number
  parent: number
  parentHash: string
  boundary: boolean
  positions: { row: number; position: number }[]
}

// Permanent fragment identity is independent of the currently displayed rows.
export interface LayoutIdentity {
  fragment: number
  headFragment: number
  reference?: Branch
}
export type LayoutBasis = ReadonlyMap<string, LayoutIdentity>

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' })
function referencePriority(branch: Branch) {
  if (branch.kind === 'remote')
    return branch.name === 'origin/main' || branch.name === 'origin/master' ? 0 : 1
  if (branch.kind === 'local') return branch.name === 'main' || branch.name === 'master' ? 2 : 3
  return 4
}
function compareReferences(a: Branch, b: Branch) {
  return referencePriority(a) - referencePriority(b) || names.compare(a.name, b.name)
}

// GraphLayoutBuilder: visit branch tips and graph heads in reference order,
// then follow parent order. A fragment index is a relative order, not a lane.
export function ideaGraphLayout(
  commits: LayoutCommit[],
  branches: Branch[] = [],
  reserveMissingParents = false,
  auxiliaryHashes: ReadonlySet<string> = new Set(),
  hideLongEdges = false,
  basis?: LayoutBasis,
) {
  const indices = new Map(commits.map((commit, index) => [commit.hash, index]))
  const hashes = commits.map((commit) => commit.hash)
  const parents: number[][] = commits.map(() => [])
  const children = commits.map(() => 0)
  const edges: LayoutEdge[] = []
  for (const [child, commit] of commits.entries()) {
    for (const hash of new Set(commit.parents)) {
      let parent = indices.get(hash)
      if (parent === undefined && reserveMissingParents) {
        parent = hashes.length
        indices.set(hash, parent)
        hashes.push(hash)
        parents.push([])
        children.push(0)
      }
      const boundary = parent === undefined || parent >= commits.length || parent <= child
      // A filtered or malformed relation terminates locally, never points upward
      // through a different visible commit. Missing page parents may reserve lanes.
      if (parent !== undefined && parent > child) {
        parents[child].push(parent)
        if (!auxiliaryHashes.has(commit.hash)) children[parent]++
      }
      edges.push({
        child,
        parent: parent !== undefined && parent > child ? parent : -1,
        parentHash: hash,
        boundary,
        positions: [],
      })
    }
  }
  const refs = new Map<number, Branch>()
  for (const branch of branches) {
    if (branch.symbolicTarget) continue
    const index = indices.get(branch.commitHash || branch.hash)
    if (index === undefined || index >= commits.length) continue
    const previous = refs.get(index)
    if (!previous || compareReferences(branch, previous) < 0) refs.set(index, branch)
  }
  const heads = [
    ...new Set([
      ...[...refs].filter(([, ref]) => ref.kind !== 'tag').map(([index]) => index),
      ...commits.flatMap((_, i) => (!children[i] ? [i] : [])),
    ]),
  ]
  heads.sort((a, b) => {
    const auxiliary =
      Number(auxiliaryHashes.has(hashes[a])) - Number(auxiliaryHashes.has(hashes[b]))
    if (auxiliary) return auxiliary
    const first = refs.get(a),
      second = refs.get(b)
    if (first && second) return compareReferences(first, second) || a - b
    if (first) return -1
    if (second) return 1
    return a - b
  })
  const fragments = new Int32Array(hashes.length)
  const owners = new Int32Array(hashes.length)
  let fragment = 1
  if (basis)
    for (const identity of basis.values()) fragment = Math.max(fragment, identity.fragment + 1)
  for (const head of heads) {
    if (fragments[head]) continue
    // Explicit frames reproduce post-order fragment advancement without recursion.
    const stack = [{ node: head, entered: false, next: 0, fresh: false }]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (!frame.entered) {
        frame.entered = true
        frame.fresh = !fragments[frame.node]
        if (frame.fresh) {
          fragments[frame.node] = fragment
          owners[frame.node] = head
          if (parents[frame.node].every((parent) => fragments[parent] !== 0)) {
            fragment++
            stack.pop()
            continue
          }
        }
      }
      const adjacent = parents[frame.node]
      while (frame.next < adjacent.length && fragments[adjacent[frame.next]] !== 0) frame.next++
      if (frame.next < adjacent.length) {
        stack.push({ node: adjacent[frame.next++], entered: false, next: 0, fresh: false })
      } else {
        stack.pop()
      }
    }
  }

  const identities = new Map<string, LayoutIdentity>()
  for (let row = 0; row < hashes.length; row++) {
    const owner = owners[row]
    identities.set(
      hashes[row],
      basis?.get(hashes[row]) || {
        fragment: fragments[row],
        headFragment: fragments[owner],
        reference: refs.get(owner),
      },
    )
  }
  if (basis)
    for (let row = 0; row < hashes.length; row++)
      fragments[row] = identities.get(hashes[row])!.fragment

  // GraphElementComparatorByLayoutIndex: ordering an edge by a single lane or
  // its child alone is insufficient around merges. Compare its span to a node.
  const edgeToNode = (edge: LayoutEdge, node: number): number => {
    if (edge.boundary) return fragments[edge.child] - fragments[node]
    const order = Math.max(fragments[edge.child], fragments[edge.parent])
    return order !== fragments[node] ? order - fragments[node] : edge.child - node
  }
  const compareEdges = (a: LayoutEdge, b: LayoutEdge): number => {
    if (a.boundary) return -edgeToNode(b, a.child)
    if (b.boundary) return edgeToNode(a, b.child)
    if (a.child === b.child)
      return a.parent < b.parent ? -edgeToNode(b, a.parent) : edgeToNode(a, b.parent)
    return a.child < b.child ? edgeToNode(a, b.child) : -edgeToNode(b, a.child)
  }
  const starts = commits.map(() => [] as LayoutEdge[])
  for (const edge of edges)
    if (edge.boundary || edge.parent > edge.child) starts[edge.child].push(edge)
  const active = new Set<LayoutEdge>()
  const lanes: number[] = []
  let width = 0
  let previousEdges = 0,
    sum = 0,
    sumSquares = 0
  const sampleSize = Math.min(20000, commits.length)
  const visibleAt = (edge: LayoutEdge, row: number) =>
    edge.boundary
      ? row === edge.child + 1
      : auxiliaryHashes.has(commits[edge.child].hash) ||
        edge.parent - edge.child < (hideLongEdges ? 30 : 1000) ||
        row - edge.child <= (hideLongEdges ? 1 : 250) ||
        (!edge.boundary && edge.parent - row <= (hideLongEdges ? 1 : 250))
  for (let row = 0; row < commits.length; row++) {
    for (const edge of active)
      if (edge.boundary ? row > edge.child + 1 : edge.parent === row) active.delete(edge)
    const visibleEdges = [...active].filter((edge) => visibleAt(edge, row))
    const elements: (LayoutEdge | number)[] = [row, ...visibleEdges]
    elements.sort((a, b) => {
      if (typeof a === 'number') return typeof b === 'number' ? a - b : -edgeToNode(b, a)
      return typeof b === 'number' ? edgeToNode(a, b) : compareEdges(a, b)
    })
    for (const [position, element] of elements.entries()) {
      if (typeof element === 'number') lanes[row] = position
      else element.positions.push({ row, position })
    }
    width = Math.max(width, elements.length)
    for (const edge of starts[row]) active.add(edge)
    if (row < sampleSize) {
      const nextEdges = [...active].filter((edge) => !edge.boundary && visibleAt(edge, row)).length
      // NOT_LOAD_COMMIT and other downward special edges contribute an arrow
      // at their source even though their printable stub occupies the next row.
      const downArrows = starts[row].filter((edge) => edge.boundary).length
      const count = Math.max(previousEdges, nextEdges + downArrows)
      const weight =
        sampleSize > 1 ? (2 / (sampleSize * 1.1)) * (1 - (0.9 * row) / (sampleSize - 1)) : 1
      sum += count * weight
      sumSquares += count * count * weight
      previousEdges = nextEdges
    }
  }
  const recommendedWidth =
    sampleSize === 1 ? 1 : Math.round(sum + Math.sqrt(Math.max(0, sumSquares - sum * sum)))
  const rowMaxIndices = [...lanes]
  for (const edge of edges) {
    const positions = edge.boundary
      ? edge.positions.filter((position) => position.row <= edge.child + 1)
      : edge.positions
    const route = [{ row: edge.child, position: lanes[edge.child] }, ...positions]
    if (!edge.boundary) route.push({ row: edge.parent, position: lanes[edge.parent] })
    for (const position of route)
      rowMaxIndices[position.row] = Math.max(rowMaxIndices[position.row], position.position)
    for (let i = 1; i < route.length; i++) {
      const from = route[i - 1],
        to = route[i]
      if (to.row !== from.row + 1) continue
      const midpoint = (from.position + to.position) / 2
      rowMaxIndices[from.row] = Math.max(rowMaxIndices[from.row], midpoint)
      rowMaxIndices[to.row] = Math.max(rowMaxIndices[to.row], midpoint)
    }
  }
  return {
    lanes,
    fragments,
    owners,
    refs,
    identities,
    edges,
    width,
    recommendedWidth,
    rowMaxIndices,
  }
}
