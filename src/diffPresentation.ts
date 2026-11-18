// Presentation only: indices and original patch text stay unchanged for partial staging.
export type DiffLine = {
  text: string
  type: 'meta' | 'hunk' | 'add' | 'remove' | 'context'
  old: number | ''
  next: number | ''
  change?: { start: number; end: number }
}

export function presentDiff(diff: string): DiffLine[] {
  let old = 0,
    next = 0,
    inside = false
  const lines: DiffLine[] = diff.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
    if (hunk) {
      inside = true
      old = Number(hunk[1])
      next = Number(hunk[2])
      return { text, type: 'hunk', old: '', next: '' }
    }
    if (!inside || text.startsWith('\\')) return { text, type: 'meta', old: '', next: '' }
    const type = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context'
    return { text, type, old: type === 'add' ? '' : old++, next: type === 'remove' ? '' : next++ }
  })
  // Pair only equally sized replacement runs. Unequal runs retain honest line-level colors.
  // Common prefix/suffix is linear, including for very long generated lines.
  for (let i = 0; i < lines.length;) {
    if (lines[i].type !== 'remove') {
      i++
      continue
    }
    const start = i
    while (lines[i]?.type === 'remove') i++
    const middle = i
    while (lines[i]?.type === 'add') i++
    if (middle - start !== i - middle) continue
    for (let j = 0; j < middle - start; j++) {
      const before = lines[start + j],
        after = lines[middle + j]
      // Code points keep emoji/surrogate pairs intact when text nodes are split.
      const a = Array.from(before.text.slice(1)),
        b = Array.from(after.text.slice(1))
      let prefix = 0,
        suffix = 0
      while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
      while (
        suffix < Math.min(a.length, b.length) - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
      )
        suffix++
      for (const [line, chars] of [
        [before, a],
        [after, b],
      ] as const) {
        const start = 1 + chars.slice(0, prefix).join('').length,
          end = line.text.length - chars.slice(chars.length - suffix).join('').length
        if (end > start) line.change = { start, end }
      }
    }
  }
  return lines
}
