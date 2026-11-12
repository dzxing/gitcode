export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type PreferenceEntries = Record<string, string>

// Preview does not write storage. Apply commits the changed preferences together,
// restoring previous values if one write fails. Reject external changes found before writing.
export function commitPreferences(
  storage: PreferenceStorage,
  changes: PreferenceEntries,
  expected: Record<string, string | null>,
) {
  const previous = Object.fromEntries(
    Object.keys(changes).map((key) => {
      const value = storage.getItem(key)
      if (value !== expected[key])
        throw new Error('设置已在其他窗口更新，请取消并重新打开设置后再修改。')
      return [key, value]
    }),
  )
  const written: string[] = []
  try {
    for (const [key, value] of Object.entries(changes)) {
      storage.setItem(key, value)
      written.push(key)
    }
  } catch {
    let restored = true
    for (const key of written.reverse()) {
      try {
        const value = previous[key]
        if (value === null) storage.removeItem(key)
        else storage.setItem(key, value)
      } catch {
        restored = false
      }
    }
    throw new Error(
      restored
        ? '无法保存设置，已恢复原有保存值。当前预览仍保留，可重试或取消。'
        : '部分设置可能已经保存，恢复未完成。请关闭并重新打开设置核对。',
    )
  }
}
