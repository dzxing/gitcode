// Offsets retain the original line separators and all non-conflicting content.
export function conflictBlocks(text: string, markerSize = 7) {
  const size =
    Number.isSafeInteger(markerSize) && markerSize > 0 && markerSize <= 262144 ? markerSize : 7
  const startMarker = new RegExp(`^<{${size},}(?: |$)`)
  const baseMarker = new RegExp(`^\\|{${size},}(?: |$)`)
  const separator = new RegExp(`^={${size},}\\r?$`)
  const endMarker = new RegExp(`^>{${size},}(?: |$)`)
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0])
  const blocks: { start: number; end: number; ours: string; theirs: string }[] = []
  let start = -1,
    oursStart = 0,
    oursEnd = -1,
    theirsStart = -1
  for (const line of lines) {
    const value = line[0].replace(/\r?\n$/, ''),
      offset = line.index
    if (startMarker.test(value) && start < 0) {
      start = offset
      oursStart = offset + line[0].length
      oursEnd = -1
      theirsStart = -1
    } else if (start >= 0 && baseMarker.test(value) && oursEnd < 0) oursEnd = offset
    else if (start >= 0 && separator.test(value)) {
      if (oursEnd < 0) oursEnd = offset
      theirsStart = offset + line[0].length
    } else if (start >= 0 && theirsStart >= 0 && endMarker.test(value)) {
      blocks.push({
        start,
        end: offset + line[0].length,
        ours: text.slice(oursStart, oursEnd),
        theirs: text.slice(theirsStart, offset),
      })
      start = -1
    }
  }
  return blocks
}
export function resolveBlock(
  text: string,
  index: number,
  side: 'ours' | 'theirs' | 'both',
  markerSize = 7,
) {
  const block = conflictBlocks(text, markerSize)[index]
  if (!block) return text
  const result = side === 'both' ? block.ours + block.theirs : block[side]
  return text.slice(0, block.start) + result + text.slice(block.end)
}
