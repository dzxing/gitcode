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
  const { conflictBlocks, resolveBlock } = await vite.ssrLoadModule('/src/mergeConflicts.ts')
  await test('resolving one block preserves non-conflicting content and other blocks', () => {
    const text =
      'before\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> incoming\nafter\n<<<<<<< HEAD\nsecond local\n=======\nsecond remote\n>>>>>>> incoming\n'
    const result = resolveBlock(text, 0, 'both')
    assert.ok(result.startsWith('before\nlocal\nremote\nafter\n'))
    assert.equal(conflictBlocks(result).length, 1)
    assert.ok(result.includes('second local\n=======\nsecond remote'))
  })
  await test('diff3 base is excluded from selected sides and CRLF is preserved', () => {
    const text =
      'prefix\r\n<<<<<<< HEAD\r\nlocal\r\n||||||| base\r\nbase\r\n=======\r\nremote\r\n>>>>>>> incoming\r\nsuffix\r\n'
    assert.equal(resolveBlock(text, 0, 'ours'), 'prefix\r\nlocal\r\nsuffix\r\n')
    assert.equal(resolveBlock(text, 0, 'theirs'), 'prefix\r\nremote\r\nsuffix\r\n')
  })
  await test('add/delete blocks and custom marker lengths retain precise text', () => {
    const text = '<<<<<<<< HEAD\n========\nremote\n>>>>>>>> incoming'
    assert.equal(resolveBlock(text, 0, 'ours'), '')
    assert.equal(resolveBlock(text, 0, 'theirs'), 'remote\n')
    assert.equal(resolveBlock('plain\n', 0, 'both'), 'plain\n')
  })
} finally {
  await vite.close()
}
