// Keep the approved Photopea artwork as the source for every UI size.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

function artwork(file, directory) {
  const bytes = readFileSync(new URL(file, directory))
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== bytes.readUInt32BE(20) ||
    bytes.readUInt32BE(16) < 256 ||
    bytes[24] !== 8 ||
    bytes[25] !== 6 ||
    bytes[28] !== 0
  )
    throw new Error(`品牌源图必须是方形 8-bit RGBA PNG：${file}`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image width="1024" height="1024" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`
  // Decode before writing outputs: a corrupt image must not silently produce empty icons.
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render()
  if (!image.pixels.some((value, index) => index % 4 === 3 && value !== 0))
    throw new Error(`品牌源图无法解码或内容为空：${file}`)
  return { bytes, svg }
}

export function generateBrandUi(
  directory = new URL('../assets/', import.meta.url),
  sources = new URL('../source/orange-diamond/', import.meta.url),
) {
  const glyph = artwork('glyph-ui-1024.png', sources)
  const tile = artwork('tile-transparent.png', sources)
  // The orange glyph works on both backgrounds; preserve compatibility filenames.
  const outputs = new Map([
    ['logo-glyph-transparent.png', glyph.bytes],
    ['logo-glyph-light-1024.png', glyph.bytes],
    ['logo-master.png', tile.bytes],
  ])
  for (const [name, sizes] of [
    ['logo-glyph-transparent', [256, 512]],
    ['logo-glyph-light', [256, 512]],
    ['logo-ui-compact', [16, 20, 24, 32]],
  ])
    for (const size of sizes) {
      const image = new Resvg(glyph.svg, {
        fitTo: { mode: 'width', value: size },
        font: { loadSystemFonts: false },
      }).render()
      if (image.width !== size || image.height !== size) throw new Error(`图标尺寸错误：${name}`)
      outputs.set(`${name}-${size}.png`, image.asPng())
    }
  for (const [name, bytes] of outputs) writeFileSync(new URL(name, directory), bytes)
  return [...outputs.keys()]
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outputs = generateBrandUi()
  console.log(`Generated ${outputs.length} brand PNG assets from the approved Photopea artwork.`)
}
