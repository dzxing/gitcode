import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { generateBrandUi } from '@gitcode/brand/generate'

const sourceUrl = new URL('../../../packages/brand/source/orange-diamond/', import.meta.url)
const directoryUrl = (directory) => pathToFileURL(directory + sep)
async function fixture(directory) {
  const sources = join(directory, 'source')
  const outputs = join(directory, 'assets')
  await mkdir(sources)
  await mkdir(outputs)
  for (const name of ['glyph-ui-1024.png', 'tile-transparent.png'])
    await writeFile(join(sources, name), await readFile(new URL(name, sourceUrl)))
  return { sources, outputs }
}
function decode(png, size) {
  return new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
  ).render().pixels
}

test('brand rebuild preserves approved artwork, transparent gaps and follows source edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitcode-brand-assets-'))
  try {
    const { sources, outputs } = await fixture(directory)
    const generate = () => generateBrandUi(directoryUrl(outputs), directoryUrl(sources))
    const generated = generate()
    assert.equal(generated.length, 11)
    const baseline = new Map()
    for (const file of generated) baseline.set(file, await readFile(join(outputs, file)))
    assert.deepEqual(
      baseline.get('logo-glyph-transparent.png'),
      await readFile(join(sources, 'glyph-ui-1024.png')),
    )
    assert.deepEqual(
      baseline.get('logo-master.png'),
      await readFile(join(sources, 'tile-transparent.png')),
    )
    for (const [file, png] of baseline) {
      if (file === 'logo-master.png') continue
      const size =
        file === 'logo-glyph-transparent.png' ? 1024 : Number(file.match(/-(\d+)\.png$/)[1])
      assert.equal(png.readUInt32BE(16), size)
      assert.equal(png.readUInt32BE(20), size)
    }
    for (const file of ['logo-glyph-transparent.png', 'logo-glyph-light-1024.png']) {
      const pixels = decode(baseline.get(file), 1024)
      const pixel = (x, y) => [...pixels.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)]
      for (const [x, y] of [
        [0, 0],
        [1023, 1023],
        [512, 600],
        [285, 406],
      ])
        assert.equal(pixel(x, y)[3], 0, `${file}: corner or face gap is opaque`)
      for (const [x, y] of [
        [512, 200],
        [280, 560],
        [740, 560],
      ]) {
        const [r, g, b, a] = pixel(x, y)
        assert.equal(a, 255)
        assert.ok(r > g + 50 && r > b + 60, `${file}: missing orange/red face`)
      }
    }
    for (const file of generated) await rm(join(outputs, file))
    generate()
    for (const [file, original] of baseline)
      assert.deepEqual(await readFile(join(outputs, file)), original)
    const edited = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="512" cy="512" r="400" fill="#ff0055"/></svg>',
    )
      .render()
      .asPng()
    await writeFile(join(sources, 'glyph-ui-1024.png'), edited)
    generate()
    for (const [file, original] of baseline)
      if (file === 'logo-master.png')
        assert.deepEqual(await readFile(join(outputs, file)), original)
      else assert.notDeepEqual(await readFile(join(outputs, file)), original, `${file} is stale`)
    assert.equal((await readdir(outputs)).length, generated.length)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid or corrupt artwork cannot partially replace valid assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitcode-brand-invalid-'))
  try {
    const { sources, outputs } = await fixture(directory)
    await writeFile(join(outputs, 'logo-glyph-transparent.png'), 'previous valid output')
    const tilePath = join(sources, 'tile-transparent.png')
    const tile = await readFile(tilePath)
    for (const invalid of [Buffer.from('not a PNG'), tile.subarray(0, 33)]) {
      await writeFile(tilePath, invalid)
      assert.throws(() => generateBrandUi(directoryUrl(outputs), directoryUrl(sources)), /品牌源图/)
      assert.equal(
        await readFile(join(outputs, 'logo-glyph-transparent.png'), 'utf8'),
        'previous valid output',
      )
      assert.deepEqual(await readdir(outputs), ['logo-glyph-transparent.png'])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native ICO and ICNS carry the same new tile as the PNG icons', async () => {
  const iconDirectory = new URL('../public/brand/', import.meta.url)
  const ico = await readFile(new URL('favicon.ico', iconDirectory))
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 9)
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16
    const size = ico[entry] || 256
    const offset = ico.readUInt32LE(entry + 12)
    assert.equal(ico.readUInt16LE(entry + 6), 32)
    assert.equal(ico.readUInt32LE(offset), 40)
    assert.equal(ico.readInt32LE(offset + 4), size)
    assert.equal(ico.readInt32LE(offset + 8), size * 2)
    const png = await readFile(new URL(`icon-${size}.png`, iconDirectory))
    const pixels = decode(png, size)
    let warmPixels = 0
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const p = (y * size + x) * 4
        const q = offset + 40 + ((size - 1 - y) * size + x) * 4
        assert.equal(ico[q + 3], pixels[p + 3])
        // Resvg exposes premultiplied pixels; a DIB stores straight BGRA.
        for (const [dibChannel, pngChannel] of [
          [0, 2],
          [1, 1],
          [2, 0],
        ])
          assert.ok(
            Math.abs(
              Math.round((ico[q + dibChannel] * ico[q + 3]) / 255) - pixels[p + pngChannel],
            ) <= 1,
            `ICO/PNG color mismatch at ${size}px (${x}, ${y})`,
          )
        if (pixels[p + 3] > 200 && pixels[p] > pixels[p + 1] + 50) warmPixels++
      }
    assert.ok(warmPixels > size * size * 0.1, `missing orange tile glyph at ${size}px`)
    assert.equal(pixels[3], 0)
  }
  const icns = await readFile(new URL('../assets/icon.icns', import.meta.url))
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  const expected = new Map([
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ])
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString('ascii', offset, offset + 4)
    const length = icns.readUInt32BE(offset + 4)
    assert.ok(expected.has(type))
    assert.deepEqual(
      icns.subarray(offset + 8, offset + length),
      await readFile(new URL(`icon-${expected.get(type)}.png`, iconDirectory)),
    )
    expected.delete(type)
    offset += length
  }
  assert.equal(expected.size, 0)
})
