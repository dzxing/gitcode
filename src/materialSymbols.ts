import { mapping } from './assets/icons/material-symbols/manifest.json'

export type IconName = keyof typeof mapping

interface MaterialSymbol {
  name: string
  viewBox: string
  paths: string[]
}

// Only the checked-in Google SVGs enter the bundle. No icon-font or network request.
const sources = import.meta.glob<string>('./assets/icons/material-symbols/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const symbols = new Map<string, MaterialSymbol>()
for (const [file, svg] of Object.entries(sources)) {
  const name = file.split('/').pop()!
  const width = svg.match(/\bwidth="(\d+)"/)?.[1]
  const height = svg.match(/\bheight="(\d+)"/)?.[1]
  const viewBox =
    svg.match(/\bviewBox="([^"]+)"/)?.[1] || (width && height ? `0 0 ${width} ${height}` : '')
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1])
  if (!viewBox || !paths.length) throw new Error(`Invalid Material Symbol asset: ${name}`)
  symbols.set(name, { name, viewBox, paths })
}

export function materialSymbol(name: IconName, filled = false): MaterialSymbol {
  const file = name === 'Star' && filled ? 'star_fill1_24px.svg' : `${mapping[name]}_24px.svg`
  const symbol = symbols.get(file)
  if (!symbol) throw new Error(`Missing Material Symbol asset: ${file}`)
  return symbol
}
