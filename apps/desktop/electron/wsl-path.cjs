'use strict'
const path = require('node:path')
const ROOT = '\\\\wsl.localhost\\'
// eslint-disable-next-line no-control-regex -- Distribution identities must exclude Windows path delimiters and C0 controls.
const DISTRIBUTION_NAME = /^[^\\/:*?"<>|\x00-\x1f]{1,256}$/
function validDistribution(value) {
  return (
    typeof value === 'string' &&
    DISTRIBUTION_NAME.test(value) &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !['.', '..'].includes(value)
  )
}

// Parse before win32.normalize: resolving `..` across a UNC share would lose
// the distribution boundary. A distro is an identity, never a shell fragment.
function parseWslPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 32768) return null
  const normalized = value.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\')
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i.exec(normalized)
  if (!match) return null
  const distribution = match[1]
  if (!validDistribution(distribution)) throw Error('无效的 WSL 发行版名称。')
  const parts = match[2].split('\\').filter(Boolean)
  let depth = 0
  for (const part of parts) {
    if (part === '..') {
      if (!depth) throw Error('WSL 路径不能越过发行版根目录。')
      depth--
    } else if (part !== '.') depth++
  }
  return { distribution, linuxPath: path.posix.normalize('/' + parts.join('/')) }
}
function isWslRoot(value) {
  return (
    typeof value === 'string' &&
    /^\\\\(?:wsl\.localhost|wsl\$)\\?$/i.test(value.replaceAll('/', '\\'))
  )
}
function toUnc(distribution, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0'))
    throw Error('无效的 WSL Linux 路径。')
  return ROOT + distribution + path.posix.normalize(value).replaceAll('/', '\\')
}
// Only transport path fields are converted. Never rewrite messages, patches,
// commit descriptions, URLs, GitFlow prefixes or user-supplied file contents.
const pathFields = new Set([
  'repo',
  'path',
  'gitDir',
  'commonDir',
  'home',
  'root',
  'parent',
  'worktreePath',
])
function mapResult(value, distribution, key = '') {
  if (typeof value === 'string')
    return pathFields.has(key) && value.startsWith('/') ? toUnc(distribution, value) : value
  if (Array.isArray(value)) return value.map((entry) => mapResult(entry, distribution))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, mapResult(v, distribution, k)]),
  )
}
module.exports = { ROOT, parseWslPath, isWslRoot, toUnc, mapResult, validDistribution }
