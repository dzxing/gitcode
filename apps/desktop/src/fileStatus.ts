export type FileStatusKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'
  | 'type-changed'
  | 'unknown'

interface FileStatusPresentation {
  code: string
  label: string
  kind: FileStatusKind
}

const statuses: Record<string, FileStatusPresentation> = {
  M: { code: 'M', label: '已修改', kind: 'modified' },
  A: { code: 'A', label: '已添加', kind: 'added' },
  D: { code: 'D', label: '已删除', kind: 'deleted' },
  R: { code: 'R', label: '已重命名', kind: 'renamed' },
  C: { code: 'C', label: '已复制', kind: 'copied' },
  '?': { code: '?', label: '未跟踪', kind: 'untracked' },
  U: { code: 'U', label: '合并冲突', kind: 'conflict' },
  T: { code: 'T', label: '类型变更', kind: 'type-changed' },
}

export function fileStatusPresentation(status: string): FileStatusPresentation {
  const code = status[0] || '—'
  return statuses[code] || { code, label: `Git 状态 ${status || '未知'}`, kind: 'unknown' }
}
