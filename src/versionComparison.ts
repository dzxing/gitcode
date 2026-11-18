// Align both comparisons around the index, so all three panes share row positions.
// Bound quadratic work for generated/minified files; the fallback marks the
// unmatched middle as changed rather than claiming a false line correspondence.
function pair(base: string[], other: string[]) {
  const rows: [number | null, number | null][] = []
  if (base.length * other.length > 2_000_000) {
    let start = 0,
      end = 0
    while (start < Math.min(base.length, other.length) && base[start] === other[start]) {
      rows.push([start, start])
      start++
    }
    while (
      end < Math.min(base.length, other.length) - start &&
      base[base.length - end - 1] === other[other.length - end - 1]
    )
      end++
    for (let i = start; i < base.length - end; i++) rows.push([i, null])
    for (let i = start; i < other.length - end; i++) rows.push([null, i])
    for (let i = end; i > 0; i--) rows.push([base.length - i, other.length - i])
    return rows
  }
  const width = other.length + 1
  const lengths = new Uint32Array((base.length + 1) * width)
  for (let i = base.length - 1; i >= 0; i--)
    for (let j = other.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        base[i] === other[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
  let i = 0,
    j = 0
  while (i < base.length || j < other.length) {
    if (i < base.length && j < other.length && base[i] === other[j]) rows.push([i++, j++])
    else if (
      i < base.length &&
      (j === other.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    )
      rows.push([i++, null])
    else rows.push([null, j++])
  }
  return rows
}
export interface ComparisonLine {
  text: string
  number: number | null
  changed: boolean
}
export function alignVersions(versions: (string | null)[]): ComparisonLine[][] {
  const contents = [0, 1, 2].map((i) =>
    versions[i] === null || versions[i] === undefined ? [] : versions[i].split('\n'),
  )
  const index = contents[1]
  function map(other: string[]) {
    const matched = new Map<number, number | null>(),
      gaps = new Map<number, number[]>()
    let position = 0
    for (const [base, compared] of pair(index, other)) {
      if (base === null) {
        const values = gaps.get(position) || []
        values.push(compared!)
        gaps.set(position, values)
      } else {
        matched.set(base, compared)
        position = base + 1
      }
    }
    return { matched, gaps }
  }
  const head = map(contents[0]),
    working = map(contents[2]),
    result: ComparisonLine[][] = [[], [], []]
  function append(numbers: (number | null)[]) {
    const values = numbers.map((n, i) => (n === null ? null : contents[i][n]))
    const changed = [
      values[0] !== values[1],
      values[1] !== values[0] || values[1] !== values[2],
      values[2] !== values[1],
    ]
    numbers.forEach((number, i) =>
      result[i].push({
        text: values[i] ?? '',
        number: number === null ? null : number + 1,
        changed: changed[i],
      }),
    )
  }
  for (let i = 0; i <= index.length; i++) {
    const left = head.gaps.get(i) || [],
      right = working.gaps.get(i) || []
    for (let j = 0; j < Math.max(left.length, right.length); j++)
      append([left[j] ?? null, null, right[j] ?? null])
    if (i < index.length) append([head.matched.get(i) ?? null, i, working.matched.get(i) ?? null])
  }
  return result
}
