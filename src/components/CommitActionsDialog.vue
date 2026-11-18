<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed, nextTick, ref, watch } from 'vue'
import { useCommitActionsStore } from '../stores/commitActions'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
const action = useCommitActionsStore(),
  repo = useRepositoryStore()
const dialog = ref<HTMLDialogElement>()
const collapsedDirectories = ref(new Set<string>())
const historicalRows = computed(() => {
  type Row = { path: string; name: string; type: string; depth: number }
  const nodes = new Map<string, Row>()
  for (const entry of action.data?.entries || []) {
    const parts = entry.path.split('/')
    parts.forEach((name, depth) => {
      const path = parts.slice(0, depth + 1).join('/')
      nodes.set(path, { path, name, depth, type: depth === parts.length - 1 ? entry.type : 'tree' })
    })
  }
  const children = new Map<string, Row[]>()
  for (const row of nodes.values()) {
    const parent = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
    children.set(parent, [...(children.get(parent) || []), row])
  }
  const rows: Row[] = []
  function visit(parent: string) {
    const entries = (children.get(parent) || []).sort(
      (a, b) =>
        Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
    )
    for (const row of entries) {
      rows.push(row)
      if (row.type === 'tree' && !collapsedDirectories.value.has(row.path)) visit(row.path)
    }
  }
  visit('')
  return rows
})
function selectHistoryEntry(entry: { type: string; path: string }) {
  if (entry.type !== 'tree') {
    void action.selectFile(entry.path)
    return
  }
  const next = new Set(collapsedDirectories.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else next.add(entry.path)
  collapsedDirectories.value = next
}
let previous: HTMLElement | null = null
watch(
  () => repo.modal === 'commit-operation',
  async (open) => {
    if (open) {
      collapsedDirectories.value = new Set()
      previous = document.activeElement as HTMLElement
      await nextTick()
      dialog.value?.showModal()
    } else {
      dialog.value?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  },
)
const blocked = computed(
  () =>
    repo.busy ||
    action.loading ||
    action.stale ||
    (action.mode === 'checkout'
      ? false
      : action.mode === 'push'
        ? !action.sync ||
          ['error', 'behind', 'diverged'].includes(action.sync.remoteCheck?.state || '')
        : !action.data?.id) ||
    (action.mode === 'reset' && action.resetMode === 'hard' && !action.hardConfirmed),
)
const submitLabel = computed(() => {
  switch (action.mode) {
    case 'reset':
      return '重置 HEAD'
    case 'reword':
      return '保存说明'
    case 'fixup':
      return '创建 Fixup 提交'
    case 'squash-into':
      return '创建 squash! 提交'
    case 'interactive':
      return '开始变基'
    case 'push':
      return '推送'
    default:
      return action.title
  }
})
const requiresMessage = computed(() =>
  ['reword', 'fixup', 'squash-into', 'squash'].includes(action.mode),
)
const checkoutBranches = computed(() =>
  repo.repo.branches.filter(
    (b) => b.kind === 'local' && (b.commitHash || b.hash) === action.commits[0]?.hash,
  ),
)
const notice = computed(
  () =>
    ({
      reset:
        'Soft 保留暂存区和工作区；Mixed 保留工作区并重置暂存区；Hard 丢弃更改；Keep 在可能覆盖本地修改时中止。原 HEAD 将保存为恢复点。',
      cherry: '把所选更改依次应用到当前分支，生成新提交。发生冲突时可解决后继续、跳过或中止。',
      revert: '按从新到旧的顺序创建反向提交，保留原历史。发生冲突时可解决后继续或中止。',
      undo: '撤销当前 HEAD，使用 Soft reset；暂存区和工作区保持原样，原提交保留为恢复点。',
      drop: '从当前分支历史移除所选提交并重放后继；不删除分支。原 HEAD 将保存为恢复点。',
      squash: '将选中的连续提交合为一条并重放后继。非连续选择请使用交互式变基。',
      reword: '修改提交说明会重写该提交及其后续提交的 SHA，不会合入现有暂存更改。',
      fixup: '从勾选文件创建 fixup! 修正提交；不会立即整理历史。请注意文件原有的部分暂存内容。',
      'squash-into':
        '从勾选文件创建 squash! 提交；不会立即整理历史。请注意文件原有的部分暂存内容。',
      interactive:
        '编排包含选中提交及其后继，从上到下执行；根提交使用 --root。含合并提交的范围暂不支持。',
      browse:
        '只读浏览此修订的文件树；不会切换工作区。符号链接、子模块和二进制文件不提供文本预览。',
      patch: '导出包含提交元信息的补丁序列，可供 git am 使用；不修改工作区。',
      push: '只推送到选中 SHA，后续本地提交不会被推送。确认前已核对远端；执行仍会校验目标与远端末端。',
      checkout:
        '检出分支或指定提交；检出提交会进入分离 HEAD 状态。未提交更改会先检查，需要保留的更改会自动贮藏并尝试恢复。',
      browser: '选择要打开的远端提交页面。',
    })[action.mode],
)
function move(index: number, offset: number) {
  const to = index + offset
  if (to < 0 || to >= action.steps.length) return
  const [step] = action.steps.splice(index, 1)
  action.steps.splice(to, 0, step)
}
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog commit-actions-dialog"
    aria-labelledby="commit-actions-title"
    @cancel.prevent="action.close"
    @click="$event.target === dialog && action.close()"
  >
    <form
      autocomplete="off"
      class="dialog-content"
      @submit.prevent="action.submit"
    >
      <button
        type="button"
        class="icon-button dialog-close"
        aria-label="关闭提交操作"
        :disabled="repo.busy"
        @click="action.close"
      >
        <Icon
          name="X"
          :size="16"
        />
      </button>
      <h2 id="commit-actions-title">{{ action.title }}</h2>
      <p class="commit-operation-target">
        <code>{{ action.commits[0]?.hash.slice(0, 12) }}</code> {{ action.commits[0]?.subject }}
        <span v-if="action.commits.length > 1">等 {{ action.commits.length }} 条</span>
      </p>
      <p class="commit-operation-note">{{ notice }}</p>
      <p
        v-if="action.loading"
        role="status"
      >
        正在读取操作目标…
      </p>
      <p
        v-if="action.stale"
        class="form-error"
        role="alert"
      >
        仓库或 HEAD 已变化，请关闭后重新打开。
      </p>
      <p
        v-if="action.error"
        class="form-error"
        role="alert"
      >
        {{ action.error }}
      </p>
      <template v-if="action.mode === 'reset' && action.data">
        <fieldset :disabled="repo.busy || action.loading">
          <legend>重置模式</legend>
          <label
            v-for="mode in ['soft', 'mixed', 'hard', 'keep']"
            :key="mode"
            ><input
              v-model="action.resetMode"
              type="radio"
              name="reset-mode"
              :value="mode"
            />
            {{ mode.toUpperCase() }}</label
          >
        </fieldset>
        <div
          v-if="action.resetMode === 'hard'"
          class="commit-operation-warning"
        >
          <p>Hard 会丢弃已暂存和未暂存的修改。未跟踪文件若阻挡目标检出，也可能被删除。</p>
          <label
            ><input
              v-model="action.hardConfirmed"
              type="checkbox"
            />
            我已检查受影响文件，确认丢弃更改</label
          >
        </div>
        <ul
          v-if="action.data.files?.length"
          class="commit-operation-files"
        >
          <li
            v-for="f in action.data.files"
            :key="`${f.status}:${f.path}`"
          >
            {{ f.status }} {{ f.path }}
          </li>
        </ul>
      </template>
      <label v-if="requiresMessage && action.data"
        >提交说明<textarea
          autocomplete="off"
          v-model="action.message"
          aria-label="提交说明"
          rows="5"
          maxlength="20000"
          :disabled="repo.busy"
        />
      </label>
      <template v-if="['fixup', 'squash-into'].includes(action.mode) && action.data">
        <fieldset
          class="commit-operation-files"
          :disabled="repo.busy"
        >
          <legend>包含以下文件的全部工作区更改</legend>
          <label
            v-for="path in [...new Set(action.data.files?.map((f) => f.path))]"
            :key="path"
            ><input
              v-model="action.paths"
              type="checkbox"
              :value="path"
            />
            {{ path }}</label
          >
        </fieldset>
        <label
          ><input
            v-model="action.partialConfirmed"
            type="checkbox"
          />
          若所选文件仅部分暂存，确认提交该文件的完整工作区内容</label
        >
      </template>
      <div
        v-if="action.mode === 'interactive' && action.data"
        class="commit-operation-steps"
      >
        <div
          v-for="(step, index) in action.steps"
          :key="step.sha"
          class="commit-operation-step"
        >
          <select
            v-model="step.type"
            :aria-label="`提交 ${step.sha.slice(0, 7)} 的操作`"
            :disabled="repo.busy"
          >
            <option value="pick">保留 Pick</option>
            <option value="reword">编辑消息 Reword</option>
            <option
              v-if="index"
              value="squash"
            >
              压缩 Squash
            </option>
            <option
              v-if="index"
              value="fixup"
            >
              修正 Fixup
            </option>
            <option value="drop">删除 Drop</option>
          </select>
          <code>{{ step.sha.slice(0, 7) }}</code
          ><span>{{ step.subject }}</span
          ><button
            type="button"
            :disabled="repo.busy || !index"
            @click="move(index, -1)"
          >
            ↑</button
          ><button
            type="button"
            :disabled="repo.busy || index === action.steps.length - 1"
            @click="move(index, 1)"
          >
            ↓
          </button>
          <textarea
            autocomplete="off"
            v-if="step.type === 'reword'"
            v-model="step.message"
            :aria-label="`编辑 ${step.sha.slice(0, 7)} 的说明`"
            :disabled="repo.busy"
          />
        </div>
      </div>
      <ul
        v-if="['cherry', 'revert', 'drop', 'squash'].includes(action.mode) && action.data?.commits"
        class="commit-operation-files"
      >
        <li
          v-for="c in action.mode === 'revert'
            ? [...action.data.commits].reverse()
            : action.data.commits"
          :key="c.sha"
        >
          <code>{{ c.sha.slice(0, 7) }}</code> {{ c.subject }}
        </li>
      </ul>
      <template v-if="action.mode === 'checkout'">
        <label
          >检出目标<select
            v-model="action.checkoutBranch"
            :disabled="repo.busy"
          >
            <option value="">检出此修订（分离 HEAD）</option>
            <option
              v-for="b in checkoutBranches"
              :key="b.name"
              :value="b.name"
            >
              本地分支 {{ b.name }}
            </option>
          </select></label
        >
      </template>
      <template v-if="action.mode === 'push'">
        <label
          >推送源<select
            v-model="action.sourceRef"
            :disabled="repo.busy || action.loading"
            @change="action.refreshPush"
          >
            <option
              v-for="s in action.sources"
              :key="s.fullRef"
              :value="s.fullRef"
            >
              {{ s.fullRef }}
            </option>
            <option value="">仅选中提交（不设置本地上游）</option>
          </select></label
        >
        <label
          >源末端<input
            autocomplete="off"
            :value="action.commits[0]?.hash"
            readonly
        /></label>
        <label
          >远端<select
            v-model="action.remote"
            :disabled="repo.busy || action.loading || !action.sync?.publish"
            @change="action.refreshPush"
          >
            <option
              v-for="r in repo.repo.remotes"
              :key="r"
            >
              {{ r }}
            </option>
          </select></label
        >
        <label
          >目标分支<input
            autocomplete="off"
            v-model="action.destination"
            :disabled="repo.busy || action.loading || !action.sync?.publish"
            @change="action.refreshPush"
        /></label>
        <p v-if="action.sync?.publish">
          将发布远程分支{{ action.sourceRef ? '并建立本地跟踪关系' : '' }}。
        </p>
        <p v-if="action.sync?.remoteCheck">
          远端检查：{{ action.sync.remoteCheck.state }} {{ action.sync.remoteCheck.message }}
        </p>
        <button
          type="button"
          class="text-button"
          :disabled="repo.busy || action.loading"
          @click="action.refreshPush"
        >
          重新核对远端
        </button>
      </template>
      <div
        v-if="action.mode === 'browse'"
        class="commit-historical-browser"
      >
        <div class="commit-history-files">
          <button
            v-for="entry in historicalRows"
            :key="entry.path"
            type="button"
            :disabled="action.loading || !['blob', 'tree'].includes(entry.type)"
            :style="{ paddingLeft: `${8 + entry.depth * 12}px` }"
            :aria-expanded="
              entry.type === 'tree' ? !collapsedDirectories.has(entry.path) : undefined
            "
            :class="{ selected: action.file === entry.path }"
            v-overflow-title="{ text: entry.path, target: '.file-name, span' }"
            @click="selectHistoryEntry(entry)"
          >
            <Icon
              :name="entry.type === 'tree' ? 'FolderOpen' : 'FileText'"
              :size="12"
            />
            {{ entry.name }}
          </button>
        </div>
        <pre class="commit-history-content">{{ action.content || '选择历史文件查看内容' }}</pre>
      </div>
      <pre
        v-if="action.mode === 'patch' && action.content"
        class="commit-patch-preview"
        >{{ action.content }}</pre>
      <div
        v-if="action.mode === 'browser'"
        class="commit-hosting-links"
      >
        <a
          v-for="link in action.data?.urls"
          :key="link.name"
          :href="link.url"
          target="_blank"
          rel="noopener noreferrer"
          @click.prevent="action.openBrowser(link.name)"
          >{{ link.name }} · 查看此提交</a
        >
      </div>
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary-button"
          :disabled="repo.busy"
          @click="action.close"
        >
          {{ action.writing ? '取消' : '关闭' }}</button
        ><button
          v-if="action.mode === 'patch'"
          type="button"
          class="primary-button"
          :disabled="!action.content || action.stale"
          @click="action.savePatch"
        >
          保存补丁…</button
        ><button
          v-else-if="action.writing"
          type="submit"
          class="primary-button"
          :disabled="blocked || (requiresMessage && !action.message.trim())"
        >
          {{ repo.busy ? '正在执行…' : submitLabel }}
        </button>
      </div>
    </form>
  </dialog>
</template>
<style scoped>
.commit-actions-dialog {
  width: min(780px, calc(100vw - 40px));
  max-height: calc(100vh - 50px);
}
.dialog-content {
  max-height: calc(100vh - 90px);
  overflow: auto;
}
.commit-operation-target {
  overflow-wrap: anywhere;
  font-size: var(--dialog-font-body);
}
.commit-operation-target code {
  color: var(--accent);
  margin-right: 10px;
}
.commit-operation-note {
  color: var(--text-secondary);
  font-size: var(--dialog-font-body);
  line-height: 1.7;
}
.commit-operation-files {
  max-height: 180px;
  overflow: auto;
  font-size: var(--dialog-font-body);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.commit-operation-files label {
  display: block;
  margin: 6px 0;
}
fieldset {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 10px;
}
fieldset > label {
  margin-right: 16px;
}
.commit-operation-warning {
  color: var(--git-deleted);
  font-size: var(--dialog-font-body);
  line-height: 1.8;
}
form > label {
  display: block;
  margin: 14px 0;
  font-size: var(--dialog-font-body);
}
form > label > input:not([type='checkbox']),
form > label > select,
textarea {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 8px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 4px;
  font: inherit;
}
textarea {
  min-height: 70px;
  resize: vertical;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
.commit-operation-step {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--dialog-font-body);
}
.commit-operation-step > span {
  flex: 1;
  min-width: 80px;
  overflow-wrap: anywhere;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
.commit-operation-step > textarea {
  flex-basis: 100%;
}
.commit-historical-browser {
  display: grid;
  grid-template-columns: minmax(130px, 30%) minmax(0, 1fr);
  height: 360px;
  border: 1px solid var(--line);
  margin-top: 16px;
}
.commit-history-files {
  overflow: auto;
  border-right: 1px solid var(--line);
}
.commit-history-files button {
  display: block;
  text-align: left;
  width: 100%;
  font-size: var(--dialog-font-body);
  padding: 7px 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-history-files button:hover,
.commit-history-files button.selected {
  background: var(--hover);
}
.commit-history-content,
.commit-patch-preview {
  overflow: auto;
  margin: 0;
  padding: 12px;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
  white-space: pre;
  user-select: text;
}
.commit-patch-preview {
  max-height: 350px;
  border: 1px solid var(--line);
}
.commit-hosting-links {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 16px 0;
}
.commit-hosting-links a {
  color: var(--accent);
}
</style>
