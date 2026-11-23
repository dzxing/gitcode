import type { GitFlowConfig } from './types'

// Immediate form feedback; the main process always validates again with Git.
function validBranch(name: string) {
  // Git forbids ASCII control characters in refs, including NUL and DEL.
  // eslint-disable-next-line no-control-regex
  const invalidCharacters = /[\s\x00-\x1f\x7f~^:?*[\\]/
  return (
    !!name &&
    name !== 'HEAD' &&
    !name.startsWith('-') &&
    !invalidCharacters.test(name) &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    !name.endsWith('.') &&
    name.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
export function flowConfigError(config: GitFlowConfig) {
  if (
    Object.values(config).some(
      (value) => typeof value !== 'string' || value.length > 200 || /[\s\0]/.test(value),
    )
  )
    return '分支名和前缀不能包含空白，且最多 200 个字符。'
  if (!validBranch(config.production) || !validBranch(config.develop))
    return '请填写有效的生产分支和开发分支名称。'
  if (
    config.production === config.develop ||
    config.production.startsWith(config.develop + '/') ||
    config.develop.startsWith(config.production + '/')
  )
    return '生产分支和开发分支必须不同，且不能形成目录冲突。'
  const prefixes = [config.feature, config.release, config.hotfix]
  if (prefixes.some((prefix) => !prefix.endsWith('/') || !validBranch(prefix + 'gitcode-check')))
    return 'Feature、Release 和 Hotfix 前缀必须有效并以 / 结尾。'
  if (
    prefixes.some((prefix, index) =>
      prefixes
        .slice(index + 1)
        .some((other) => prefix.startsWith(other) || other.startsWith(prefix)),
    )
  )
    return '工作流前缀不能互相重叠。'
  if (
    prefixes.some((prefix) =>
      [config.production, config.develop].some(
        (name) => name.startsWith(prefix) || prefix.startsWith(name + '/'),
      ),
    )
  )
    return '基础分支不能与工作流前缀重叠。'
  if (config.versionTag && !validBranch('tags/' + config.versionTag + 'gitcode-check'))
    return '版本标签前缀无效。'
  return ''
}
export function flowNameError(prefix: string, suffix: string) {
  if (!suffix) return '请填写分支名称后缀。'
  if (suffix.length > 200 || suffix.startsWith('-') || !validBranch(prefix + suffix))
    return '分支名称无效：不能包含空白、连续点、特殊引用字符或空路径段。'
  return ''
}
