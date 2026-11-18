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
  const { presentDiff } = await vite.ssrLoadModule('/src/diffPresentation.ts')
  await test('intraline decoration preserves patch text, line indices and numbers', () => {
    const patch = '--- a/x\n+++ b/x\n@@ -8,2 +10,2 @@\n-old value\n+new value\n context\n'
    const lines = presentDiff(patch)
    assert.equal(lines.map((line) => line.text).join('\n'), patch)
    assert.deepEqual(lines[3], {
      text: '-old value',
      type: 'remove',
      old: 8,
      next: '',
      change: { start: 1, end: 4 },
    })
    assert.equal(lines[4].next, 10)
    assert.equal(lines[5].old, 9)
    assert.equal(lines[5].next, 11)
  })
  await test('Unicode fragments do not split surrogate pairs and retain whitespace changes', () => {
    const lines = presentDiff('@@ -1,2 +1,2 @@\n-😀 = 1\n- a\n+😁 = 1\n+  a')
    assert.equal(lines[1].text.slice(lines[1].change.start, lines[1].change.end), '😀')
    assert.equal(lines[3].text.slice(lines[3].change.start, lines[3].change.end), '😁')
    assert.equal(lines[4].text.slice(lines[4].change.start, lines[4].change.end), ' ')
  })
  await test('unequal replacements, pure additions and deletions remain line-level', () => {
    const lines = presentDiff('@@ -1 +1,2 @@\n-old\n+new\n+extra')
    assert.ok(lines.every((line) => !line.change))
    assert.ok(presentDiff('@@ -0,0 +1 @@\n+new').every((line) => !line.change))
  })
  await test('hunk boundaries and missing newline metadata do not become replacements', () => {
    const lines = presentDiff(
      '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n@@ -9 +9 @@\n-c\n+d',
    )
    assert.equal(lines[2].type, 'meta')
    assert.equal(lines[1].change, undefined)
    assert.equal(lines[5].old, 9)
    assert.equal(lines[6].next, 9)
    assert.ok(lines[6].change)
  })
} finally {
  await vite.close()
}
