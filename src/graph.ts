import type { Commit, StashEntry } from './types'

export const HISTORY_ROW_HEIGHT = 30
// Saturated lanes inspired by the supplied GitKraken screenshot; lifted where
// needed to remain visible on both the graph surface and selected rows.
export const graphColors = [
  '#15a0bf',
  '#b455f7',
  '#3484ff',
  '#e52e9a',
  '#f36b3f',
  '#d83deb',
  '#ed5258',
  '#74bd56',
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
}

// Route cross-lane ancestry inside the gap between rows. Keeping the turn near
// the child preserves lane reservations and avoids drawing through reused lanes.
function roundedParentPath(x: number, y: number, px: number, py: number) {
  if (x === px) return `M${x} ${y}V${py}`
  const horizontal = Math.sign(px - x),
    vertical = Math.sign(py - y) || 1
  const radius = Math.min(5, Math.abs(px - x) / 2, Math.abs(py - y) / 4)
  const bendY = y + vertical * Math.min(HISTORY_ROW_HEIGHT / 2, Math.abs(py - y) / 2)
  return `M${x} ${y} V${bendY - vertical * radius} Q${x} ${bendY},${x + horizontal * radius} ${bendY} H${px - horizontal * radius} Q${px} ${bendY},${px} ${bendY + vertical * radius} V${py}`
}

// Follow parent hashes rather than commit order or branch labels. The same DAG
// drives both lanes and edges; filtered/missing parents stop at a boundary stub.
export function buildGraph(
  commits: Pick<Commit, 'hash' | 'parents'>[],
  offsetRows = 1,
  rowPositions?: ReadonlyMap<string, number>,
) {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const lanes: (string | null)[] = []
  const rows = new Map(commits.map((commit, index) => [commit.hash, index]))
  let maxLane = 0
  commits.forEach((commit, index) => {
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = commit.hash
    }
    const x = 24 + lane * 22
    const y =
      (offsetRows + (rowPositions?.get(commit.hash) ?? index)) * HISTORY_ROW_HEIGHT +
      HISTORY_ROW_HEIGHT / 2
    const color = graphColors[lane % graphColors.length]
    nodes.push({ hash: commit.hash, x, y, color, merge: commit.parents.length > 1 })
    lanes[lane] = null
    commit.parents.forEach((parent, parentIndex) => {
      if (!rows.has(parent)) {
        edges.push({
          childHash: commit.hash,
          parentHash: parent,
          d: `M${x} ${y}V${y + HISTORY_ROW_HEIGHT / 2}`,
          color,
          boundary: true,
        })
        return
      }
      let parentLane = lanes.indexOf(parent)
      if (parentLane < 0) {
        parentLane = parentIndex === 0 && lanes[lane] === null ? lane : lanes.indexOf(null)
        if (parentLane < 0) parentLane = lanes.length
        // Reserve the parent lane until that commit is encountered.
        lanes[parentLane] = parent
      }
      maxLane = Math.max(maxLane, parentLane, lane)
      const px = 24 + parentLane * 22
      const parentRow = rows.get(parent)
      const py =
        (offsetRows + (rowPositions?.get(parent) ?? parentRow!)) * HISTORY_ROW_HEIGHT +
        HISTORY_ROW_HEIGHT / 2
      const d = roundedParentPath(x, y, px, py)
      edges.push({
        childHash: commit.hash,
        parentHash: parent,
        d,
        color: parentIndex === 0 ? color : graphColors[parentLane % graphColors.length],
        boundary: false,
      })
    })
  })
  return { nodes, edges, width: Math.max(116, 48 + maxLane * 22) }
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
) {
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
  // Allocate the combined visible history together. In particular, a new stash
  // reserves its base's lane before newer branch commits are laid out. Drawing
  // stashes over an already frozen commit graph forced them to the right.
  const stashKey = (entry: StashEntry) => `stash:${entry.ref}:${entry.oid}`
  const rowOffset = showWorktree ? 1 : 0
  const graph = buildGraph(
    rows.map((row) =>
      row.kind === 'commit' ? row.commit : { hash: stashKey(row.stash), parents: [row.stash.base] },
    ),
    rowOffset,
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
    nodes: graph.nodes.filter((node) => !stashEntries.has(node.hash)),
    edges: graph.edges.filter((edge) => !stashEntries.has(edge.childHash)),
    worktree,
    rowOffset,
    rows,
    stashNodes,
    stashEdges,
  }
}
