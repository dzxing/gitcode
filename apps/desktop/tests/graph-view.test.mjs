import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
const storage = new Map(),
  previous = globalThis.localStorage
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
}
try {
  const { visibleHistory, visibleReferenceBranches, knownAncestor } =
    await vite.ssrLoadModule('/src/graphVisibility.ts')
  const { useGraphViewStore } = await vite.ssrLoadModule('/src/stores/graphView.ts')
  const commits = [
    { hash: 'topic', parents: ['base'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]
  const branch = (name, hash, kind = 'local') => ({
    name,
    hash,
    kind,
    fullRef: `refs/${kind === 'local' ? 'heads' : 'remotes'}/${name}`,
    current: name === 'main',
    track: '',
    upstream: '',
  })
  const branches = [
    branch('main', 'main'),
    branch('topic', 'topic'),
    branch('origin/main', 'main', 'remote'),
  ]
  await test('hiding a ref removes only its exclusive history and keeps shared ancestors', () => {
    assert.deepEqual(
      visibleHistory(commits, branches, { hidden: ['refs/heads/topic'], solo: [] }).map(
        (c) => c.hash,
      ),
      ['main', 'base'],
    )
    assert.deepEqual(
      visibleHistory(commits, branches, { hidden: ['refs/heads/main'], solo: [] }),
      commits,
    )
    assert.deepEqual(
      visibleReferenceBranches({ hidden: ['refs/heads/main'], solo: [] }, branches).map(
        (b) => b.name,
      ),
      ['topic', 'origin/main'],
    )
  })
  await test('Solo unions selected histories, overrides their hide setting and ignores deleted refs', () => {
    assert.deepEqual(
      visibleHistory(commits, branches, {
        hidden: ['refs/heads/topic'],
        solo: ['refs/heads/topic'],
      }).map((c) => c.hash),
      ['topic', 'base'],
    )
    assert.deepEqual(
      visibleHistory(commits, branches, {
        hidden: [],
        solo: ['refs/heads/topic', 'refs/heads/main'],
      }),
      commits,
    )
    assert.deepEqual(
      visibleHistory(commits, branches, {
        hidden: ['refs/heads/deleted'],
        solo: ['refs/heads/deleted'],
      }),
      commits,
    )
    assert.equal(knownAncestor(commits, 'base', 'topic'), true)
    assert.equal(knownAncestor(commits, 'main', 'topic'), false)
  })
  await test('visibility preferences survive reload, are repository-scoped and never mutate refs or favorites', () => {
    setActivePinia(createPinia())
    let view = useGraphViewStore()
    const original = structuredClone(branches)
    view.toggleHide('/repo-a', branches[1])
    view.toggleSolo('/repo-a', branches[1])
    assert.equal(view.isVisible('/repo-a', branches[1], branches), true)
    assert.equal(view.soloActive('/repo-b', branches), false)
    setActivePinia(createPinia())
    view = useGraphViewStore()
    assert.equal(view.isHidden('/repo-a', branches[1]), true)
    assert.equal(view.isSolo('/repo-a', branches[1]), true)
    view.reset('/repo-a')
    assert.equal(view.isHidden('/repo-a', branches[1]), false)
    assert.equal(view.soloActive('/repo-a', branches), false)
    assert.deepEqual(branches, original)
  })

  await test('long-edge preference persists independently of branch filters and favorites', () => {
    setActivePinia(createPinia())
    let view = useGraphViewStore()
    assert.equal(view.showLongEdges, false)
    view.toggleLongEdges()
    setActivePinia(createPinia())
    view = useGraphViewStore()
    assert.equal(view.showLongEdges, true)
    assert.deepEqual(view.state('/other-repo'), { hidden: [], solo: [] })
    view.toggleLongEdges()
    assert.equal(view.showLongEdges, false)
  })
  await test('filtered history preserves permanent fragments and bridges only real hidden ancestry', async () => {
    const { ideaGraphLayout } = await vite.ssrLoadModule('/src/ideaGraphLayout.ts')
    const { buildHistoryGraph } = await vite.ssrLoadModule('/src/graph.ts')
    const { projectHistory } = await vite.ssrLoadModule('/src/graphVisibility.ts')
    const full = [
      { hash: 'main', parents: ['hidden'], subject: 'visible main' },
      { hash: 'other', parents: ['root'], subject: 'visible other' },
      { hash: 'hidden', parents: ['root'], subject: 'hidden' },
      { hash: 'root', parents: [], subject: 'visible root' },
    ].map((c) => ({
      ...c,
      author: 'test',
      email: 'test@example.invalid',
      date: '2026-11-09',
      refs: [],
    }))
    const refs = [branch('main', 'main'), branch('feature/other', 'other')]
    const original = structuredClone(full)
    const basis = ideaGraphLayout(full, refs).identities
    const before = buildHistoryGraph(full, [], false, false, refs, true, basis, full)
    const visible = full.filter((c) => c.hash !== 'hidden')
    const projected = projectHistory(full, visible)
    assert.deepEqual(projected.commits[0].parents, ['root'])
    assert.deepEqual([...projected.dotted], ['main:root'])
    const after = buildHistoryGraph(visible, [], false, false, refs, true, basis, full)
    assert.equal(after.edges.find((e) => e.childHash === 'main').parentHash, 'root')
    assert.equal(after.edges.find((e) => e.childHash === 'main').dotted, true)
    assert.ok(after.edges.every((e) => !e.boundary))
    for (const node of after.nodes)
      assert.equal(node.color, before.nodes.find((n) => n.hash === node.hash).color)
    assert.deepEqual(full, original)
    const directFull = [{ ...full[0], parents: ['hidden', 'root'] }, ...full.slice(1)]
    const direct = projectHistory(
      directFull,
      directFull.filter((c) => c.hash !== 'hidden'),
    )
    assert.equal(direct.dotted.size, 0, 'a direct edge takes precedence over a collapsed path')
    const rootOnly = buildHistoryGraph(full.slice(3), [], false, false, [], true, basis, full)
    assert.equal(rootOnly.nodes[0].color, before.nodes.find((n) => n.hash === 'root').color)
  })
  await test('Paged merge graphs terminate unknown parents locally and expand their real ancestry when loaded', async () => {
    const { buildGraph } = await vite.ssrLoadModule('/src/graph.ts')
    const commits = [
      { hash: 'merge', parents: ['base', 'side'] },
      { hash: 'side', parents: ['side-old'] },
      { hash: 'other', parents: ['base'] },
      { hash: 'side-old', parents: ['base'] },
      { hash: 'base', parents: [] },
    ]
    const before = buildGraph(commits.slice(0, 3), 0, undefined, true)
    const after = buildGraph(commits, 0, undefined, true)
    const identity = ({ hash, y, color }) => ({ hash, y, color })
    assert.deepEqual(before.nodes.map(identity), after.nodes.slice(0, 3).map(identity))
    // A NOT_LOAD_COMMIT occupies only the neighboring row, rather than a
    // guessed full lane through every unrelated commit in this page.
    assert.equal(before.nodes[2].x, 46)
    assert.equal(after.nodes[2].x, 68)
    assert.ok(before.edges.some((edge) => edge.boundary))
    assert.ok(after.edges.every((edge) => !edge.boundary))
    const search = buildGraph([
      { hash: 'one', parents: ['missing-one'] },
      { hash: 'two', parents: ['missing-two'] },
    ])
    assert.equal(search.width, 68)
  })
  await test('reference defaults are trailing GitKraken labels while explicit earlier choices survive restart', () => {
    storage.delete('gitcode.graph-label-style')
    storage.delete('gitcode.graph-labels-after-message')
    setActivePinia(createPinia())
    let view = useGraphViewStore()
    assert.equal(view.labelStyle, 'gitkraken')
    assert.equal(view.labelsAfterMessage, true)
    view.setLabelStyle('current')
    view.toggleLabelsAfterMessage()
    setActivePinia(createPinia())
    view = useGraphViewStore()
    assert.equal(view.labelStyle, 'current')
    assert.equal(view.labelsAfterMessage, false)
    storage.set('gitcode.graph-labels-after-message', 'malformed')
    setActivePinia(createPinia())
    assert.equal(useGraphViewStore().labelsAfterMessage, true)
    storage.delete('gitcode.graph-label-style')
    storage.delete('gitcode.graph-labels-after-message')
  })
  await test('label style persists independently of position and rejects invalid saved choices', () => {
    storage.delete('gitcode.graph-label-style')
    setActivePinia(createPinia())
    const view = useGraphViewStore()
    const position = view.labelsAfterMessage
    assert.equal(view.labelStyle, 'gitkraken')
    view.setLabelStyle('idea')
    assert.equal(view.labelsAfterMessage, position)
    assert.equal(storage.get('gitcode.graph-label-style'), 'idea')
    setActivePinia(createPinia())
    assert.equal(useGraphViewStore().labelStyle, 'idea')
    useGraphViewStore().setLabelStyle('not-a-style')
    assert.equal(useGraphViewStore().labelStyle, 'idea')
    storage.set('gitcode.graph-label-style', 'malformed')
    setActivePinia(createPinia())
    assert.equal(useGraphViewStore().labelStyle, 'gitkraken')
    storage.delete('gitcode.graph-label-style')
  })
} finally {
  await vite.close()
  if (previous === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previous
}
