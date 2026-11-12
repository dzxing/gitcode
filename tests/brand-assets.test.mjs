import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { generateBrandUi } from '../scripts/prepare-brand-ui.mjs'

test('brand rebuild recovers missing PNGs, follows source edits and preserves transparent holes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitcode-brand-assets-'))
  const url = pathToFileURL(directory + sep)
  try {
    const source = await readFile(
      new URL('../assets/brand/logo-glyph-transparent.svg', import.meta.url),
      'utf8',
    )
    await writeFile(join(directory, 'logo-glyph-transparent.svg'), source)
    const generated = generateBrandUi(url)
    assert.equal(generated.length, 12)
    const baseline = new Map()
    for (const file of generated) baseline.set(file, await readFile(join(directory, file)))
    for (const [file, png] of baseline) {
      if (!file.endsWith('.png')) continue
      const size =
        file === 'logo-glyph-transparent.png' ? 1024 : Number(file.match(/-(\d+)\.png$/)[1])
      assert.equal(png.readUInt32BE(16), size)
      assert.equal(png.readUInt32BE(20), size)
    }
    for (const [file, color] of [
      ['logo-glyph-transparent.png', [244, 248, 255]],
      ['logo-glyph-light-1024.png', [36, 50, 71]],
    ]) {
      const png = baseline.get(file)
      const image = new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image width="1024" height="1024" href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
      ).render()
      const pixels = image.pixels
      const pixel = (x, y) => [...pixels.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)]
      for (const [x, y] of [
        [0, 0],
        [1023, 1023],
        [589, 386],
        [589, 647],
      ])
        assert.equal(pixel(x, y)[3], 0, `${file}: corner or ring hole is opaque`)
      assert.deepEqual(pixel(410, 514), [...color, 255], `${file}: node contrast variant is wrong`)
    }
    for (const file of generated) await rm(join(directory, file))
    generateBrandUi(url)
    for (const [file, original] of baseline)
      assert.deepEqual(await readFile(join(directory, file)), original)
    await writeFile(
      join(directory, 'logo-glyph-transparent.svg'),
      source.replace('#00e7e7', '#ff0055'),
    )
    generateBrandUi(url)
    for (const [file, original] of baseline)
      if (file.endsWith('.png'))
        assert.notDeepEqual(
          await readFile(join(directory, file)),
          original,
          `${file} was stale after source edit`,
        )
    assert.equal((await readdir(directory)).length, generated.length + 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an incompatible source fails explicitly without partially replacing derived assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitcode-brand-invalid-'))
  try {
    const source = await readFile(
      new URL('../assets/brand/logo-glyph-transparent.svg', import.meta.url),
      'utf8',
    )
    await writeFile(
      join(directory, 'logo-glyph-transparent.svg'),
      source.replace('stroke-width="1.2"', 'stroke-width="2"'),
    )
    await writeFile(join(directory, 'logo-ui-compact.svg'), 'previous valid output')
    assert.throws(() => generateBrandUi(pathToFileURL(directory + sep)), /源图结构已变化/)
    assert.equal(
      await readFile(join(directory, 'logo-ui-compact.svg'), 'utf8'),
      'previous valid output',
    )
    assert.equal((await readdir(directory)).length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
