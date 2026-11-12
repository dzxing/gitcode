import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
const root = new URL('../src/assets/icons/material-symbols/', import.meta.url)
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'))

test('bundled Google symbols match the pinned upstream blobs without path edits', async () => {
  assert.match(manifest.commit, /^[a-f0-9]{40}$/)
  assert.equal(manifest.license, 'Apache-2.0')
  assert.deepEqual(manifest.failures, [])
  const files = new Set()
  for (const item of manifest.files) {
    const bytes = await fs.readFile(new URL(item.file, root))
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.sha256, item.file)
    assert.equal(
      crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      item.blobSha,
      item.file,
    )
    const svg = bytes.toString('utf8')
    assert.match(svg, /viewBox="0 -960 960 960"|height="24"[^>]*width="24"/)
    assert.match(svg, /<path d="[^"]+"/)
    assert.doesNotMatch(svg, /<(?:script|image|foreignObject|use)\b|\bonload=|\bhref=/i)
    files.add(item.file)
  }
  for (const name of Object.values(manifest.mapping)) assert.ok(files.has(`${name}_24px.svg`), name)
  assert.ok(files.has('star_fill1_24px.svg'))
  assert.deepEqual(new Set((await fs.readdir(root)).filter((name) => name.endsWith('.svg'))), files)
})

test('Google license and notice are included by desktop packaging rules', async () => {
  const license = await fs.readFile(
    new URL('../third-party/google-material-symbols/LICENSE.txt', import.meta.url),
    'utf8',
  )
  const notice = await fs.readFile(
    new URL('../third-party/google-material-symbols/NOTICE.txt', import.meta.url),
    'utf8',
  )
  assert.match(license, /Apache License/)
  assert.match(notice, new RegExp(manifest.commit))
  const config = JSON.parse(
    await fs.readFile(new URL('../electron-builder.json', import.meta.url), 'utf8'),
  )
  assert.ok(config.files.includes('third-party/**/*'))
})
