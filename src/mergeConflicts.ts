// Offsets retain the original line separators and all non-conflicting content.
export function conflictBlocks(text: string) {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0])
  const blocks: { start: number; end: number; ours: string; theirs: string }[] = []
  let start = -1,
    oursStart = 0,
    oursEnd = -1,
    theirsStart = -1
  for (const line of lines) {
    const value = line[0].replace(/\r?\n$/, ''),
      offset = line.index
    if (/^<{7,}(?: |$)/.test(value) && start < 0) {
      start = offset
      oursStart = offset + line[0].length
      oursEnd = -1
      theirsStart = -1
    } else if (start >= 0 && /^\|{7,}(?: |$)/.test(value) && oursEnd < 0) oursEnd = offset
    else if (start >= 0 && /^={7,}\r?$/.test(value)) {
      if (oursEnd < 0) oursEnd = offset
      theirsStart = offset + line[0].length
    } else if (start >= 0 && theirsStart >= 0 && /^>{7,}(?: |$)/.test(value)) {
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
export function resolveBlock(text: string, index: number, side: 'ours' | 'theirs' | 'both') {
  const block = conflictBlocks(text)[index]
  if (!block) return text
  const result = side === 'both' ? block.ours + block.theirs : block[side]
  return text.slice(0, block.start) + result + text.slice(block.end)
}
