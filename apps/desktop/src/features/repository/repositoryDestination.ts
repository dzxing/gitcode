/** Derive a folder name without interpreting a remote URL as an executable command. */
export function suggestedRepositoryName(value: string) {
  let path = value.trim()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      return ''
    }
  }
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .pop()
      ?.replace(/\.git$/i, '') || ''
  )
}

export function parentDirectory(value: string) {
  const path = value.trim().replace(/[\\/]+$/, '')
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (split < 0) return ''
  if (split === 0 || /^[a-z]:$/i.test(path.slice(0, split))) return path.slice(0, split + 1)
  return path.slice(0, split)
}

export function validRepositoryFolderName(value: string) {
  const name = value.trim()
  return !!name && !['.', '..'].includes(name) && !/[\\/\0]/.test(name)
}
