import type { GitFlowConfig } from './types'
export const flowConfigKeys: (keyof GitFlowConfig)[] = [
  'production',
  'develop',
  'feature',
  'release',
  'hotfix',
  'versionTag',
]
export function readFlowConfig(value: unknown): GitFlowConfig | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  return flowConfigKeys.every((key) => typeof data[key] === 'string' && data[key].length <= 200)
    ? (Object.fromEntries(
        flowConfigKeys.map((key) => [key, data[key]]),
      ) as unknown as GitFlowConfig)
    : null
}
export function mergeFlowConfig(
  base: GitFlowConfig,
  draft: GitFlowConfig,
  latest: GitFlowConfig,
  unresolved: (keyof GitFlowConfig)[] = [],
) {
  const config = { ...latest },
    conflicts: (keyof GitFlowConfig)[] = []
  for (const key of flowConfigKeys) {
    if (draft[key] === base[key] || draft[key] === latest[key]) continue
    config[key] = draft[key]
    if (latest[key] !== base[key] || unresolved.includes(key)) conflicts.push(key)
  }
  return { config, conflicts }
}
