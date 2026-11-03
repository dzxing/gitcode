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
} finally {
  await vite.close()
  if (previous === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previous
}
