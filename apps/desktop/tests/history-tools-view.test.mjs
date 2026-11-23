import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
const savedWindow = globalThis.window
let handler
try {
  globalThis.window = {
    gitk: { runtime: async () => ({}), historyTools: (...args) => handler(...args) },
  }
  const { alignVersions } = await vite.ssrLoadModule('/src/versionComparison.ts')
  const { useHistoryToolsStore } = await vite.ssrLoadModule('/src/stores/historyTools.ts')
  const { useHistoryQueryStore } = await vite.ssrLoadModule('/src/stores/historyQuery.ts')
  await test('three-version alignment preserves every line, repeated lines, deletions and insertions', () => {
    for (const versions of [
      ['a\nb\nc', 'a\nc', 'a\nx\nc'],
      ['same\nsame\nend', 'same\nend', 'insert\nsame\nend'],
      [null, '', 'new\n'],
      [null, null, 'new'],
    ]) {
      const result = alignVersions(versions)
      assert.equal(result[0].length, result[1].length)
      assert.equal(result[1].length, result[2].length)
      versions.forEach((text, i) =>
        assert.deepEqual(
          result[i].filter((l) => l.number !== null).map((l) => l.text),
          text === null ? [] : text.split('\n'),
        ),
      )
    }
    const long = Array.from({ length: 1600 }, (_, i) => String(i)).join('\n')
    const result = alignVersions([long, long + '\nadded', long])
    assert.equal(result[1].filter((l) => l.number !== null).length, 1601)
    assert.ok(result[1].some((l) => l.changed))
  })
  await test('closing a file tab discards late responses and repository tabs restore independent active tools', async () => {
    setActivePinia(createPinia())
    const tools = useHistoryToolsStore()
    const finishes = []
    handler = () => new Promise((resolve) => finishes.push(resolve))
    tools.setContext('/repo-a', 1)
    tools.open('three', 'same.txt', 'a'.repeat(40))
    const keyA = tools.active
    tools.setContext('/repo-b', 2)
    tools.open('three', 'same.txt', 'b'.repeat(40))
    assert.notEqual(tools.active, keyA)
    tools.setContext('/repo-a', 1)
    assert.equal(tools.active, keyA)
    tools.close(tools.active)
    finishes[0]({ versions: [{ exists: true, text: 'late', binary: false }] })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(tools.tabs.filter((t) => t.repo === '/repo-a').length, 0)
  })
  await test('superseded history search cannot overwrite newer results and author filters stay in their repository tab', async () => {
    setActivePinia(createPinia())
    const query = useHistoryQueryStore()
    const pending = []
    handler = (_repo, request) =>
      request.kind === 'cancel'
        ? Promise.resolve({})
        : new Promise((resolve) => pending.push(resolve))
    query.configure('a', { repo: '/a', token: 'one', query: 'older', branch: '' }, true)
    query.filters.author = 'Author A'
    const old = query.read()
    query.configure('a', { repo: '/a', token: 'one', query: 'newer', branch: '' }, true)
    const latest = query.read()
    pending[1]({ commits: [{ hash: 'new' }], nextOffset: null })
    await latest
    pending[0]({ commits: [{ hash: 'old' }], nextOffset: null })
    await old
    assert.equal(query.commits[0].hash, 'new')
    query.configure('b', { repo: '/b', token: 'two', query: '', branch: '' }, false)
    assert.equal(query.filters.author, '')
    query.filters.author = 'Author B'
    query.configure('a', { repo: '/a', token: 'one', query: '', branch: '' }, false)
    assert.equal(query.filters.author, 'Author A')
  })
} finally {
  globalThis.window = savedWindow
  await vite.close()
}
