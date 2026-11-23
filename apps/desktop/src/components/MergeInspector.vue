<script setup lang="ts">
import { vOverflowTitle } from '../directives/overflowTitle'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useMergeStore } from '../stores/merge'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import type { MergeConflict } from '../types'
const merge = useMergeStore(),
  repo = useRepositoryStore()
const panel = ref<HTMLElement>()
const skipConfirm = ref(false)
const operationName = computed(() =>
  merge.state?.sequence === 'cherry-pick'
    ? '优选'
    : merge.state?.sequence === 'revert'
      ? '还原'
      : '合并',
)
const title = computed(() =>
  !merge.state?.active ? '解决恢复冲突' : merge.state.files.length ? '解决冲突' : '检查合并结果',
)
const supported = (file: MergeConflict) =>
  Object.values(file.stages).every((stage) => ['100644', '100755'].includes(stage.mode))
const disabled = computed(() => repo.busy || merge.loading)
const resolved = computed(() => {
  const unresolved = new Set(merge.state?.files.map((file) => file.path))
  return [
    ...new Set([
      ...(merge.state?.staged.map((file) => file.path) || []),
      ...merge.session.resolved,
    ]),
  ].filter((file) => !unresolved.has(file))
})
onMounted(async () => {
  await nextTick()
  panel.value
    ?.querySelector<HTMLButtonElement>('.conflict-file-name,.merge-finish,.merge-later')
    ?.focus({ preventScroll: true })
})
async function choose(file: string, choice: 'ours' | 'theirs') {
  await merge.openFile(file, false, false)
  if (merge.session.file?.path === file && !merge.session.error) await merge.resolve(choice)
}
function returnToDraft() {
  merge.session.editor = true
}
</script>
<template>
  <section
    v-if="merge.state"
    ref="panel"
    class="merge-inspector"
    :aria-label="title"
  >
    <header class="panel-header">
      <div class="panel-title">
        <Icon
          name="GitMerge"
          :size="15"
        /><strong>{{ title }}</strong>
      </div>
      <button
        class="icon-button"
        aria-label="返回工作区"
        title="返回工作区，保留当前冲突处理状态"
        :disabled="disabled"
        @click="merge.close"
      >
        <Icon
          name="X"
          :size="15"
        />
      </button>
    </header>
    <div class="merge-context">
      <strong v-overflow-title="merge.state.branch">{{ merge.state.branch }}</strong>
      <span v-if="merge.state.active"
        >{{ operationName }} {{ merge.state.incoming.slice(0, 7) }}</span
      >
      <p v-if="!merge.state.active">
        修改恢复时发生冲突。解决后保留为工作区修改，无需创建合并提交；贮藏记录保留。
      </p>
      <p v-else>
        点击冲突文件打开三方编辑器；解决全部文件后继续{{ operationName }}，之后手动推送。{{
          merge.state.sequence ? '没有可提交的更改时，可核对后跳过当前提交。' : ''
        }}
      </p>
    </div>
    <div class="merge-files-scroll">
      <div class="merge-section-head">
        <strong>冲突文件</strong><span>{{ merge.state.files.length }}</span>
      </div>
      <div
        class="conflict-file-list"
        aria-label="冲突文件"
      >
        <div
          v-for="file in merge.state.files"
          :key="file.path"
          class="conflict-file"
        >
          <button
            class="conflict-file-name"
            v-overflow-title="{ text: file.path, target: '.file-name, span' }"
            :disabled="disabled || !supported(file)"
            @click="merge.openFile(file.path)"
          >
            <Icon
              name="FileCode2"
              :size="14"
            /><span>{{ file.path }}</span>
          </button>
          <small v-if="!supported(file)">请通过外部 Git 处理此文件</small>
          <div
            v-else
            class="conflict-file-actions"
          >
            <button
              class="text-button"
              :disabled="disabled || merge.dirty"
              @click="choose(file.path, 'ours')"
            >
              {{ file.stages['2'] ? '采用当前分支' : '接受当前侧删除' }}
            </button>
            <button
              class="text-button"
              :disabled="disabled || merge.dirty"
              @click="choose(file.path, 'theirs')"
            >
              {{
                file.stages['3']
                  ? merge.state.active
                    ? '采用合入版本'
                    : '采用恢复版本'
                  : '接受传入侧删除'
              }}
            </button>
          </div>
        </div>
        <p
          v-if="!merge.state.files.length"
          class="merge-empty"
        >
          冲突已全部解决
        </p>
      </div>
      <div class="merge-section-head">
        <strong>{{ merge.state.active ? '待合并文件' : '已解决文件' }}</strong
        ><span>{{ resolved.length }}</span>
      </div>
      <div class="resolved-files">
        <span
          v-for="file in resolved"
          :key="file"
          v-overflow-title="file"
          ><Icon
            name="Check"
            :size="12"
          />{{ file }}</span
        >
        <p
          v-if="!resolved.length"
          class="merge-empty"
        >
          尚无已解决文件
        </p>
      </div>
      <button
        v-if="merge.dirty"
        class="secondary-button"
        :disabled="disabled"
        @click="returnToDraft"
      >
        返回未保存草稿
      </button>
      <p
        v-if="merge.session.error"
        class="merge-error"
        role="alert"
      >
        {{ merge.session.error }}
      </p>
    </div>
    <footer class="merge-inspector-footer">
      <label
        v-if="merge.state.active && !merge.state.sequence"
        class="merge-message"
        >合并提交说明<textarea
          autocomplete="off"
          v-model="merge.session.message"
          aria-label="合并提交说明"
          rows="3"
          :disabled="disabled"
          maxlength="20000"
        />
      </label>
      <div
        v-if="merge.abortSignature"
        class="merge-abort-confirm"
        role="group"
        aria-label="确认中止合并"
      >
        <p>中止会放弃本轮{{ operationName }}及已保存的冲突解决结果，尝试返回操作前的状态。</p>
        <button
          class="secondary-button"
          :disabled="disabled"
          @click="merge.abortSignature = ''"
        >
          继续处理
        </button>
        <button
          class="secondary-button"
          :disabled="disabled"
          @click="merge.abort"
        >
          确认中止{{ operationName }}
        </button>
      </div>
      <div
        v-else
        class="merge-inspector-actions"
      >
        <button
          v-if="merge.state.active"
          class="primary-button merge-finish"
          :disabled="
            disabled ||
            !!merge.state.files.length ||
            (!merge.state.sequence && !merge.session.message.trim()) ||
            merge.dirty
          "
          @click="merge.finish"
        >
          {{
            merge.state.sequence
              ? `继续${operationName}`
              : repo.repo.gitflow?.finish
                ? '完成当前合并并继续'
                : '完成合并'
          }}
        </button>
        <div v-if="merge.state.sequence">
          <span v-if="skipConfirm">将丢弃当前提交的补丁及解决结果。</span>
          <button
            class="text-button"
            :disabled="disabled || merge.dirty"
            @click="skipConfirm ? (merge.skip(), (skipConfirm = false)) : (skipConfirm = true)"
          >
            {{ skipConfirm ? '确认跳过当前提交' : '跳过当前提交…' }}
          </button>
          <button
            v-if="skipConfirm"
            class="text-button"
            @click="skipConfirm = false"
          >
            取消
          </button>
        </div>
        <div>
          <button
            v-if="merge.state.active"
            class="text-button merge-abort"
            :disabled="disabled"
            @click="merge.requestAbort"
          >
            中止{{ operationName }}
          </button>
          <button
            class="text-button merge-later"
            :disabled="disabled"
            @click="merge.close"
          >
            稍后处理
          </button>
        </div>
      </div>
    </footer>
  </section>
</template>
<style scoped>
.merge-inspector {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.panel-header {
  padding: 0 12px;
  flex-shrink: 0;
}
.panel-title {
  min-width: 0;
}
.panel-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-context {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  font-size: var(--ui-font-help);
}
.merge-context > strong {
  display: block;
  overflow-wrap: anywhere;
  color: var(--text);
}
.merge-context > span {
  color: var(--text-secondary);
}
.merge-context p {
  font-size: var(--ui-font-help);
  margin: 7px 0 0;
  line-height: 1.6;
  color: var(--text-secondary);
}
.merge-files-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.merge-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 5px;
  font-size: var(--ui-font-help);
  color: var(--text-secondary);
}
.merge-section-head strong {
  color: var(--text);
  font-weight: 500;
}
.conflict-file {
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}
.conflict-file-name {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  font-size: var(--ui-font-size);
  min-height: 26px;
  color: var(--file-status-conflict);
}
.conflict-file-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-file-name svg {
  flex-shrink: 0;
}
.conflict-file-name:not(:disabled):hover {
  background: var(--control-hover-bg);
}
.conflict-file-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-left: 21px;
}
.conflict-file-actions button,
.conflict-file small {
  font-size: var(--ui-font-help);
}
.merge-empty {
  margin: 6px 12px 12px;
  font-size: var(--ui-font-help);
  color: var(--text-secondary);
}
.resolved-files {
  padding: 0 12px 8px;
  font-size: var(--ui-font-help);
}
.resolved-files > span {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 5px 0;
  overflow-wrap: anywhere;
}
.resolved-files svg {
  color: var(--file-status-added);
  flex-shrink: 0;
}
.merge-files-scroll > .secondary-button {
  margin: 10px 12px;
}
.merge-inspector-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding: 12px;
  max-height: 48%;
  overflow: auto;
}
.merge-message {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--ui-font-size);
}
.merge-message textarea {
  width: 100%;
  resize: vertical;
  min-height: 60px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
.merge-inspector-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.merge-inspector-actions > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.merge-inspector-actions .text-button {
  font-size: var(--ui-font-size);
}
.merge-abort,
.merge-error {
  color: var(--git-deleted);
}
.merge-error {
  padding: 0 12px;
  font-size: var(--ui-font-help);
  overflow-wrap: anywhere;
}
.merge-abort-confirm {
  font-size: var(--ui-font-help);
}
.merge-abort-confirm button {
  margin: 4px 4px 0 0;
  font-size: var(--ui-font-size);
}
</style>
