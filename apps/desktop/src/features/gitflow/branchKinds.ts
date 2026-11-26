import type { GitFlowConfig, GitFlowType } from '../../shared/contracts'

export const flowTypes: GitFlowType[] = ['feature', 'release', 'hotfix']
export const flowLabels = { feature: '功能', release: '发布准备', hotfix: '紧急修复' }
export function flowKind(config: GitFlowConfig, name: string) {
  if (name === config.production) return 'production'
  if (name === config.develop) return 'develop'
  return (
    flowTypes.find((type) => name.startsWith(config[type]) && name.length > config[type].length) ||
    null
  )
}
