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
    assert.equal(graph.stashEdges[0].d.replaceAll(' ', ''), `M${node.x}${node.y}V${base.y}`)
  })
  await test('stash routes reach their base without taking ownership of ordinary history fragments', () => {
    const branches = [
      { ...commits[0], hash: 'a', parents: ['root'] },
      { ...commits[0], hash: 'b', parents: ['broot'] },
      { ...commits[0], hash: 'c', parents: ['root'] },
      { ...commits[1], hash: 'broot', parents: ['root'] },
      { ...commits[1], hash: 'root' },
    ]
    for (const baseHash of ['a', 'b', 'root']) {
      const ordinary = buildHistoryGraph(branches, [])
      const graph = buildHistoryGraph(branches, [stash('stash@{0}', 'stash', baseHash)])
      const base = graph.nodes.find((node) => node.hash === baseHash)
      const edge = graph.stashEdges[0]
      assert.equal(edge.parentHash, baseHash)
      assert.equal(edge.boundary, false)
      let end = { x: 0, y: 0 }
      for (const [, command, raw] of edge.d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
        const values = raw.trim().split(/[ ,]+/).map(Number)
        if (command === 'M' || command === 'L') end = { x: values[0], y: values[1] }
        if (command === 'H') end.x = values[0]
        if (command === 'V') end.y = values[0]
        if (command === 'Q') end = { x: values.at(-2), y: values.at(-1) }
      }
      assert.deepEqual(end, { x: base.x, y: base.y })
      assert.deepEqual(
        graph.nodes.map((node) => node.color),
        ordinary.nodes.map((node) => node.color),
      )
      assert.ok(graph.stashNodes[0].y < base.y)
    }
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
