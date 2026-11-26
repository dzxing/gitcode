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
  const {
    collectWorktreeChanges,
    filterWorktreeChanges,
    buildWorktreeTree,
    worktreeSelectionState,
  } = await vite.ssrLoadModule('/src/features/changes/worktreeModel.ts')
  const { useWorktreeStore } = await vite.ssrLoadModule('/src/features/changes/stores/worktree.ts')

  await test('one logical file retains staged and local versions, rename origin and conflicts', () => {
    const files = collectWorktreeChanges(
      [
        { path: 'a.txt', status: 'M' },
        { path: 'new.txt', oldPath: 'old.txt', status: 'R' },
        { path: 'added.txt', status: 'A' },
      ],
      [
        { path: 'a.txt', status: 'M' },
        { path: 'new.txt', status: 'M' },
        { path: 'unknown.txt', status: '?' },
        { path: 'conflict.txt', status: 'U' },
        { path: 'deleted.txt', status: 'D' },
      ],
    )
    assert.equal(files.length, 6)
    const partial = files.find((file) => file.path === 'a.txt')
    assert.ok(partial.staged && partial.unstaged && partial.partial)
    const rename = files.find((file) => file.path === 'new.txt')
    assert.equal(rename.oldPath, 'old.txt')
    assert.equal(rename.status, 'R')
    assert.equal(rename.partial, true)
    const groups = buildWorktreeTree(files)
    assert.deepEqual(
      groups.map((group) => group.label),
      ['冲突', '变更', '未跟踪文件'],
    )
    assert.equal(groups.find((group) => group.key === 'changes').files.length, 4)
  })

  await test('directory compression preserves leaf identities and counts; lists retain full paths', () => {
    const files = collectWorktreeChanges(
      [],
      [
        { path: 'src/main/java/A.java', status: 'M' },
        { path: 'src/main/java/B.java', status: 'M' },
        { path: 'docs/readme.md', status: '?' },
      ],
    )
    const changes = buildWorktreeTree(files)[0]
    assert.equal(changes.children[0].label, 'src/main/java')
    assert.equal(changes.children[0].files.length, 2)
    assert.deepEqual(
      changes.children[0].children.map((node) => node.file.path),
      ['src/main/java/A.java', 'src/main/java/B.java'],
    )
    assert.equal(buildWorktreeTree(files, 'tree', false)[0].children[0].label, 'src')
    assert.deepEqual(
      buildWorktreeTree(files, 'list')[0].children.map((node) => node.path),
      ['src/main/java/A.java', 'src/main/java/B.java'],
    )
  })

  await test('filtering includes rename origins; group state concerns matching leaves independent of collapse', () => {
    const files = collectWorktreeChanges(
      [{ path: 'new/name.txt', oldPath: 'previous/name.txt', status: 'R' }],
      [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'M' },
        { path: 'src/conflict.ts', status: 'U' },
      ],
    )
    assert.equal(filterWorktreeChanges(files, 'previous').length, 1)
    const matching = filterWorktreeChanges(files, 'src/')
    assert.deepEqual(worktreeSelectionState(matching, new Set(['src/a.ts'])), {
      checked: false,
      mixed: true,
      disabled: false,
    })
    assert.deepEqual(worktreeSelectionState(matching, new Set(['src/a.ts', 'src/b.ts'])), {
      checked: true,
      mixed: false,
      disabled: false,
    })
    assert.equal(
      worktreeSelectionState(
        files.filter((file) => file.conflict),
        new Set(),
      ).disabled,
      true,
    )
  })

  await test('selection is repository scoped, filters do not discard hidden choices and new files remain unselected', () => {
    setActivePinia(createPinia())
    const store = useWorktreeStore()
    const files = collectWorktreeChanges(
      [],
      [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'M' },
      ],
    )
    store.reconcile('/one', files, 'main\0head')
    store.choose('/one', files, true)
    store.choose('/two', [files[0]], true)
    store.choose('/one', filterWorktreeChanges(files, 'a.ts'), false)
    assert.deepEqual([...store.selected('/one', files)], ['src/b.ts'])
    assert.deepEqual([...store.selected('/two', files)], ['src/a.ts'])
    const next = collectWorktreeChanges([], [...files, { path: 'src/new.ts', status: '?' }])
    store.reconcile('/one', next, 'main\0head')
    assert.deepEqual([...store.selected('/one', next)], ['src/b.ts'])
    store.reconcile(
      '/one',
      next.filter((file) => file.path !== 'src/b.ts'),
      'main\0head',
    )
    store.reconcile('/one', next, 'main\0head')
    assert.equal(store.selected('/one', next).size, 0)
  })

  await test('branch or HEAD changes require a new selection; restart restores view only', () => {
    setActivePinia(createPinia())
    const store = useWorktreeStore()
    const files = collectWorktreeChanges([], [{ path: 'a.txt', status: 'M' }])
    store.reconcile('/restart', files, 'main\0first')
    store.choose('/restart', files, true)
    assert.equal(store.reconcile('/restart', files, 'feature\0first'), true)
    assert.equal(store.selected('/restart', files).size, 0)
    store.choose('/restart', files, true)
    store.update('/restart', { layout: 'list', compress: false, mode: 'staging' })
    setActivePinia(createPinia())
    const restored = useWorktreeStore()
    assert.equal(restored.selected('/restart', files).size, 0)
    assert.equal(restored.view('/restart').layout, 'list')
    assert.equal(restored.view('/restart').compress, false)
    assert.equal(restored.view('/restart').mode, 'staging')
  })
} finally {
  globalThis.localStorage = originalStorage
  await vite.close()
}
