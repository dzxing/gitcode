<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import FileList from './FileList.vue'
import FileViewToggle from './FileViewToggle.vue'
import Icon from './Icon.vue'
import WorktreeChanges from './WorktreeChanges.vue'
import StashInspector from './StashInspector.vue'
import StashCreateForm from './StashCreateForm.vue'
import RebaseInspector from './RebaseInspector.vue'
import { useStashStore } from '../stores/stash'
import { useRebaseStore } from '../stores/rebase'
import { useStagingStore } from '../stores/staging'

const store = useRepositoryStore()
const descriptionExpanded = ref(false)
watch(
  () => store.repo.path,
  () => {
    descriptionExpanded.value = false
  },
)
const showDescription = computed(() => descriptionExpanded.value || !!description.value)
const stash = useStashStore()
const rebase = useRebaseStore()
const staging = useStagingStore()
const scopeHint = computed(
  () =>
    !!staging.view(store.repo.path).query.trim() ||
    !!staging.view(store.repo.path).selected.staged.length,
)
const detailMessage = computed(() =>
  store.rebasePlanning ? rebase.previewMessage : store.commitBody,
)
const description = computed({
  get: () => store.commitDescription,
  set: (value) => {
    store.commitDescription = value
  },
})
const title = computed({
  get: () => store.commitMessage.split('\n')[0] || '',
  set: (value) => {
    store.commitMessage = value + (description.value ? `\n\n${description.value}` : '')
  },
})
const commitBlocked = computed(() =>
  store.busy
    ? `正在${store.operationLabel}，请等待当前操作完成`
    : store.commitContextBlocked ||
      ([...store.repo.staged, ...store.repo.unstaged].some((file) => file.status === 'U')
        ? '请先解决冲突并暂存，再创建提交'
        : !store.repo.staged.length
          ? '先将需要提交的文件加入暂存区'
          : !title.value.trim()
            ? '填写提交说明后即可提交'
            : ''),
)
const canCommit = computed(() => !commitBlocked.value)
async function submit() {
  if (stash.creating && !store.selectedStash && !store.selectedCommit) {
    await stash.create()
    return
  }
  if (!canCommit.value) return
  store.commitMessage =
    title.value.trim() + (description.value.trim() ? `\n\n${description.value.trim()}` : '')
  if (await store.run('commit', { message: store.commitMessage })) description.value = ''
}
async function copyHash() {
  try {
    await navigator.clipboard.writeText(store.selectedCommit?.hash || '')
    store.notify('提交 SHA 已复制')
  } catch {
    store.notify('无法访问剪贴板，可从提交详情选择并复制 SHA。', true)
  }
}
defineExpose({ submit })
</script>

<template>
  <aside class="inspector">
    <RebaseInspector v-if="store.repo.merge?.rebase" />
    <StashInspector v-else-if="store.selectedStash" />
    <template v-else-if="store.selectedCommit">
      <header class="panel-header">
        <div class="panel-title"><Icon name="GitCommitHorizontal" /><strong>提交详情</strong></div>
        <button
          class="icon-button"
          aria-label="返回工作区"
          title="返回工作区"
          :disabled="store.rebasePlanning"
          @click="store.clearSelection()"
        >
          <Icon name="X" />
        </button>
      </header>
      <div class="commit-detail">
        <div class="detail-hash">
          <span>COMMIT</span
          ><button @click="copyHash">
            {{ store.selectedCommit.hash.slice(0, 7)
            }}<Icon
              name="Copy"
              :size="12"
            />
          </button>
        </div>
        <h2>
          {{ store.rebasePlanning ? detailMessage.split('\n')[0] : store.selectedCommit.subject }}
        </h2>
        <div class="detail-author">
          <span class="avatar large">{{
            store.selectedCommit.author.slice(0, 1).toUpperCase()
          }}</span>
          <div>
            <strong>{{ store.selectedCommit.author }}</strong
            ><small>{{ store.selectedCommit.email }}</small>
          </div>
        </div>
        <p class="detail-date">{{ new Date(store.selectedCommit.date).toLocaleString('zh-CN') }}</p>
        <pre
          v-if="detailMessage.includes('\n')"
          class="commit-body"
          >{{ detailMessage.split('\n').slice(1).join('\n').trim() }}</pre>
        <div class="detail-full-hash">{{ store.selectedCommit.hash }}</div>
        <div
          v-if="store.selectedCommit.parents.length"
          class="parent-hashes"
        >
          <span>父提交</span
          ><code
            v-for="parent in store.selectedCommit.parents"
            :key="parent"
            >{{ parent.slice(0, 7) }}</code
          >
        </div>
      </div>
      <div class="files-section-head">
        <span class="file-section-title"
          >变更文件 <span class="pill">{{ store.commitFiles.length }}</span></span
        ><FileViewToggle context="history" />
      </div>
      <div class="inspector-scroll">
        <div
          v-if="store.commitLoading"
          class="empty-state compact"
        >
          <Icon
            name="LoaderCircle"
            class="spin"
          /><span>正在读取…</span>
        </div>
        <div
          v-else-if="store.commitError"
          class="read-error"
          role="alert"
        >
          <strong>读取提交详情失败</strong>
          <p>{{ store.commitError }}</p>
          <button
            class="secondary-button"
            :disabled="store.busy"
            @click="store.selectedCommit && store.selectCommit(store.selectedCommit)"
          >
            重试读取提交详情
          </button>
        </div>
        <template v-else
          ><FileList
            :files="store.commitFiles"
            historical
          />
          <div
            v-if="!store.commitFiles.length"
            class="section-empty"
          >
            这条提交没有文件变更。
          </div></template
        >
      </div>
      <div class="inspector-note">
        <Icon
          name="Info"
          :size="14"
        /><span>选择文件，在左侧查看具体差异。</span>
      </div>
    </template>
    <template v-else>
      <header class="panel-header">
        <div class="panel-title">
          <Icon name="FolderGit2" /><strong>工作区变更</strong
          ><span class="pill">{{ store.changes }}</span>
        </div>
        <div class="inspector-header-actions">
          <button
            class="icon-button"
            :class="{ spin: store.busy }"
            :disabled="store.busy"
            aria-label="刷新文件状态"
            title="刷新文件状态"
            @click="store.refresh()"
          >
            <Icon
              name="RefreshCw"
              :size="14"
            />
          </button>
        </div>
      </header>
      <WorktreeChanges />
      <div
        class="worktree-compose-tabs"
        role="tablist"
        aria-label="工作区操作"
      >
        <button
          role="tab"
          :aria-selected="!stash.creating"
          aria-controls="worktree-commit-form"
          :disabled="store.busy"
          @click="stash.creating = false"
        >
          提交</button
        ><button
          role="tab"
          :aria-selected="stash.creating"
          aria-controls="worktree-stash-form"
          :disabled="store.busy"
          @click="stash.openCreate"
        >
          贮藏
        </button>
      </div>
      <StashCreateForm
        v-if="stash.creating"
        id="worktree-stash-form"
      />
      <form
        v-else
        id="worktree-commit-form"
        class="commit-form"
        @submit.prevent="submit"
      >
        <div
          class="commit-editor"
          :class="{ 'description-collapsed': !showDescription }"
        >
          <input
            v-model="title"
            placeholder="用一句话描述这次更改…"
            aria-label="提交说明"
            maxlength="500"
          /><button
            type="button"
            class="description-toggle"
            :aria-expanded="showDescription"
            aria-controls="commit-description"
            :disabled="!!description"
            @click="descriptionExpanded = !descriptionExpanded"
          >
            详细说明{{ description ? '' : '（可选）'
            }}<Icon
              name="ChevronRight"
              :size="11"
              :class="{ 'is-open': showDescription }"
            /></button
          ><textarea
            v-show="showDescription"
            id="commit-description"
            v-model="description"
            placeholder="补充说明（可选）"
            aria-label="提交详细说明"
            maxlength="19000"
          ></textarea
          ><span
            class="message-length"
            :class="{ 'over-length': title.length > 72 }"
            >{{ title.length }} / 72</span
          >
        </div>
        <div
          id="commit-hint"
          class="commit-hint"
          :class="{ 'commit-hint-hidden': !commitBlocked && !scopeHint }"
          role="status"
        >
          <Icon
            name="Info"
            :size="12"
          /><span>{{ commitBlocked || '提交全部已暂存内容，不受勾选或筛选影响' }}</span>
        </div>
        <button
          type="submit"
          class="primary-button commit-button"
          :disabled="!canCommit"
          aria-describedby="commit-hint"
          :title="commitBlocked || `提交全部已暂存内容到 ${store.repo.branch}`"
        >
          <Icon
            :name="store.busy ? 'LoaderCircle' : 'Check'"
            :class="{ spin: store.busy }"
            :size="16"
          /><span>提交 {{ store.repo.staged.length }} 个文件</span><kbd>Ctrl ↵</kbd>
        </button>
      </form>
    </template>
  </aside>
</template>

<style scoped>
.commit-hint.commit-hint-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.commit-button {
  margin-top: 8px;
}
.inspector .description-toggle {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 4px 11px 7px;
  color: var(--text-secondary);
  font-size: 10px;
}
.description-toggle svg {
  transition: transform 120ms ease;
}
.description-toggle svg.is-open {
  transform: rotate(90deg);
}
.commit-editor.description-collapsed .message-length {
  bottom: 6px;
}
.inspector .commit-form {
  flex-shrink: 0;
  padding: 10px 12px 12px;
}
.inspector .commit-editor textarea {
  height: 72px;
  max-height: 125px;
}
.inspector .commit-hint {
  margin: 7px 0;
  font-size: 10px;
}

.worktree-compose-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  padding: 8px 15px 0;
  border-top: 1px solid var(--line);
  background: var(--surface-tabs);
}
.worktree-compose-tabs button {
  min-height: 27px;
  padding: 0 10px;
  font-size: 11px;
  border-radius: 3px;
  color: var(--text-secondary);
}
.worktree-compose-tabs button[aria-selected='true'] {
  color: var(--bright);
  background: var(--view-selection-bg);
}
.worktree-compose-tabs + .commit-form {
  border-top: 0;
  padding-top: 10px;
}
.worktree-compose-tabs + #worktree-stash-form {
  padding-top: 12px;
}
</style>
