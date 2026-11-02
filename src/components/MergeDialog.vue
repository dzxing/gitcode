<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMergeStore } from '../stores/merge'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import type { MergeConflict } from '../types'
const merge = useMergeStore(),
  repo = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>(),
  selected = ref('')
const supported = (file: MergeConflict) =>
  Object.values(file.stages).every((stage) => ['100644', '100755'].includes(stage.mode))
const disabled = computed(() => repo.busy || merge.loading)
let previous: HTMLElement | null = null
watch(
  () => repo.modal === 'merge-conflicts',
  async (open) => {
    if (open) {
      previous = document.activeElement as HTMLElement
      selected.value = merge.state?.files[0]?.path || ''
      await nextTick()
      dialog.value?.showModal()
      dialog.value?.querySelector<HTMLButtonElement>('.conflict-file-name,.merge-later')?.focus()
    } else {
      dialog.value?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  },
)
async function choose(file: string, choice: 'ours' | 'theirs') {
  await merge.openFile(file)
  if (merge.session.file?.path === file && merge.session.editor && !merge.session.error)
    await merge.resolve(choice)
}
function returnToDraft() {
  merge.session.editor = true
  repo.modal = null
}
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog merge-dialog"
    aria-labelledby="merge-dialog-title"
    @cancel.prevent="merge.close"
    @click="$event.target === dialog && merge.close()"
  >
    <div
      v-if="merge.state"
      class="dialog-content"
    >
      <button
        class="icon-button dialog-close"
        aria-label="关闭冲突列表"
        :disabled="disabled"
        @click="merge.close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <h2 id="merge-dialog-title">
        {{
          merge.state.active
            ? merge.state.files.length
              ? '解决冲突'
              : '检查合并结果'
            : '解决恢复冲突'
        }}
      </h2>
      <p>
        {{ merge.state.branch
        }}<span v-if="merge.state.active"> ← {{ merge.state.incoming.slice(0, 7) }}</span> ·
        {{ merge.state.files.length }} 个未解决文件
      </p>
      <p
        v-if="!merge.state.active"
        class="merge-list-hint"
      >
        修改恢复时发生冲突。处理后保留为工作区修改，无需创建合并提交；贮藏记录保留，确认后可手动删除。
      </p>
      <p class="merge-list-hint">
        双击文件手动处理；“采用”操作替换整个文件。关闭列表后可以继续处理。
      </p>
      <div
        v-if="merge.state.files.length"
        class="conflict-file-list"
        aria-label="冲突文件"
      >
        <div
          v-for="file in merge.state.files"
          :key="file.path"
          class="conflict-file"
          :class="{ selected: selected === file.path }"
        >
          <button
            class="conflict-file-name"
            :title="file.path"
            :disabled="disabled || !supported(file)"
            @click="selected = file.path"
            @dblclick="merge.openFile(file.path)"
            @keydown.enter.prevent="merge.openFile(file.path)"
          >
            <Icon
              name="FileCode2"
              :size="14"
            /><span>{{ file.path }}</span
            ><small>{{
              !supported(file)
                ? '需外部工具'
                : !file.stages['2'] || !file.stages['3']
                  ? '删除／新增冲突'
                  : '内容冲突'
            }}</small>
          </button>
          <button
            class="text-button"
            :disabled="disabled || merge.dirty || !supported(file)"
            @click="choose(file.path, 'ours')"
          >
            {{ file.stages['2'] ? '采用当前分支' : '接受当前侧删除' }}
          </button>
          <button
            class="text-button"
            :disabled="disabled || merge.dirty || !supported(file)"
            @click="choose(file.path, 'theirs')"
          >
            {{
              file.stages['3']
                ? merge.state.active
                  ? '采用合入版本'
                  : '采用恢复版本'
                : '接受恢复侧删除'
            }}
          </button>
        </div>
      </div>
      <button
        v-if="merge.state.files.length"
        class="secondary-button manual-resolve"
        :disabled="
          disabled ||
          !selected ||
          !merge.state.files.some((file) => file.path === selected && supported(file))
        "
        @click="merge.openFile(selected)"
      >
        手动处理所选文件
      </button>
      <button
        v-if="merge.dirty"
        class="secondary-button"
        :disabled="disabled"
        @click="returnToDraft"
      >
        返回未保存草稿
      </button>
      <div
        v-if="merge.session.resolved.length"
        class="resolved-files"
      >
        <strong>本次已处理</strong
        ><span
          v-for="file in merge.session.resolved"
          :key="file"
          >✓ {{ file }}</span
        >
      </div>
      <details
        v-if="merge.state.active && merge.state.staged.length"
        class="merge-staged"
      >
        <summary>待合并提交的文件（{{ merge.state.staged.length }}）</summary>
        <span
          v-for="file in merge.state.staged"
          :key="file.path"
          >{{ file.status }} · {{ file.path }}</span
        >
      </details>
      <label
        v-if="merge.state.active && !merge.state.files.length"
        class="merge-message"
        >合并提交说明<textarea
          v-model="merge.session.message"
          aria-label="合并提交说明"
          rows="3"
          :disabled="disabled"
          maxlength="20000"
        />
      </label>
      <p
        v-if="merge.session.error"
        class="merge-error"
        role="alert"
      >
        {{ merge.session.error }}
      </p>
      <div
        v-if="merge.abortSignature"
        class="merge-abort-confirm"
        role="group"
        aria-label="确认中止合并"
      >
        <p>中止会放弃本轮合并及已保存的冲突解决结果，尝试返回合并前的状态。</p>
        <button
          class="secondary-button"
          :disabled="disabled"
          @click="merge.abortSignature = ''"
        >
          继续处理</button
        ><button
          class="secondary-button"
          :disabled="disabled"
          @click="merge.abort"
        >
          确认中止合并
        </button>
      </div>
      <div
        v-else
        class="dialog-actions"
      >
        <button
          v-if="merge.state.active"
          class="text-button merge-abort"
          :disabled="disabled"
          @click="merge.requestAbort"
        >
          中止合并</button
        ><button
          class="secondary-button merge-later"
          :disabled="disabled"
          @click="merge.close"
        >
          稍后处理</button
        ><button
          v-if="merge.state.active"
          class="primary-button"
          :disabled="
            disabled || !!merge.state.files.length || !merge.session.message.trim() || merge.dirty
          "
          @click="merge.finish"
        >
          {{ repo.repo.gitflow?.finish ? '完成当前合并并继续' : '完成合并' }}
        </button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.merge-dialog {
  width: min(780px, calc(100vw - 40px));
  max-height: calc(100vh - 50px);
}
.merge-dialog .dialog-content {
  max-height: calc(100vh - 54px);
  overflow: auto;
}
.merge-list-hint {
  font-size: 11px;
}
.conflict-file-list {
  border: 1px solid var(--line);
  border-radius: 4px;
  max-height: 240px;
  overflow: auto;
  margin: 12px 0;
}
.conflict-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  min-height: 40px;
}
.conflict-file.selected {
  background: var(--view-selection-bg);
}
.conflict-file-name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 12px;
}
.conflict-file-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-file-name small {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.conflict-file > .text-button {
  font-size: 11px;
  white-space: nowrap;
}
.manual-resolve {
  margin-bottom: 10px;
}
.resolved-files,
.merge-staged {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
  font-size: 11px;
  color: var(--text-secondary);
}
.merge-staged span {
  display: block;
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.merge-message {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.merge-message textarea {
  resize: vertical;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.merge-error,
.merge-abort {
  color: var(--git-deleted);
}
.merge-abort-confirm {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.merge-abort-confirm button + button {
  margin-left: 8px;
}
.dialog-actions .merge-abort {
  margin-right: auto;
}
@media (max-width: 1000px) {
  .conflict-file {
    flex-wrap: wrap;
  }
  .conflict-file-name {
    flex-basis: 100%;
  }
}
</style>
