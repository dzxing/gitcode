import type { Commit, Snapshot } from '../shared/contracts'

export interface CommitMenuItem {
  id: string
  label: string
  disabled?: boolean
  reason?: string
  separator?: boolean
}
export interface CommitMenuState {
  connected: boolean
  busy: boolean
  rebasePlanning: boolean
  historyLoading: boolean
  flowPanel: boolean
  conflictDraft: boolean
  interactive: boolean | null
  commits?: Commit[]
}

// Local facts only: no Git processes or network calls on the menu-open path.
// Unknown ancestry/protection is verified asynchronously on invocation.
export function buildCommitMenu(
  repo: Snapshot,
  commit: Commit,
  state: CommitMenuState,
): CommitMenuItem[] {
  const selected = state.commits?.length ? state.commits : [commit]
  const single = selected.length === 1 ? '' : '此操作需要单选提交'
  const read = !state.connected ? '本地 Git 服务未连接' : ''
  const write =
    read ||
    (state.busy ? 'Git 操作正在执行' : '') ||
    (state.rebasePlanning ? '请先完成或取消提交编排' : '') ||
    (repo.merge ? '请先完成或中止当前 Git 操作' : '') ||
    (state.flowPanel ? '请先关闭 GitFlow 面板' : '') ||
    (state.conflictDraft ? '请先保存冲突处理草稿' : '')
  const branch =
    !repo.head || !repo.branch || repo.branch === 'detached HEAD' ? '请先检出本地分支' : ''
  const merge = selected.some((c) => c.parents.length > 1) ? '此操作不支持所选合并提交' : ''
  const dirty = repo.staged.length || repo.unstaged.some((file) => file.status !== '?')
  const item = (id: string, label: string, reason = '', separator = false): CommitMenuItem => ({
    id,
    label,
    disabled: !!reason,
    reason,
    separator,
  })
  return [
    item('copy-sha', '复制修订'),
    item('commit-patch', '创建补丁…', read || merge),
    item('commit-cherry', '优选', write || branch || merge),
    item('commit-checkout', '检出修订', single || write, true),
    item('commit-browse', '在修订版中显示仓库', single || read),
    item('compare-working', '与本地比较', single || read),
    item(
      'commit-reset',
      branch ? '将 HEAD 重置到此处…' : '将当前分支重置到此处…',
      single || write,
      true,
    ),
    item('commit-revert', '还原提交', write || branch || merge),
    item(
      'commit-undo',
      '撤销提交…',
      single ||
        write ||
        branch ||
        (commit.hash !== repo.head ? '只能撤销当前 HEAD 提交' : '') ||
        (commit.parents.length !== 1 ? '首次提交或合并提交不能使用此撤销方式' : ''),
    ),
    item(
      'commit-reword',
      '编辑提交说明…',
      single || write || branch || (commit.hash === repo.head ? '' : merge),
      true,
    ),
    item(
      'commit-fixup',
      'Fixup…',
      single || write || branch || merge || (!dirty ? '没有可提交的已跟踪更改' : ''),
    ),
    item(
      'commit-squash-into',
      '压缩到…',
      single || write || branch || merge || (!dirty ? '没有可提交的已跟踪更改' : ''),
    ),
    item('commit-drop', '删除提交', write || branch || merge),
    item(
      'commit-squash',
      '压缩提交…',
      write || branch || merge || (selected.length < 2 ? '请至少选择两条提交' : ''),
    ),
    item('commit-interactive', '从这里进行交互式变基…', single || write || branch || merge),
    item(
      'commit-push',
      '推送此前所有提交…',
      single ||
        write ||
        (!repo.remotes?.length && !repo.branches.some((b) => b.kind === 'remote')
          ? '仓库尚未配置远程'
          : ''),
    ),
    item('create-branch', '新建分支…', single || write, true),
    item('create-tag', '新建标记…', single || write),
    item(
      'jump-child',
      '转到子提交',
      single || read || (state.historyLoading ? '正在加载历史' : ''),
      true,
    ),
    item(
      'jump-parent',
      '转到父提交',
      single ||
        read ||
        (state.historyLoading
          ? '正在加载历史'
          : !commit.parents.length
            ? '首次提交没有父提交'
            : ''),
    ),
    item('commit-browser', '在浏览器中查看', single || read, true),
  ]
}
