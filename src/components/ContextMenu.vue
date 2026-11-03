<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import { branchReference, useContextMenuStore, type MenuContext } from '../stores/contextMenu'
import Icon from './Icon.vue'
import { flowKind, flowTypes, useGitFlowStore } from '../stores/gitflow'
import type { GitFlowType } from '../types'
import { BRANCH_SORTS } from '../sidebar'
import { SIDEBAR_SECTIONS } from '../sidebar'
import { useSidebarStore } from '../stores/sidebar'
import { useStashStore } from '../stores/stash'
import { useNavigationStore, type NavigationMode } from '../stores/navigation'
import { useGraphViewStore } from '../stores/graphView'
import { knownAncestor } from '../graphVisibility'
import { nativeContextMenu, type NativeMenuItem } from '../services/contextMenu'
import { desktop } from '../services/desktop'
import { useRebaseStore } from '../stores/rebase'
import { useMergeStore } from '../stores/merge'

const store = useRepositoryStore()
const menu = useContextMenuStore()
const flow = useGitFlowStore()
const sidebar = useSidebarStore()
const stash = useStashStore()
const navigation = useNavigationStore()
const rebase = useRebaseStore()
const rebaseAvailable = ref(false)
const menuPreparing = ref(false)
const graphView = useGraphViewStore()
const element = ref<HTMLElement>()
const nativeRequest = ref<number | null>(null)
let requestSequence = 0
const dialog = ref<HTMLDialogElement>()
const nameInput = ref<HTMLInputElement>()
const operation = ref<{
  action: 'create-branch' | 'track-branch' | 'rename-branch' | 'delete-branch' | 'set-upstream'
  target: MenuContext
} | null>(null)
const upstreamRef = ref('')
const pullAfterUpstream = ref(false)
const upstreamChoices = computed(() =>
  store.repo.branches.filter((b) => b.kind === 'remote' && !b.symbolicTarget),
)
const name = ref(''),
  switchAfter = ref(false),
  error = ref('')
const left = ref(0),
  top = ref(0)
const operationBusy = ref(false)
const branch = computed(() =>
  operation.value?.target.kind === 'branch' ? operation.value.target.branch : null,
)
const operationBlocked = computed(() => {
  if (!branch.value || !operation.value) return ''
  if (operation.value.action === 'delete-branch' && branch.value.name === store.repo.branch)
    return '该分支正在当前工作区使用。请先切换到其他分支，再删除。'
  return ''
})
const heading = computed(
  () =>
    ({
      'create-branch': '创建分支',
      'track-branch': '创建本地跟踪分支',
      'rename-branch': '重命名分支',
      'delete-branch': '删除本地分支',
      'set-upstream': '设置上游分支',
    })[operation.value?.action || 'create-branch'],
)
const objectTitle = computed(() => {
  const target = menu.target
  if (target?.kind === 'files') return target.label
  if (target?.kind === 'navigation') return '仓库导航显示设置'
  if (target?.kind === 'stash') return target.stash.message
  if (target?.kind === 'section') return `${SIDEBAR_SECTIONS[target.section].title}分组`
  return target?.kind === 'branch'
    ? target.branch.name
    : target?.kind === 'commit'
      ? `提交 ${target.commit.hash.slice(0, 7)}`
      : target?.kind === 'columns'
        ? '显示列'
        : target?.kind === 'worktree'
          ? '工作区'
          : '提交图谱'
})
interface Item {
  id: string
  label: string
  disabled?: boolean
  reason?: string
  danger?: boolean
  separator?: boolean
  checked?: boolean
}
const rawItems = computed<Item[]>(() => {
  const target = menu.target
  if (!target) return []
  const unavailable = store.busy || store.isNewTab || store.rebasePlanning
  const reason = store.busy ? 'Git 操作正在执行' : store.isNewTab ? '请先打开本地仓库' : ''
  const mutation = (id: string, label: string, extra = {}): Item => ({
    id,
    label,
    disabled: unavailable,
    reason,
    ...extra,
  })
  if (target.kind === 'files')
    return [
      mutation(
        'files-stage',
        target.staged
          ? `取消暂存 ${target.files.length} 个文件`
          : `暂存 ${target.files.length} 个文件`,
        {
          disabled:
            unavailable ||
            target.files.some(
              (file) => file.status === 'U' || ('conflict' in file && !!file.conflict),
            ),
        },
      ),
      ...(target.files.length === 1 ? [{ id: 'files-diff', label: '查看文件差异' }] : []),
      { id: 'files-copy-path', label: '复制路径', separator: true },
    ]
  if (target.kind === 'stash')
    return [
      {
        id: 'stash-apply',
        label: '应用贮藏',
        disabled: unavailable,
        reason,
      },
      {
        id: 'stash-pop',
        label: '弹出贮藏',
        disabled: unavailable,
        reason,
      },
      mutation('stash-drop', '删除贮藏', { danger: true }),
    ]
  if (target.kind === 'navigation')
    return [
      {
        id: 'directory-grouping',
        checked: sidebar.groupDirectories(target.repo),
        label: '按目录分组',
      },
    ]
  if (target.kind === 'section') {
    const branches = store.repo.branches.filter(
      (branch) => branch.kind === (target.section === 'gitflow' ? 'local' : target.section),
    )
    const solo = graphView.soloActive(target.repo, store.repo.branches)
    const visibilityItems: Item[] =
      target.section === 'gitflow'
        ? []
        : [
            {
              id: 'graph-show-all',
              label: '显示全部',
              disabled: solo || !branches.some((branch) => graphView.isHidden(target.repo, branch)),
              reason: solo ? '请先取消 Solo' : '',
            },
            {
              id: 'graph-hide-all',
              label: '隐藏全部',
              disabled:
                solo || !branches.some((branch) => !graphView.isHidden(target.repo, branch)),
              reason: solo ? '请先取消 Solo' : '',
            },
            ...(solo ? [{ id: 'graph-reset', label: '取消 Solo 并显示全部' }] : []),
          ]
    return [
      ...visibilityItems,
      ...BRANCH_SORTS.filter(
        (mode) => mode.id !== 'current-first' || ['local', 'gitflow'].includes(target.section),
      ).map((mode) => ({
        separator: mode === BRANCH_SORTS[0],
        id: `branch-sort:${mode.id}`,
        label: mode.label,
        checked: sidebar.sortMode(target.repo, target.section) === mode.id,
      })),
      {
        id: 'section-up',
        label: '上移分组',
        separator: true,
        disabled: !sidebar.canMove(target.section, -1),
        reason: sidebar.canMove(target.section, -1) ? '' : '已经是第一个分组',
      },
      {
        id: 'section-down',
        label: '下移分组',
        disabled: !sidebar.canMove(target.section, 1),
        reason: sidebar.canMove(target.section, 1) ? '' : '已经是最后一个分组',
      },
      { id: 'section-reset', label: '恢复默认分组顺序', separator: true },
    ]
  }
  if (target.kind === 'branch') {
    const b = target.branch
    const current = b.kind === 'local' && b.name === store.repo.branch
    const occupied = b.kind === 'local' && !!b.worktreePath && !current
    const hasRemotes = (store.repo.remotes?.length || 0) > 0
    const result: Item[] = []
    if (b.kind === 'local' && hasRemotes) {
      result.push(
        mutation('branch-pull', '拉取'),
        mutation('branch-push', '推送'),
        mutation('set-upstream', '设置上游'),
      )
    }
    if (
      b.kind === 'local' &&
      flow.state?.ready &&
      flowTypes.includes(flowKind(flow.state.config, b.name) as GitFlowType)
    )
      result.push({
        id: 'gitflow-finish',
        label: `完成 ${b.name}`,
        separator: true,
        disabled: unavailable,
        reason,
      })
    const oid = b.commitHash || b.hash
    if (
      store.repo.head &&
      store.repo.branch !== 'detached HEAD' &&
      oid !== store.repo.head &&
      !knownAncestor(store.repo.commits, oid, store.repo.head)
    ) {
      result.push(
        mutation('merge-branch', `合并 ${b.name} 到 ${store.repo.branch}`, { separator: true }),
      )
      if (knownAncestor(store.repo.commits, store.repo.head, oid))
        result.push(mutation('fast-forward', `快进 ${store.repo.branch} 到 ${b.name}`))
    }
    if (
      store.repo.head &&
      store.repo.branch !== 'detached HEAD' &&
      oid !== store.repo.head &&
      !store.repo.merge
    ) {
      result.push(
        mutation('rebase', `将 ${store.repo.branch} 变基到 ${b.name}`, { separator: true }),
      )
      if (rebaseAvailable.value)
        result.push(mutation('rebase-interactive', `交互式变基 ${store.repo.branch} 到 ${b.name}`))
    }
    if (b.kind !== 'tag' && !current && !b.symbolicTarget)
      result.push(
        mutation(
          occupied ? 'open-worktree' : 'checkout',
          occupied ? `打开 ${b.name} 所在工作区` : `切换到 ${b.name}`,
          { separator: true },
        ),
      )
    result.push(
      mutation(
        b.kind === 'remote' ? 'track-branch' : 'create-branch',
        b.kind === 'remote' ? '创建本地跟踪分支…' : '在此创建分支',
        { separator: true },
      ),
    )
    if (b.kind === 'local' && !occupied) {
      result.push(mutation('rename-branch', `重命名 ${b.name}`, { separator: true }))
      if (!current) result.push(mutation('delete-branch', `删除 ${b.name}`, { danger: true }))
    }
    if (b.kind === 'remote' && !b.symbolicTarget)
      result.push(
        mutation('delete-remote-branch', `删除 ${b.name}`, { separator: true, danger: true }),
      )
    result.push(
      mutation('create-tag', '创建标签', { separator: true }),
      mutation('create-annotated-tag', '创建附注标签'),
    )
    result.push(
      { id: 'copy-name', label: b.kind === 'tag' ? '复制标签名' : '复制分支名', separator: true },
      ...(b.kind === 'tag' ? [] : [{ id: 'copy-sha', label: '复制提交 SHA' }]),
    )
    result.push(
      {
        id: 'graph-hide',
        label: '隐藏',
        checked: graphView.isHidden(target.repo, b),
        disabled: graphView.soloActive(target.repo, store.repo.branches),
        reason: graphView.soloActive(target.repo, store.repo.branches) ? '请先取消 Solo' : '',
        separator: true,
      },
      { id: 'graph-solo', label: 'Solo', checked: graphView.isSolo(target.repo, b) },
    )
    if (
      graphView.soloActive(target.repo, store.repo.branches) ||
      graphView.state(target.repo).hidden.length
    )
      result.push({ id: 'graph-reset', label: '显示全部引用' })
    if (store.repo.head && oid !== store.repo.head)
      result.push(mutation('compare-head', '与当前分支比较', { separator: true }))
    if (store.changes)
      result.push(
        mutation('compare-working', '与工作区比较', { separator: oid === store.repo.head }),
      )
    return result
  }
  if (target.kind === 'commit')
    return [
      { id: 'details', label: '查看提交详情' },
      { id: 'copy-sha', label: '复制提交 SHA', separator: true },
      { id: 'copy-subject', label: '复制提交说明' },
      ...(store.repo.head &&
      store.repo.branch !== 'detached HEAD' &&
      target.commit.hash !== store.repo.head &&
      !store.repo.merge
        ? [
            mutation('rebase', `将 ${store.repo.branch} 变基到此提交`, { separator: true }),
            ...(rebaseAvailable.value
              ? [mutation('rebase-interactive', '交互式变基到此提交')]
              : []),
          ]
        : []),
      mutation('create-branch', '在此创建分支', { separator: true }),
      mutation('create-tag', '创建标签', { separator: true }),
      mutation('create-annotated-tag', '创建附注标签'),
    ]
  if (target.kind === 'columns')
    return [
      { id: 'toggle-author', label: '作者', checked: store.showAuthor },
      { id: 'toggle-time', label: '时间', checked: store.showTime },
      { id: 'toggle-sha', label: 'SHA', checked: store.showSha },
      { id: 'reset-columns', label: '恢复默认列', separator: true },
    ]
  return [
    ...(target.kind === 'worktree'
      ? [
          {
            id: 'stash-create',
            label: '贮藏当前修改',
            disabled: unavailable,
            reason,
          },
        ]
      : []),
    { id: 'worktree', label: '查看工作区变更' },
    {
      id: 'refresh',
      label: '刷新仓库状态',
      disabled: store.busy,
      reason: store.busy ? reason : '',
    },
    { id: 'clear-filter', label: '清除筛选', separator: true },
    {
      id: 'head',
      label: '定位当前 HEAD',
      disabled: !target.head,
      reason: !target.head ? '仓库尚无提交' : '',
    },
  ]
})
const items = computed(() =>
  rawItems.value.map((item, index) => ({ ...item, separator: !!item.separator && index > 0 })),
)
function valid(target: MenuContext) {
  if (store.repo.path !== target.repo || store.activeTabId !== target.tabId) {
    store.notify('仓库上下文已变化，请重新打开菜单。', true)
    return false
  }
  return true
}
function targetCommit(target: MenuContext) {
  if (target.kind === 'commit') return target.commit
  if (target.kind === 'branch')
    return store.repo.commits.find(
      (c) =>
        c.hash === target.branch.hash ||
        (target.branch.kind === 'tag' && c.refs.includes(`tag: ${target.branch.name}`)),
    )
  return undefined
}
function locate(target: MenuContext, head = false) {
  const commit = head
    ? store.repo.commits.find((c) => c.hash === target.head)
    : targetCommit(target)
  if (!commit) {
    store.notify('目标提交尚未加载，当前仅加载最近 250 条提交。', true)
    return
  }
  store.query = ''
  store.clearBranchFilter()
  void store.selectCommit(commit)
  void nextTick(() =>
    document
      .querySelector(`[data-commit-hash="${commit.hash}"]`)
      ?.scrollIntoView({ block: 'nearest' }),
  )
}
async function perform(item: Item) {
  const target = menu.target
  if (!target || item.disabled) return
  menu.close()
  if (!valid(target)) return
  const id = item.id
  if (target.kind === 'files') {
    const file = target.files[0]
    if (id === 'files-copy-path') {
      try {
        await navigator.clipboard.writeText(target.label)
        store.notify('路径已复制')
      } catch {
        store.notify('无法访问剪贴板，请从文件提示中选择路径。', true)
      }
    } else if (id === 'files-diff' && file) {
      if (file.status === 'U') await useMergeStore().openFile(file.path)
      else await store.selectFile(file, target.staged)
    } else if (id === 'files-stage') {
      const section = document.querySelector(
        `[data-staging-zone="${target.staged ? 'staged' : 'unstaged'}"]`,
      )
      const before = [...(section?.querySelectorAll<HTMLElement>('.worktree-row-main') || [])]
      const origin = menu.trigger
        ?.closest('.worktree-node-row')
        ?.querySelector<HTMLElement>('.worktree-row-main')
      const index = origin ? before.indexOf(origin) : 0
      const ok = await store.run(
        target.staged ? 'unstage' : 'stage',
        { paths: target.files.map((file) => file.path) },
        {
          repo: target.repo,
          tabId: target.tabId,
          expectedHead: target.head,
          expectedBranch: target.currentBranch,
        },
      )
      if (ok && store.repo.path === target.repo && store.activeTabId === target.tabId) {
        await nextTick()
        const after = [...(section?.querySelectorAll<HTMLElement>('.worktree-row-main') || [])]
        ;(
          after[Math.min(Math.max(index, 0), after.length - 1)] ||
          section?.querySelector<HTMLElement>('.staging-zone-title')
        )?.focus({ preventScroll: true })
      }
    }
    return
  }
  if (target.kind === 'stash') {
    stash.openList(
      target.stash,
      id === 'stash-pop' || id === 'stash-drop' || id === 'stash-apply' ? id : undefined,
    )
    return
  }
  if (id === 'stash-create') {
    void stash.create()
    return
  }
  if (target.kind === 'navigation') {
    if (id === 'directory-grouping') sidebar.toggleGroupDirectories(target.repo)
    return
  }
  if (
    target.kind === 'section' &&
    ['graph-show-all', 'graph-hide-all', 'graph-reset'].includes(id)
  ) {
    const branches = store.repo.branches.filter(
      (branch) => branch.kind === (target.section === 'gitflow' ? 'local' : target.section),
    )
    if (id === 'graph-reset') graphView.reset(target.repo)
    else graphView.group(target.repo, branches, id === 'graph-hide-all')
    return
  }
  if (target.kind === 'branch' && ['graph-hide', 'graph-solo', 'graph-reset'].includes(id)) {
    if (id === 'graph-hide') graphView.toggleHide(target.repo, target.branch)
    else if (id === 'graph-solo') graphView.toggleSolo(target.repo, target.branch)
    else graphView.reset(target.repo)
    return
  }
  if (
    [
      'merge-branch',
      'fast-forward',
      'create-tag',
      'create-annotated-tag',
      'delete-remote-branch',
      'compare-head',
      'compare-working',
      'rebase',
      'rebase-interactive',
    ].includes(id)
  ) {
    const reference =
      target.kind === 'branch'
        ? target.branch
        : target.kind === 'commit'
          ? {
              name: `提交 ${target.commit.hash.slice(0, 7)}`,
              hash: target.commit.hash,
              fullRef: target.commit.hash,
              kind: 'local' as const,
              current: false,
              upstream: '',
              track: '',
            }
          : undefined
    if (!reference) {
      store.notify('该提交没有可用的分支或标签引用，请先从此提交创建分支。', true)
      return
    }
    const origin = {
      repo: target.repo,
      tabId: target.tabId,
      expectedHead: target.head,
      expectedBranch: target.currentBranch,
    }
    if (id === 'rebase' || id === 'rebase-interactive')
      await rebase.open(reference, id === 'rebase-interactive', origin)
    else await navigation.open(id as NavigationMode, reference, origin)
    return
  }
  if (target.kind === 'section') {
    const trigger = menu.trigger
    if (id.startsWith('branch-sort:')) {
      const mode = BRANCH_SORTS.find((mode) => `branch-sort:${mode.id}` === id)
      if (mode) sidebar.setSort(target.repo, target.section, mode.id)
    } else if (id === 'section-up') sidebar.move(target.section, -1)
    else if (id === 'section-down') sidebar.move(target.section, 1)
    else if (id === 'section-reset') sidebar.reset()
    await nextTick()
    if (trigger?.isConnected && trigger.matches('button')) trigger.focus({ preventScroll: true })
    else
      document
        .querySelector<HTMLButtonElement>(
          `[data-sidebar-section="${target.section}"] .section-head button`,
        )
        ?.focus({ preventScroll: true })
    return
  }
  if (id === 'gitflow-finish' && target.kind === 'branch') {
    if (flow.finishEntryBlocked) {
      store.notify(flow.finishEntryBlocked, true)
      return
    }
    flow.open('finish', target.branch.name)
    return
  }
  if (id === 'checkout' && target.kind === 'branch' && target.branch.kind !== 'tag') {
    await store.checkoutBranch(target.branch, {
      repo: target.repo,
      tabId: target.tabId,
      expectedHead: target.head,
      expectedBranch: target.currentBranch,
    })
    return
  }
  if (id === 'open-worktree' && target.kind === 'branch' && target.branch.worktreePath) {
    await store.open(target.branch.worktreePath)
    return
  }
  if (
    (id === 'branch-push' || id === 'branch-pull') &&
    target.kind === 'branch' &&
    !(id === 'branch-pull' && !target.branch.upstream)
  ) {
    await store.prepareSync(id === 'branch-push' ? 'push' : 'pull', target.branch, {
      repo: target.repo,
      tabId: target.tabId,
      expectedHead: target.head,
      expectedBranch: target.currentBranch,
    })
    return
  }
  if (
    ['create-branch', 'track-branch', 'rename-branch', 'delete-branch', 'set-upstream'].includes(
      id,
    ) ||
    (id === 'branch-pull' && target.kind === 'branch' && !target.branch.upstream)
  ) {
    const action = id === 'branch-pull' ? 'set-upstream' : id
    operation.value = { action: action as NonNullable<typeof operation.value>['action'], target }
    pullAfterUpstream.value = id === 'branch-pull'
    const existingUpstream = upstreamChoices.value.find(
      (b) => b.name === (target.kind === 'branch' ? target.branch.upstream : ''),
    )
    upstreamRef.value = existingUpstream ? branchReference(existingUpstream) : ''
    name.value = id === 'rename-branch' && target.kind === 'branch' ? target.branch.name : ''
    switchAfter.value = false
    error.value = ''
    await nextTick()
    dialog.value?.showModal()
    if (action === 'set-upstream') dialog.value?.querySelector<HTMLSelectElement>('select')?.focus()
    else nameInput.value?.focus()
    return
  }
  if (id === 'details') {
    const commit = targetCommit(target)
    if (commit) void store.selectCommit(commit)
  } else if (id === 'locate') locate(target)
  else if (id === 'head') locate(target, true)
  else if (id === 'history' && target.kind === 'branch') {
    if (!targetCommit(target)) {
      store.notify('目标提交尚未加载，无法筛选完整的分支历史。', true)
      return
    }
    store.query = ''
    store.setBranchFilter(target.branch, target.navigationSource)
  } else if (id.startsWith('copy-')) {
    const value =
      id === 'copy-name' && target.kind === 'branch'
        ? target.branch.name
        : id === 'copy-subject' && target.kind === 'commit'
          ? target.commit.subject
          : target.kind === 'branch'
            ? target.branch.hash
            : target.kind === 'commit'
              ? target.commit.hash
              : ''
    try {
      await navigator.clipboard.writeText(value)
      store.notify('已复制到剪贴板')
    } catch {
      store.notify('无法访问剪贴板，请检查应用剪贴板权限。', true)
    }
  } else if (id === 'worktree') store.clearSelection()
  else if (id === 'refresh') void store.refresh()
  else if (id === 'clear-filter') {
    store.query = ''
    store.clearBranchFilter()
  } else if (id === 'toggle-author') store.showAuthor = !store.showAuthor
  else if (id === 'toggle-time') store.showTime = !store.showTime
  else if (id === 'toggle-sha') store.showSha = !store.showSha
  else if (id === 'reset-columns') store.resetColumns()
}
function closeOperation() {
  if (!operationBusy.value) {
    dialog.value?.close()
    operation.value = null
    menu.trigger?.focus({ preventScroll: true })
  }
}
async function submit() {
  const op = operation.value
  if (!op || operationBusy.value || store.busy || !valid(op.target)) return
  if (store.isNewTab) {
    error.value = '请先打开本地仓库。'
    return
  }
  if (operationBlocked.value) {
    error.value = operationBlocked.value
    return
  }
  const target = op.target
  const b = target.kind === 'branch' ? target.branch : null
  const guards = { expectedHead: target.head, expectedBranch: target.currentBranch }
  let extra: Record<string, unknown> = {}
  if (op.action === 'create-branch')
    extra = {
      name: name.value.trim(),
      startOid: b?.hash || (target.kind === 'commit' ? target.commit.hash : target.head),
      switchAfter: switchAfter.value,
      ...(switchAfter.value ? guards : {}),
    }
  else if (op.action === 'track-branch' && b)
    extra = {
      name: name.value.trim(),
      fullRef: branchReference(b),
      expectedOid: b.hash,
      switchAfter: switchAfter.value,
      ...(switchAfter.value ? guards : {}),
    }
  else if (b) extra = { name: b.name, newName: name.value.trim(), expectedOid: b.hash, ...guards }
  if (op.action === 'set-upstream') {
    const remote = upstreamChoices.value.find((b) => branchReference(b) === upstreamRef.value)
    if (!remote) {
      error.value = '请选择远程分支；若列表为空，请先获取远端更新。'
      return
    }
    extra = { ...extra, fullRef: upstreamRef.value, upstreamOid: remote.hash }
  }
  // The dialog itself is the explicit deletion confirmation, as in GitKraken.
  if (op.action === 'delete-branch') extra.force = true
  operationBusy.value = true
  try {
    if (await store.run(op.action, extra)) {
      dialog.value?.close()
      operation.value = null
      menu.trigger?.focus({ preventScroll: true })
      if (op.action === 'set-upstream' && pullAfterUpstream.value && b) {
        const updated = store.repo.branches.find(
          (item) => item.kind === 'local' && item.name === b.name,
        )
        if (updated) await store.prepareSync('pull', updated)
      }
    } else
      error.value =
        store.lastActionResult?.error || '操作未完成，请查看错误提示；仓库状态可能已变化。'
  } finally {
    operationBusy.value = false
  }
}
function keydown(event: KeyboardEvent) {
  const buttons = [
    ...(element.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
  ]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
  }
  if (event.key === 'Escape' || event.key === 'Tab') menu.close()
  else if (event.key === 'Home') buttons[0]?.focus()
  else if (event.key === 'End') buttons.at(-1)?.focus()
  else if (event.key === 'ArrowDown') buttons[(index + 1) % buttons.length]?.focus()
  else if (event.key === 'ArrowUp') buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
}
async function position() {
  await nextTick()
  if (!menu.target || !element.value) return
  left.value = Math.max(8, Math.min(menu.x, window.innerWidth - element.value.offsetWidth - 8))
  top.value = Math.max(8, Math.min(menu.y, window.innerHeight - element.value.offsetHeight - 8))
  element.value
    .querySelector<HTMLButtonElement>('button:not(:disabled)')
    ?.focus({ preventScroll: true })
}
function cancelNativeMenu() {
  const request = nativeRequest.value
  nativeRequest.value = null
  if (request !== null)
    void nativeContextMenu()
      ?.close(request)
      .catch(() => {})
}
async function showMenu() {
  cancelNativeMenu()
  const target = menu.target
  if (!target) return
  rebaseAvailable.value = false
  menuPreparing.value = true
  if (
    (target.kind === 'branch' || target.kind === 'commit') &&
    !store.busy &&
    store.connected &&
    !store.repo.merge &&
    !store.rebasePlanning &&
    target.currentBranch !== 'detached HEAD'
  ) {
    try {
      const fullRef = target.kind === 'branch' ? branchReference(target.branch) : target.commit.hash
      const expectedOid = target.kind === 'branch' ? target.branch.hash : target.commit.hash
      if (expectedOid !== target.head) {
        const info = await desktop.navigationRead(target.repo, {
          kind: 'rebase',
          fullRef,
          expectedOid,
          expectedHead: target.head,
          expectedBranch: target.currentBranch,
        })
        if (menu.target !== target) return
        rebaseAvailable.value = !!info.rebase?.canInteractive
      }
    } catch {
      /* Ordinary rebase still checks the actual preconditions on invocation. */
    }
    if (menu.target !== target) return
  }
  menuPreparing.value = false
  const bridge = nativeContextMenu()
  if (!bridge) {
    await position()
    return
  }
  const requestId = ++requestSequence
  nativeRequest.value = requestId
  const template: NativeMenuItem[] = []
  for (const item of items.value) {
    if (item.separator && template.length) template.push({ type: 'separator' })
    template.push({
      id: item.id,
      label: item.label,
      enabled: !item.disabled,
      ...(item.checked === undefined ? {} : { checked: item.checked }),
    })
  }
  try {
    const selected = await bridge.popup({ requestId, items: template })
    if (nativeRequest.value !== requestId || menu.target !== target) return
    nativeRequest.value = null
    const item = items.value.find((item) => item.id === selected)
    if (item && !item.disabled) await perform(item)
    else menu.close()
  } catch {
    if (nativeRequest.value !== requestId || menu.target !== target) return
    nativeRequest.value = null
    await position()
  }
}
watch(() => menu.target, showMenu)
watch(
  () => [store.activeTabId, store.repo, store.repo.head],
  () => {
    menu.close(false)
    closeOperation()
  },
)
watch(
  () => [store.modal, store.busy],
  () => menu.close(false),
)
function outside(event: Event) {
  if (menu.target && !element.value?.contains(event.target as Node)) menu.close(false)
}
function scroll(event: Event) {
  if (menu.target && !element.value?.contains(event.target as Node)) menu.close()
}
function resized() {
  menu.close()
}
function blurred() {
  if (nativeRequest.value === null) menu.close()
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', resized)
  window.addEventListener('blur', blurred)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', resized)
  window.removeEventListener('blur', blurred)
  cancelNativeMenu()
  menu.close(false)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menu.target && nativeRequest === null && !menuPreparing"
      ref="element"
      class="context-menu"
      role="menu"
      :aria-label="`${objectTitle} 右键菜单`"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="keydown"
      @contextmenu.prevent.stop
    >
      <template
        v-for="item in items"
        :key="item.id"
        ><div
          v-if="item.separator"
          class="context-menu-separator"
          role="separator"
        ></div>
        <button
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="item.checked"
          tabindex="-1"
          :disabled="item.disabled"
          :title="item.reason || item.label"
          :class="{ danger: item.danger }"
          @click="perform(item)"
        >
          <span
            v-if="item.checked !== undefined"
            class="context-menu-check"
            aria-hidden="true"
            >{{ item.checked ? '✓' : '' }}</span
          ><span class="context-menu-label">{{ item.label }}</span>
        </button></template
      >
    </div>
    <dialog
      ref="dialog"
      class="dialog context-operation"
      aria-labelledby="context-operation-title"
      @cancel.prevent="closeOperation"
      @click="$event.target === dialog && closeOperation()"
    >
      <form
        v-if="operation"
        class="dialog-content"
        @submit.prevent="submit"
      >
        <button
          type="button"
          class="icon-button dialog-close"
          aria-label="关闭操作窗口"
          :disabled="operationBusy"
          @click="closeOperation"
        >
          <Icon
            name="X"
            :size="18"
          />
        </button>
        <h2 id="context-operation-title">{{ heading }}</h2>
        <p class="context-target">
          {{
            operation.target.kind === 'branch'
              ? operation.target.branch.name
              : operation.target.kind === 'commit'
                ? operation.target.commit.subject
                : ''
          }}<code>{{
            (
              branch?.hash ||
              (operation.target.kind === 'commit' ? operation.target.commit.hash : '')
            ).slice(0, 12)
          }}</code>
        </p>
        <template v-if="operation.action === 'set-upstream'">
          <label for="context-upstream">远程上游分支</label>
          <select
            id="context-upstream"
            v-model="upstreamRef"
            class="form-input"
            :disabled="operationBusy"
            required
          >
            <option
              value=""
              disabled
            >
              选择远程分支
            </option>
            <option
              v-for="remote in upstreamChoices"
              :key="branchReference(remote)"
              :value="branchReference(remote)"
            >
              {{ remote.name }}
            </option>
          </select>
          <p>设置此本地分支的上游，不会创建远程分支。若列表为空，请先获取远端更新。</p>
        </template>
        <template v-else-if="operation.action !== 'delete-branch'"
          ><label for="context-branch-name">{{
            operation.action === 'rename-branch' ? '新分支名称' : '本地分支名称'
          }}</label
          ><input
            id="context-branch-name"
            ref="nameInput"
            v-model="name"
            class="form-input"
            required
            :disabled="operationBusy"
            placeholder="feature/new-idea"
            autocomplete="off"
            spellcheck="false"
        /></template>
        <label
          v-if="operation.action === 'create-branch' || operation.action === 'track-branch'"
          class="context-switch-option"
          ><input
            v-model="switchAfter"
            type="checkbox"
            :disabled="operationBusy"
          />创建后切换到新分支</label
        >
        <p
          v-if="operation.action === 'delete-branch'"
          class="context-delete-note"
        >
          仅删除这个本地分支，保留工作区文件与远程分支。未合并的独有提交将不再属于该分支，请核对分支名称后确认。
        </p>
        <p
          v-if="operationBlocked"
          class="directory-error"
          role="status"
        >
          {{ operationBlocked }}
        </p>
        <p
          v-if="error"
          class="directory-error"
          role="alert"
        >
          {{ error }}
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class="secondary-button"
            :disabled="operationBusy"
            @click="closeOperation"
          >
            取消</button
          ><button
            type="submit"
            :class="operation.action === 'delete-branch' ? 'danger-button' : 'primary-button'"
            :disabled="
              operationBusy ||
              !!operationBlocked ||
              (operation.action === 'set-upstream'
                ? !upstreamRef
                : operation.action !== 'delete-branch' && !name.trim())
            "
          >
            {{
              operationBusy
                ? '正在执行…'
                : operation.action === 'delete-branch'
                  ? '确认删除本地分支'
                  : '确认'
            }}
          </button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>
