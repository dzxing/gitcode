import type { Branch, Commit, StashEntry } from './types'
import { ideaGraphLayout, type LayoutBasis } from './ideaGraphLayout'
import { projectHistory } from './graphVisibility'

export const HISTORY_ROW_HEIGHT = 30
// Moderate chroma keeps parallel histories distinct on both dark and light surfaces.
export const graphColors = [
  '#4b8eae',
  '#9978b2',
  '#5c9573',
  '#ad834b',
  '#b8737e',
  '#458f89',
  '#7f88b5',
  '#a47f9a',
]
export interface GraphNode {
  hash: string
  x: number
  y: number
  color: string
  merge: boolean
}
export interface GraphEdge {
  childHash: string
  parentHash: string
  d: string
  color: string
  boundary: boolean
  dotted?: boolean
}

export interface GraphNavigationArrow {
  key: string
  direction: 'down' | 'up'
  targetHash: string
  fromX: number
  fromY: number
  otherX: number
  otherY: number
  rowTop: number
  terminal: boolean
  childHash: string
  parentHash: string
  x: number
  y: number
  color: string
}

// Commit rows remain in the backend's date/topology order. The IDEA normal
// layout orders history fragments independently, then compacts each visible row.
export function buildGraph(
  commits: Pick<Commit, 'hash' | 'parents'>[],
  offsetRows = 1,
  rowPositions?: ReadonlyMap<string, number>,
  reserveMissingParents = false,
  branches: Branch[] = [],
  auxiliaryHashes: ReadonlySet<string> = new Set(),
  hideLongEdges = true,
  basis?: LayoutBasis,
) {
  const layout = ideaGraphLayout(
    commits,
    branches,
    reserveMissingParents,
    auxiliaryHashes,
    hideLongEdges,
    basis,
  )
  const hashCode = (name: string) => {
    let value = 0
    for (let i = 0; i < name.length; i++) value = (31 * value + name.charCodeAt(i)) | 0
    return value
  }
  const colorFor = (row: number) => {
    const identity = layout.identities.get(commits[row].hash)!
    const reference = identity.reference
    const colorIndex =
      identity.fragment === identity.headFragment
        ? reference
          ? hashCode(reference.name)
          : 0
        : identity.fragment
    return graphColors[
      ((colorIndex % graphColors.length) + graphColors.length) % graphColors.length
    ]
  }
  const yAt = (row: number) =>
    (offsetRows + (rowPositions?.get(commits[row].hash) ?? row)) * HISTORY_ROW_HEIGHT +
    HISTORY_ROW_HEIGHT / 2
  const nodes: GraphNode[] = commits.map((commit, row) => ({
    hash: commit.hash,
    x: 24 + layout.lanes[row] * 22,
    y: yAt(row),
    color: colorFor(row),
    merge: new Set(commit.parents).size > 1,
  }))
  const arrows: GraphNavigationArrow[] = []
  const edges: GraphEdge[] = layout.edges.map((edge) => {
    const child = nodes[edge.child]
    const points = [{ x: child.x, y: child.y }]
    const appendPoint = (x: number, y: number) => {
      const last = points.length - 1
      // Keep bends at their actual row, but avoid one SVG command per row on
      // a long vertical track. This does not change the geometry.
      if (last > 0 && points[last].x === x && points[last - 1].x === x) points[last] = { x, y }
      else points.push({ x, y })
    }
    for (const { row, position } of edge.positions) appendPoint(24 + position * 22, yAt(row))
    const parent = edge.boundary ? undefined : nodes[edge.parent]
    if (parent) appendPoint(parent.x, parent.y)
    else {
      const last = points[points.length - 1]
      appendPoint(last.x, last.y + HISTORY_ROW_HEIGHT / 2)
    }
    const fragmentRow =
      !edge.boundary &&
      edge.parent >= 0 &&
      layout.fragments[edge.parent] > layout.fragments[edge.child]
        ? edge.parent
        : edge.child
    const color = colorFor(fragmentRow)
    const pathThrough = (route: { x: number; y: number }[]) => {
      let path = `M${route[0].x} ${route[0].y}`
      for (let i = 1; i < route.length; i++) {
        const from = route[i - 1],
          to = route[i]
        // IDEA SimpleGraphCellPainter draws Line2D between adjacent row slots.
        path += from.x === to.x ? ` V${to.y}` : ` L${to.x} ${to.y}`
      }
      return path
    }
    let d = pathThrough(points)
    const span = edge.parent - edge.child
    const auxiliary = auxiliaryHashes.has(child.hash)
    const clipped = !auxiliary && (edge.boundary || span >= (hideLongEdges ? 30 : 1000))
    if (!auxiliary && edge.positions.length && (edge.boundary || span >= 30)) {
      const part = edge.boundary || hideLongEdges ? 1 : 250
      const anchorRow = clipped ? edge.child + part : edge.child + 1
      const top = edge.positions.find((position) => position.row === anchorRow)
      const pointAt = (row: number) => {
        if (row === edge.child) return child
        if (row === edge.parent && parent) return parent
        const position = edge.positions.find((position) => position.row === row)
        return position ? { x: 24 + position.position * 22, y: yAt(row) } : undefined
      }
      const makeArrow = (direction: 'down' | 'up', row: number) => {
        const from = pointAt(row)
        if (!from) return undefined
        const sign = direction === 'down' ? 1 : -1
        const other = clipped
          ? { x: from.x, y: from.y + sign * HISTORY_ROW_HEIGHT }
          : pointAt(row + sign)
        if (!other) return undefined
        // SimpleGraphCellPainter: terminal tips stop before the row border;
        // ordinary tips lie halfway toward the adjacent row's center.
        const tip = clipped
          ? { x: from.x, y: from.y + sign * (HISTORY_ROW_HEIGHT / 2 - (4.5 / 2 + 1)) }
          : { x: (from.x + other.x) / 2, y: (from.y + other.y) / 2 }
        const arrow: GraphNavigationArrow = {
          key: `${child.hash}:${edge.parentHash}:${direction}`,
          direction,
          targetHash: direction === 'down' ? edge.parentHash : child.hash,
          childHash: child.hash,
          parentHash: edge.parentHash,
          fromX: from.x,
          fromY: from.y,
          otherX: other.x,
          otherY: other.y,
          rowTop: yAt(row) - HISTORY_ROW_HEIGHT / 2,
          terminal: clipped,
          ...tip,
          color,
        }
        arrows.push(arrow)
        return arrow
      }
      const down = top ? makeArrow('down', anchorRow) : undefined
      const bottomRow = clipped ? edge.parent - part : edge.parent - 1
      const up = parent ? makeArrow('up', bottomRow) : undefined
      if (clipped && down) {
        const upper = edge.positions
          .filter((position) => position.row <= anchorRow)
          .map((position) => ({ x: 24 + position.position * 22, y: yAt(position.row) }))
        d = pathThrough([child, ...upper, down])
        if (parent && up) {
          const lower = edge.positions
            .filter((position) => position.row >= bottomRow)
            .map((position) => ({ x: 24 + position.position * 22, y: yAt(position.row) }))
          d += ` ${pathThrough([up, ...lower, parent])}`
        }
      }
    }
    return {
      childHash: child.hash,
      parentHash: edge.parentHash,
      d,
      color,
      boundary: edge.boundary,
    }
  })
  // GraphCommitCellUtil: use each row's actual elements and a capped baseline,
  // rather than reserving the widest row throughout the entire history.
  const baseline = Math.min(6, layout.recommendedWidth)
  const textWidth = (slots: number) => Math.ceil(24 + (Math.max(1, slots) - 0.5) * 22 + 3)
  const rowWidths = new Map(
    commits.map((commit, row) => [
      commit.hash,
      textWidth(Math.max(layout.rowMaxIndices[row] + 1, baseline)),
    ]),
  )
  return {
    nodes,
    edges,
    arrows,
    rowWidths,
    recommendedWidth: textWidth(baseline),
    width: Math.max(68, 40 + Math.max(0, layout.width - 1) * 22),
  }
}

export type HistoryRow = { kind: 'commit'; commit: Commit } | { kind: 'stash'; stash: StashEntry }
export interface StashGraphNode extends GraphNode {
  key: string
  entry: StashEntry
  baseHash: string
  boundary: boolean
}

// Stash rows show one snapshot-to-base relationship. The internal index and
// untracked commits never enter the branch DAG or ordinary commit counts.
export function buildHistoryGraph(
  commits: Commit[],
  stashes: StashEntry[] = [],
  showWorktree = true,
  reserveMissingParents = false,
  branches: Branch[] = [],
  hideLongEdges = true,
  basis?: LayoutBasis,
  completeCommits: Commit[] = commits,
) {
  const projection = projectHistory(completeCommits, commits)
  const mergeHashes = new Set(
    commits.filter((commit) => new Set(commit.parents).size > 1).map((commit) => commit.hash),
  )
  const projectedByHash = new Map(projection.commits.map((commit) => [commit.hash, commit]))
  const buckets = new Map<number, StashEntry[]>()
  const ordered = [...stashes].sort(
    (a, b) =>
      Date.parse(b.date) - Date.parse(a.date) ||
      Number(a.ref.match(/\d+/)?.[0]) - Number(b.ref.match(/\d+/)?.[0]),
  )
  for (const entry of ordered) {
    const base = commits.findIndex((commit) => commit.hash === entry.base)
    const byDate = commits.findIndex((commit) => Date.parse(commit.date) <= Date.parse(entry.date))
    const index = Math.min(byDate < 0 ? commits.length : byDate, base < 0 ? commits.length : base)
    buckets.set(index, [...(buckets.get(index) || []), entry])
  }
  const rows: HistoryRow[] = []
  for (let i = 0; i <= commits.length; i++) {
    for (const stash of buckets.get(i) || []) rows.push({ kind: 'stash', stash })
    if (commits[i]) rows.push({ kind: 'commit', commit: commits[i] })
  }
  // Auxiliary stash snapshots enter the visible graph but are visited after
  // ordinary branch heads, so they do not own shared historical fragments.
  const stashKey = (entry: StashEntry) => `stash:${entry.ref}:${entry.oid}`
  const rowOffset = showWorktree ? 1 : 0
  const graph = buildGraph(
    rows.map((row) =>
      row.kind === 'commit'
        ? projectedByHash.get(row.commit.hash)!
        : { hash: stashKey(row.stash), parents: [row.stash.base] },
    ),
    rowOffset,
    undefined,
    reserveMissingParents,
    branches,
    new Set(stashes.map(stashKey)),
    hideLongEdges,
    basis,
  )
  const stashEntries = new Map(stashes.map((entry) => [stashKey(entry), entry]))
  const stashNodes: StashGraphNode[] = [],
    stashEdges: GraphEdge[] = []
  const stashColor = '#bd93d7'
  const baseHashes = new Set(commits.map((commit) => commit.hash))
  for (const node of graph.nodes) {
    const entry = stashEntries.get(node.hash)
    if (entry)
      stashNodes.push({
        ...node,
        key: node.hash,
        hash: entry.oid,
        entry,
        baseHash: entry.base,
        color: stashColor,
        merge: false,
        boundary: !baseHashes.has(entry.base),
      })
  }
  for (const edge of graph.edges)
    if (stashEntries.has(edge.childHash)) stashEdges.push({ ...edge, color: stashColor })
  const worktree: GraphNode = {
    hash: '__worktree__',
    x: 24,
    y: HISTORY_ROW_HEIGHT / 2,
    color: 'var(--accent)',
    merge: false,
  }
  return {
    ...graph,
    nodes: graph.nodes
      .filter((node) => !stashEntries.has(node.hash))
      .map((node) => ({ ...node, merge: mergeHashes.has(node.hash) })),
    edges: graph.edges
      .filter((edge) => !stashEntries.has(edge.childHash))
      .map((edge) =>
        projection.dotted.has(`${edge.childHash}:${edge.parentHash}`)
          ? { ...edge, dotted: true }
          : edge,
      ),
    arrows: graph.arrows.filter((arrow) => !stashEntries.has(arrow.childHash)),
    stashRowWidths: new Map(
      stashes.map((entry) => [
        stashKey(entry),
        graph.rowWidths.get(stashKey(entry)) || graph.recommendedWidth,
      ]),
    ),
    worktree,
    rowOffset,
    rows,
    stashNodes,
    stashEdges,
  }
}
