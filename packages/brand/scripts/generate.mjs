// Rebuild every transparent mark from the single checked-in vector.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

function replaceOnce(source, value, replacement) {
  if (source.split(value).length !== 2)
    throw new Error(`品牌源图结构已变化，无法唯一定位 ${value}；请同步调整生成规则。`)
  return source.replace(value, replacement)
}

export function generateBrandUi(directory = new URL('../assets/', import.meta.url)) {
  const source = readFileSync(new URL('logo-glyph-transparent.svg', directory), 'utf8')
  const compact = replaceOnce(
    replaceOnce(
      replaceOnce(source, 'width="1024" height="1024"', 'width="64" height="64"'),
      'stroke-width="1.2"',
      'stroke-width="1.6"',
    ),
    'r="2.2"',
    'r="2.5"',
  )
  if (!source.includes('#f4f8ff')) throw new Error('品牌源图缺少预期节点颜色，请同步调整生成规则。')
  const light = source.replaceAll('#f4f8ff', '#243247')
  const variants = [
    ['logo-glyph-transparent', source, [256, 512, 1024]],
    ['logo-glyph-light', light, [256, 512, 1024]],
    ['logo-ui-compact', compact, [16, 20, 24, 32]],
  ]
  // Render and validate everything before writing any derived assets.
  const outputs = new Map([
    ['logo-ui-compact.svg', compact],
    ['logo-glyph-light.svg', light],
  ])
  for (const [name, svg, sizes] of variants)
    for (const size of sizes) {
      const image = new Resvg(svg, {
        fitTo: { mode: 'width', value: size },
        font: { loadSystemFonts: false },
      }).render()
      if (image.width !== size || image.height !== size) throw new Error(`图标尺寸错误：${name}`)
      const file =
        name === 'logo-glyph-transparent' && size === 1024 ? `${name}.png` : `${name}-${size}.png`
      outputs.set(file, image.asPng())
    }
  for (const [name, bytes] of outputs) writeFileSync(new URL(name, directory), bytes)
  return [...outputs.keys()]
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outputs = generateBrandUi()
  console.log(`Generated ${outputs.length} transparent SVG/PNG assets from the brand source.`)
}
