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

const store = useRepositoryStore()
const menu = useContextMenuStore()
const flow = useGitFlowStore()
const sidebar = useSidebarStore()
const stash = useStashStore()
const element = ref<HTMLElement>()
const dialog = ref<HTMLDialogElement>()
const nameInput = ref<HTMLInputElement>()
const operation = ref<{
  action: 'create-branch' | 'track-branch' | 'rename-branch' | 'delete-branch' | 'checkout'
  target: MenuContext
} | null>(null)
const name = ref(''),
  switchAfter = ref(false),
  error = ref('')
const left = ref(0),
  top = ref(0)
const operationBusy = ref(false)
const branch = computed(() =>
  operation.value?.target.kind === 'branch' ? operation.value.target.branch : null,
)
const heading = computed(
  () =>
    ({
      'create-branch': '创建分支',
      'track-branch': '创建本地跟踪分支',
      'rename-branch': '重命名分支',
      'delete-branch': '删除本地分支',
      checkout: '切换分支',
    })[operation.value?.action || 'create-branch'],
)
const objectTitle = computed(() => {
  const target = menu.target
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
  note?: string
  danger?: boolean
  separator?: boolean
}
const items = computed<Item[]>(() => {
  const target = menu.target
  if (!target) return []
  const unavailable = store.busy || store.isNewTab
  const reason = store.busy ? 'Git 操作正在执行' : store.isNewTab ? '请先打开本地仓库' : ''
  const mutation = (id: string, label: string, extra = {}): Item => ({
    id,
    label,
    disabled: unavailable,
    reason,
    ...extra,
  })
  const inspect: Item[] = [
    { id: 'locate', label: '定位顶端提交' },
    { id: 'history', label: '筛选已加载历史' },
  ]
  if (target.kind === 'stash')
    return [
      { id: 'stash-view', label: '查看贮藏内容' },
      {
        id: 'stash-apply',
        label: '恢复并保留记录',
        separator: true,
        disabled: !!stash.baseBlocked || !!store.changes,
        reason: stash.baseBlocked || (store.changes ? '恢复前请先处理当前工作区修改' : ''),
      },
      {
        id: 'stash-pop',
        label: '恢复成功后移除记录',
        disabled: !!stash.baseBlocked || !!store.changes,
        reason: stash.baseBlocked || (store.changes ? '恢复前请先处理当前工作区修改' : ''),
      },
      mutation('stash-drop', '删除这条贮藏…', { danger: true, separator: true }),
    ]
  if (target.kind === 'section')
    return [
      ...BRANCH_SORTS.filter(
        (mode) => mode.id !== 'current-first' || ['local', 'gitflow'].includes(target.section),
      ).map((mode) => ({
        id: `branch-sort:${mode.id}`,
        label: `${sidebar.sortMode(target.repo, target.section) === mode.id ? '✓ ' : ''}${mode.label}`,
        note: '收藏始终置顶',
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
  if (target.kind === 'branch') {
    const b = target.branch
    if (b.kind === 'tag') inspect.splice(1, 1)
    const result: Item[] =
      b.kind === 'local'
        ? [
            mutation('checkout', '切换到此分支', {
              disabled: unavailable || b.current,
              reason: b.current ? '已经是当前分支' : reason,
            }),
            ...inspect,
          ]
        : inspect
    if (b.kind === 'local') {
      const pushReason = reason
      const pullReason =
        reason ||
        (b.name !== target.currentBranch
          ? '请先切换到此分支，再拉取其远程上游'
          : !b.upstream
            ? '此分支尚未关联远端分支，暂不能拉取'
            : store.changes
              ? '工作区有未提交更改，请先处理后拉取'
              : '')
      result.push(
        {
          id: 'branch-push',
          label: '推送此分支…',
          separator: true,
          disabled: !!pushReason,
          reason: pushReason,
        },
        {
          id: 'branch-pull',
          label: '拉取此分支的远程上游…',
          disabled: !!pullReason,
          reason: pullReason,
        },
      )
    }
    if (
      b.kind === 'local' &&
      flow.state?.ready &&
      flowTypes.includes(flowKind(flow.state.config, b.name) as GitFlowType)
    )
      result.push({
        id: 'gitflow-finish',
        label:
          (
            { feature: '完成功能分支…', release: '完成发布…', hotfix: '完成热修复…' } as Record<
              string,
              string
            >
          )[flowKind(flow.state.config, b.name) || ''] || '完成 GitFlow 分支…',
        separator: true,
        disabled: !!flow.finishEntryBlocked,
        reason: flow.finishEntryBlocked,
      })
    result.push(
      mutation(
        b.kind === 'remote' ? 'track-branch' : 'create-branch',
        b.kind === 'remote' ? '创建本地跟踪分支…' : '从此创建分支…',
        { separator: true },
      ),
    )
    if (b.kind === 'local') result.push(mutation('rename-branch', '重命名分支…'))
    result.push(
      { id: 'copy-name', label: b.kind === 'tag' ? '复制标签名' : '复制分支名', separator: true },
      { id: 'copy-sha', label: '复制完整对象 ID' },
    )
    if (b.kind === 'local')
      result.push(
        mutation('delete-branch', '删除本地分支…', {
          danger: true,
          disabled: unavailable || b.current,
          reason: b.current ? '不能删除当前检出的分支' : reason,
          separator: true,
        }),
      )
    return result
  }
  if (target.kind === 'commit')
    return [
      { id: 'details', label: '查看提交详情' },
      { id: 'copy-sha', label: '复制完整 SHA', separator: true },
      { id: 'copy-subject', label: '复制提交说明' },
      mutation('create-branch', '从此创建分支…', { separator: true }),
    ]
  if (target.kind === 'columns')
    return [
      { id: 'toggle-author', label: `${store.showAuthor ? '✓ ' : ''}作者` },
      { id: 'toggle-time', label: `${store.showTime ? '✓ ' : ''}时间` },
      { id: 'toggle-sha', label: `${store.showSha ? '✓ ' : ''}SHA` },
      { id: 'reset-columns', label: '恢复默认列', separator: true },
    ]
  return [
    ...(target.kind === 'worktree'
      ? [
          {
            id: 'stash-create',
            label: '贮藏当前修改',
            disabled: !!stash.createBlocked,
            reason: stash.createBlocked,
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
    flow.open('finish', target.branch.name)
    return
  }
  if ((id === 'branch-push' || id === 'branch-pull') && target.kind === 'branch') {
    await store.prepareSync(id === 'branch-push' ? 'push' : 'pull', target.branch, {
      repo: target.repo,
      tabId: target.tabId,
      expectedHead: target.head,
      expectedBranch: target.currentBranch,
    })
    return
  }
  if (
    ['create-branch', 'track-branch', 'rename-branch', 'delete-branch', 'checkout'].includes(id)
  ) {
    operation.value = { action: id as NonNullable<typeof operation.value>['action'], target }
    name.value = id === 'rename-branch' && target.kind === 'branch' ? target.branch.name : ''
    switchAfter.value = false
    error.value = ''
    await nextTick()
    dialog.value?.showModal()
    nameInput.value?.focus()
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
  operationBusy.value = true
  try {
    if (await store.run(op.action, extra)) {
      dialog.value?.close()
      operation.value = null
      menu.trigger?.focus({ preventScroll: true })
    } else error.value = '操作未完成，请查看错误提示；仓库状态可能已变化。'
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
watch(() => menu.target, position)
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
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', resized)
  window.addEventListener('blur', resized)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', resized)
  window.removeEventListener('blur', resized)
  menu.close(false)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menu.target"
      ref="element"
      class="context-menu"
      role="menu"
      :aria-label="`${objectTitle} 右键菜单`"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @keydown="keydown"
      @contextmenu.prevent.stop
    >
      <div
        class="context-menu-heading"
        :title="objectTitle"
      >
        {{ objectTitle }}
      </div>
      <div
        v-if="menu.target.kind === 'branch'"
        class="context-menu-context"
      >
        {{
          menu.target.branch.kind === 'local'
            ? '本地分支'
            : menu.target.branch.kind === 'remote'
              ? '远程跟踪分支'
              : '标签'
        }}
        · 当前检出 {{ menu.target.currentBranch }}
      </div>
      <template
        v-for="item in items"
        :key="item.id"
        ><div
          v-if="item.separator"
          class="context-menu-separator"
          role="separator"
        ></div>
        <button
          role="menuitem"
          tabindex="-1"
          :disabled="item.disabled"
          :title="item.reason"
          :class="{ danger: item.danger }"
          @click="perform(item)"
        >
          <span>{{ item.label }}</span
          ><small v-if="item.disabled && item.reason">{{ item.reason }}</small
          ><small v-else-if="item.note">{{ item.note }}</small>
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
        <template v-if="operation.action !== 'delete-branch' && operation.action !== 'checkout'"
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
          仅删除这个本地分支，不删除远程分支。Git 会检查合并状态；未通过检查时不会强制删除。
        </p>
        <p v-if="operation.action === 'checkout'">
          切换工作区到此分支；如果会覆盖本地更改，Git 将拒绝切换。
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
              (!['delete-branch', 'checkout'].includes(operation.action) && !name.trim())
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
