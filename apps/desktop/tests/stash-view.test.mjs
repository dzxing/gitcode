import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
const originalWindow = globalThis.window,
  originalStorage = globalThis.localStorage
let read, action, snapshot
const metadata = {
  files: [{ path: 'a.txt', status: 'M' }],
  stagedPaths: ['a.txt'],
  base: 'a'.repeat(40),
  diff: null,
  indexDiff: null,
}
const flush = () => new Promise(setImmediate)
globalThis.window = {
  gitk: {
    runtime: async () => ({}),
    stashRead: (...args) => read(...args),
    action: (...args) => action(...args),
    snapshot: (...args) => snapshot(...args),
  },
}
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
try {
  const { useRepositoryStore } = await vite.ssrLoadModule('/src/stores/repository.ts')
  const { useStashStore } = await vite.ssrLoadModule('/src/stores/stash.ts')
  const entry = {
    oid: 'b'.repeat(40),
    ref: 'stash@{0}',
    message: 'On main: test',
    branch: 'main',
    date: '2026-10-29T00:00:00Z',
    base: 'a'.repeat(40),
  }
  function setup() {
    setActivePinia(createPinia())
    const repo = useRepositoryStore()
    repo.repo = {
      ...repo.repo,
      path: '/repo',
      head: 'a'.repeat(40),
      branch: 'main',
      staged: [],
      unstaged: [],
      gitflow: undefined,
      stashes: [entry],
      stashSignature: 'sig',
    }
    repo.tabs = [{ id: 1, kind: 'repository', name: 'One', path: '/repo' }]
    read = async (_repo, _oid, file) =>
      structuredClone(
        file
          ? {
              ...metadata,
              diff: { diff: '+working', truncated: false },
              indexDiff: { diff: '+index', truncated: false },
            }
          : metadata,
      )
    action = async () => {
      throw new Error('unexpected action')
    }
    snapshot = async () => JSON.parse(JSON.stringify(repo.repo))
    return { repo, stash: useStashStore() }
  }
  await test('creation options stay inline, retain their explicit scope and never open a modal', () => {
    const { repo, stash } = setup()
    repo.repo.unstaged = [{ path: 'new.txt', status: '?' }]
    stash.includeUntracked = false
    assert.ok(stash.createBlocked)
    assert.equal(stash.createEntryBlocked, '')
    stash.openCreate()
    assert.equal(stash.creating, true)
    assert.equal(stash.includeUntracked, false)
    assert.equal(repo.modal, null)
    stash.includeUntracked = true
    assert.equal(stash.count, 1)
    repo.repo.unstaged = [{ path: 'conflict.txt', status: 'U' }]
    assert.match(stash.createEntryBlocked, /冲突/)
  })
  await test('only WIP enables creation; stash and historical selections are mutually exclusive', async () => {
    const { repo, stash } = setup()
    repo.repo.unstaged = [{ path: 'a', status: 'M' }]
    assert.equal(stash.createEntryBlocked, '')
    repo.selectedCommit = {
      hash: 'a'.repeat(40),
      parents: [],
      subject: 'fixture',
      author: 'Test',
      email: 'test@test.local',
      date: '2026-10-30T00:00:00Z',
      refs: [],
    }
    assert.match(stash.createEntryBlocked, /WIP/)
    stash.openCreate()
    assert.equal(stash.creating, false)
    stash.openList(entry)
    await flush()
    assert.equal(repo.modal, null)
    assert.equal(repo.selectedCommit, null)
    assert.equal(repo.selectedStash.oid, entry.oid)
    assert.match(stash.createEntryBlocked, /WIP/)
    assert.match(repo.commitContextBlocked, /返回工作区/)
    repo.clearSelection()
    await nextTick()
    assert.equal(repo.selectedStash, null)
    assert.equal(stash.details, null)
    assert.equal(stash.createEntryBlocked, '')
  })
  await test('late preview responses cannot cross repository boundaries or WIP selection', async () => {
    const { repo, stash } = setup()
    let resolve
    read = () =>
      new Promise((done) => {
        resolve = done
      })
    stash.openList(entry)
    repo.repo = { ...repo.repo, path: '/other' }
    await nextTick()
    resolve(metadata)
    await flush()
    assert.equal(stash.details, null)
    assert.equal(stash.selected, null)
    assert.equal(repo.modal, null)
    const next = setup()
    read = () =>
      new Promise((done) => {
        resolve = done
      })
    next.stash.openList(entry)
    next.repo.clearSelection()
    await nextTick()
    resolve(metadata)
    await flush()
    assert.equal(next.stash.details, null)
    assert.equal(next.repo.selectedFile, null)
  })
  await test('stash file previews reuse the diff state and closing a pending diff cannot reopen it', async () => {
    const { repo, stash } = setup()
    stash.openList(entry)
    await flush()
    assert.equal(repo.selectedFile, null)
    await stash.preview('a.txt')
    assert.equal(repo.diffText, '+working')
    stash.setSource('staged')
    assert.equal(repo.diffText, '+index')
    assert.equal(repo.stashDiffSource, 'staged')
    let resolve
    read = () =>
      new Promise((done) => {
        resolve = done
      })
    const pending = stash.preview('a.txt')
    repo.closeDiff()
    resolve({ ...metadata, diff: { diff: '+late', truncated: false } })
    await pending
    assert.equal(repo.selectedFile, null)
    assert.equal(repo.diffText, '')
    assert.equal(repo.diffLoading, false)
    assert.equal(repo.selectedStash.oid, entry.oid)
  })
  await test('direct creation uses full scope and keeps commit drafts without a dialog', async () => {
    const { repo, stash } = setup()
    repo.repo.unstaged = [{ path: 'file.txt', status: 'M' }]
    repo.commitMessage = 'Draft'
    repo.commitDescription = 'Details'
    let request
    action = async (_path, value) => {
      request = value
      return {
        snapshot: { ...repo.repo, unstaged: [], stashes: [entry], stashSignature: 'new' },
        outcome: 'succeeded',
        output: '',
      }
    }
    stash.message = 'Task'
    await stash.create()
    assert.equal(request.action, 'stash-create')
    assert.equal(request.stashSignature, 'sig')
    assert.equal(request.includeUntracked, true)
    assert.equal(request.paths, undefined)
    assert.equal(repo.commitMessage, 'Draft')
    assert.equal(repo.commitDescription, 'Details')
    assert.equal(repo.modal, null)
  })
  await test('right-click Pop executes without opening a dialog and conflicts remain in the panel', async () => {
    const { repo, stash } = setup()
    repo.commitMessage = 'Draft'
    let writes = 0
    action = async (_path, request) => {
      writes++
      assert.equal(request.restoreIndex, false)
      return {
        snapshot: { ...repo.repo, unstaged: [{ path: 'a', status: 'U' }] },
        outcome: 'partial',
        output: '',
        error: 'conflict',
        warning: '记录保留，请解决冲突',
      }
    }
    stash.openList(entry)
    await flush()
    assert.equal(stash.restoreIndex, false)
    stash.openList(entry, 'stash-pop')
    await flush()
    assert.equal(writes, 1)
    assert.equal(repo.modal, null)
    assert.equal(repo.commitMessage, 'Draft')
    assert.match(stash.error, /记录保留/)
    assert.match(stash.restoreBlocked, /冲突/)
    assert.equal(stash.entries.length, 1)
    assert.equal(repo.selectedStash.oid, entry.oid)
  })
  await test('unstaged restoration requires explicit confirmation and staging still blocks it', async () => {
    const { repo, stash } = setup()
    repo.repo.unstaged = [{ path: 'local.txt', status: '?' }]
    let writes = 0
    action = async (_path, request) => {
      writes++
      assert.equal(request.confirmUnstaged, true)
      return { snapshot: { ...repo.repo }, outcome: 'succeeded', output: '' }
    }
    stash.openList(entry, 'stash-apply')
    await flush()
    assert.equal(writes, 0)
    assert.equal(stash.pendingRestore.operation, 'stash-apply')
    stash.cancelRestore()
    assert.equal(stash.pendingRestore, null)
    assert.equal(writes, 0)
    await stash.restore('stash-pop')
    repo.repo.unstaged.push({ path: 'newer.txt', status: '?' })
    assert.equal(await stash.confirmRestore(), false)
    assert.match(stash.error, /已变化/)
    assert.equal(writes, 0)
    await stash.restore('stash-apply')
    assert.equal(await stash.confirmRestore(), true)
    assert.equal(writes, 1)
    stash.openList(entry)
    await flush()
    repo.repo.staged = [{ path: 'staged.txt', status: 'M' }]
    assert.match(stash.restoreBlocked, /已暂存/)
    assert.equal(await stash.restore('stash-apply'), false)
    assert.equal(writes, 1)
  })
  await test('changing the selected stash or repository cancels pending restore consent', async () => {
    const { repo, stash } = setup()
    repo.repo.unstaged = [{ path: 'local.txt', status: '?' }]
    stash.openList(entry, 'stash-pop')
    await flush()
    assert.ok(stash.pendingRestore)
    repo.clearSelection()
    await nextTick()
    assert.equal(stash.pendingRestore, null)
    assert.equal(await stash.confirmRestore(), false)
    stash.openList(entry, 'stash-apply')
    await flush()
    repo.repo = { ...repo.repo, path: '/other' }
    await nextTick()
    assert.equal(stash.pendingRestore, null)
    assert.equal(await stash.confirmRestore(), false)
  })
  await test('changed restoration targets require explicit recheck; preview alone does not authorize a new target', async () => {
    const { repo, stash } = setup()
    stash.openList(entry)
    await flush()
    repo.repo.head = 'c'.repeat(40)
    assert.equal(stash.stale, true)
    assert.match(stash.restoreBlocked, /重新核对/)
    await stash.preview('a.txt')
    assert.equal(stash.stale, true)
    await stash.recheck()
    assert.equal(stash.stale, false)
    assert.equal(stash.restoreBlocked, '')
  })
  await test('deletion is the only modal and a changed list invalidates its frozen target', async () => {
    const { repo, stash } = setup()
    stash.openList(entry, 'stash-drop')
    await flush()
    assert.equal(repo.modal, 'stash-delete')
    assert.equal(stash.deleteTarget.entry.oid, entry.oid)
    repo.repo.stashSignature = 'external'
    await stash.confirmDelete()
    assert.match(stash.error, /已变化/)
    assert.equal(repo.modal, 'stash-delete')
    stash.closeDelete()
    await nextTick()
    assert.equal(stash.deleteTarget, null)
  })
  await test('returning to a repository tab reloads stash metadata and preserves the diff source and commit draft', async () => {
    const { repo, stash } = setup()
    repo.commitMessage = 'Draft'
    stash.openList(entry)
    await flush()
    await stash.preview('a.txt')
    stash.setSource('staged')
    repo.newTab()
    await nextTick()
    assert.equal(stash.selected, null)
    repo.activateTab(1)
    await flush()
    await flush()
    assert.equal(repo.selectedStash.oid, entry.oid)
    assert.equal(repo.stashDiffSource, 'staged')
    assert.equal(repo.diffText, '+index')
    assert.equal(repo.commitMessage, 'Draft')
    assert.equal(repo.modal, null)
  })
} finally {
  await vite.close()
  globalThis.window = originalWindow
  globalThis.localStorage = originalStorage
}
