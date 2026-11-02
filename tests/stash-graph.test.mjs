import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
try {
  const { buildGraph, buildHistoryGraph, HISTORY_ROW_HEIGHT } =
    await vite.ssrLoadModule('/src/graph.ts')
  const commits = [
    { hash: 'new', parents: ['old'], date: '2026-10-28T00:00:00Z' },
    { hash: 'old', parents: [], date: '2026-10-27T00:00:00Z' },
  ].map((c) => ({ ...c, subject: c.hash, author: 'Tester', email: 'test@example.com', refs: [] }))
  const stash = (ref, oid, base = 'old', date = '2026-10-29T00:00:00Z') => ({
    ref,
    oid,
    base,
    date,
    message: 'On main: Test',
    branch: 'main',
  })
  await test('stash snapshot renders one node and one base edge, without internal merge parents', () => {
    const graph = buildHistoryGraph(commits, [stash('stash@{0}', 'stash')])
    assert.equal(graph.nodes.length, 2)
    assert.equal(graph.stashNodes.length, 1)
    assert.equal(graph.stashEdges.length, 1)
    assert.equal(graph.stashEdges[0].parentHash, 'old')
    assert.equal(graph.stashNodes[0].merge, false)
    assert.deepEqual(
      graph.rows.map((r) => r.kind),
      ['stash', 'commit', 'commit'],
    )
    assert.equal(graph.stashNodes[0].y, HISTORY_ROW_HEIGHT * 1.5)
    assert.equal(graph.nodes[0].y, HISTORY_ROW_HEIGHT * 2.5)
    assert.equal(graph.edges[0].childHash, 'new')
    assert.equal(graph.worktree.x, 24)
    assert.ok(graph.edges.every((edge) => edge.childHash !== '__worktree__'))
  })
  await test('no stash preserves normal history; stash children always precede their base despite odd timestamps', () => {
    const normal = buildHistoryGraph(commits),
      mixed = buildHistoryGraph(commits, [
        stash('stash@{0}', 'stash', 'new', '2000-01-01T00:00:00Z'),
      ])
    assert.deepEqual(normal.nodes, buildGraph(commits).nodes)
    assert.deepEqual(normal.edges, buildGraph(commits).edges)
    assert.deepEqual(
      mixed.nodes.map((n) => [n.hash, n.x, n.color]),
      normal.nodes.map((n) => [n.hash, n.x, n.color]),
    )
    assert.ok(mixed.stashNodes[0].y < mixed.nodes[0].y)
    assert.equal(mixed.stashNodes[0].x, mixed.nodes[0].x)
  })
  await test('a free corridor aligns the stash with its base despite other branch lanes', () => {
    const branches = [
      { ...commits[0], hash: 'tip', parents: ['root'] },
      { ...commits[0], hash: 'other', parents: ['root'] },
      { ...commits[1], hash: 'root' },
    ]
    const graph = buildHistoryGraph(branches, [stash('stash@{0}', 'stash', 'tip')])
    const node = graph.stashNodes[0],
      base = graph.nodes.find((n) => n.hash === 'tip')
    assert.ok(graph.nodes.some((n) => n.x > base.x))
    assert.equal(node.x, base.x)
    assert.equal(graph.stashEdges[0].d, `M${node.x} ${node.y}V${base.y}`)
  })
  await test('a recent stash reserves the left lane through a crowded history instead of being pushed right', () => {
    const branches = [
      { ...commits[0], hash: 'a', parents: ['root'] },
      { ...commits[0], hash: 'b', parents: ['broot'] },
      { ...commits[0], hash: 'c', parents: ['root'] },
      { ...commits[1], hash: 'broot', parents: ['root'] },
      { ...commits[1], hash: 'root' },
    ]
    const graph = buildHistoryGraph(branches, [
      stash('stash@{0}', 'stash', 'b', '2026-10-28T00:00:00Z'),
    ])
    const node = graph.stashNodes[0],
      base = graph.nodes.find((n) => n.hash === 'b')
    assert.equal(node.x, base.x)
    assert.ok(node.x < Math.max(...graph.nodes.map((n) => n.x)))
    const blocked = buildHistoryGraph(commits, [stash('stash@{0}', 'stash', 'old')])
    assert.equal(blocked.stashNodes[0].x, 24)
    assert.equal(blocked.nodes.find((n) => n.hash === 'old').x, 24)
    assert.equal(blocked.nodes.find((n) => n.hash === 'new').x, 46)
    const crowded = buildHistoryGraph(branches, [stash('stash@{0}', 'stash', 'root')])
    assert.equal(crowded.stashNodes[0].x, 24)
    assert.equal(crowded.nodes.find((n) => n.hash === 'root').x, 24)
    assert.ok(crowded.nodes.filter((n) => n.hash !== 'root').every((n) => n.x > 24))
    assert.equal(
      crowded.stashEdges[0].d,
      `M24 45V${crowded.nodes.find((n) => n.hash === 'root').y}`,
    )
  })
  await test('multiple stashes sharing a base reserve separate overlapping tracks', () => {
    const graph = buildHistoryGraph(commits, [
      stash('stash@{0}', 'first', 'new'),
      stash('stash@{1}', 'second', 'new'),
    ])
    assert.notEqual(graph.stashNodes[0].x, graph.stashNodes[1].x)
    assert.ok(graph.stashNodes.some((n) => n.x === graph.nodes[0].x))
  })
  await test('missing bases get boundary stubs and duplicate object entries retain independent identities', () => {
    const graph = buildHistoryGraph(commits, [
      stash('stash@{0}', 'same', 'missing'),
      stash('stash@{1}', 'same', 'old'),
    ])
    assert.equal(graph.stashNodes.length, 2)
    assert.notEqual(graph.stashNodes[0].key, graph.stashNodes[1].key)
    assert.equal(graph.stashNodes.find((n) => n.baseHash === 'missing').boundary, true)
    assert.equal(graph.stashEdges.find((e) => e.parentHash === 'missing').boundary, true)
    assert.ok(graph.nodes.every((n) => n.hash !== 'same'))
    assert.equal(graph.stashEdges.length, 2)
  })
  await test('a clean worktree removes the reserved row without changing commit or stash lanes', () => {
    const entries = [stash('stash@{0}', 'stash', 'old')],
      dirty = buildHistoryGraph(commits, entries, true),
      clean = buildHistoryGraph(commits, entries, false)
    assert.equal(clean.rowOffset, 0)
    assert.equal(dirty.rowOffset, 1)
    for (const [index, node] of [...clean.nodes, ...clean.stashNodes].entries()) {
      const shown = [...dirty.nodes, ...dirty.stashNodes][index]
      assert.equal(node.x, shown.x)
      assert.equal(node.y + HISTORY_ROW_HEIGHT, shown.y)
    }
    assert.equal(clean.stashNodes[0].y, 15)
    assert.deepEqual(clean.rows, dirty.rows)
  })
} finally {
  await vite.close()
}
