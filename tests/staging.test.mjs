import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
const originalStorage = globalThis.localStorage
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
}
try {
  const { collectWorktreeChanges, filterWorktreeChanges, buildStagingTree, stagingSelectionState } =
    await vite.ssrLoadModule('/src/worktree.ts')
  const { useStagingStore } = await vite.ssrLoadModule('/src/stores/staging.ts')
  const files = collectWorktreeChanges(
    [],
    [
      { path: 'src/main/a.ts', status: 'M' },
      { path: 'src/main/b.ts', status: '?' },
      { path: 'src/conflict.ts', status: 'U' },
    ],
  )
  const aFile = files.find((file) => file.path === 'src/main/a.ts')
  const bFile = files.find((file) => file.path === 'src/main/b.ts')
  const conflict = files.find((file) => file.path === 'src/conflict.ts')
  await test('single-zone directory trees retain every file without status subgroup roots', () => {
    assert.deepEqual(
      buildStagingTree(files, 'unstaged').map((node) => node.path),
      ['src/main/a.ts', 'src/main/b.ts', 'src/conflict.ts'],
    )
    const tree = buildStagingTree(files, 'staged', 'tree')
    assert.equal(tree.length, 1)
    assert.equal(tree[0].kind, 'directory')
    assert.equal(tree[0].files.length, 3)
    assert.equal(tree[0].key.startsWith('staged:'), true)
    const compressed = buildStagingTree([aFile, bFile], 'unstaged', 'tree')
    assert.equal(compressed[0].label, 'src/main')
  })
  await test('search select-all includes descendants independent of collapse; conflicts can be staged as resolutions', () => {
    const matching = filterWorktreeChanges(files, 'main')
    assert.deepEqual(stagingSelectionState(matching, new Set(['src/main/a.ts'])), {
      checked: false,
      mixed: true,
      disabled: false,
    })
    assert.equal(
      stagingSelectionState(matching, new Set(matching.map((file) => file.path))).checked,
      true,
    )
    assert.equal(stagingSelectionState([conflict], new Set()).disabled, false)
  })
  await test('MM selections are independent by repository and zone; hidden and cross-tab choices survive', () => {
    setActivePinia(createPinia())
    const state = useStagingStore()
    const both = { staged: files, unstaged: files }
    state.reconcile('/one', both, 'main\0h1')
    state.choose('/one', 'unstaged', files, true)
    state.choose('/one', 'staged', [aFile], true)
    state.choose('/two', 'staged', [bFile], true)
    state.choose('/one', 'unstaged', filterWorktreeChanges(files, 'a.ts'), false)
    assert.deepEqual([...state.selected('/one', 'staged', files)], ['src/main/a.ts'])
    assert.deepEqual([...state.selected('/one', 'unstaged', files)].sort(), [
      'src/conflict.ts',
      'src/main/b.ts',
    ])
    assert.deepEqual([...state.selected('/two', 'staged', files)], ['src/main/b.ts'])
    state.update('/one', { query: 'no match', collapsed: ['unstaged:directory:src'] })
    assert.equal(state.selected('/one', 'unstaged', files).size, 2)
    state.reconcile('/one', both, 'main\0h1')
    assert.equal(state.selected('/one', 'staged', files).size, 1)
  })
  await test('refresh prunes only disappeared paths, leaves new files unchecked and HEAD clears both zones', () => {
    setActivePinia(createPinia())
    const state = useStagingStore()
    state.reconcile('/repo', { staged: files, unstaged: files }, 'main\0h1')
    state.choose('/repo', 'unstaged', files, true)
    state.choose('/repo', 'staged', files, true)
    const next = [bFile, conflict, { path: 'new.txt', status: '?' }]
    state.reconcile('/repo', { staged: files, unstaged: next }, 'main\0h1')
    assert.deepEqual([...state.selected('/repo', 'unstaged', next)].sort(), [
      'src/conflict.ts',
      'src/main/b.ts',
    ])
    assert.equal(state.selected('/repo', 'staged', files).size, 3)
    assert.equal(state.reconcile('/repo', { staged: files, unstaged: next }, 'other\0h1'), true)
    assert.equal(state.selected('/repo', 'staged', files).size, 0)
    assert.equal(state.selected('/repo', 'unstaged', next).size, 0)
  })
  await test('only view preferences persist; selected paths are never restored', () => {
    setActivePinia(createPinia())
    const state = useStagingStore()
    state.choose('/persist', 'staged', files, true)
    state.update('/persist', { layout: 'tree', compress: false })
    assert.deepEqual(JSON.parse(storage.get('gitcode.staging-view.v1'))['/persist'], {
      layout: 'tree',
      compress: false,
    })
    setActivePinia(createPinia())
    const next = useStagingStore()
    assert.equal(next.view('/persist').layout, 'tree')
    assert.equal(next.selected('/persist', 'staged', files).size, 0)
    assert.equal(next.view('/fresh').layout, 'list')
  })
} finally {
  await vite.close()
  globalThis.localStorage = originalStorage
}
