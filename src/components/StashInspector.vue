<script setup lang="ts">
import { fileStatusPresentation } from '../fileStatus'
import { vOverflowTitle } from '../directives/overflowTitle'
import { useRepositoryStore } from '../stores/repository'
import { useStashStore } from '../stores/stash'
import Icon from './Icon.vue'
const store = useRepositoryStore(),
  stash = useStashStore()
const shortMessage = (message: string) => message.replace(/^(?:On|WIP on) [^:]+:\s*/, '')
</script>
<template>
  <section
    v-if="stash.selected"
    class="stash-inspector"
    aria-label="贮藏详情"
  >
    <header class="panel-header">
      <div class="panel-title"><Icon name="Archive" /><strong>贮藏详情</strong></div>
      <button
        class="icon-button"
        aria-label="返回工作区"
        title="返回工作区"
        :disabled="store.busy"
        @click="stash.close"
      >
        <Icon name="X" />
      </button>
    </header>
    <div class="stash-detail">
      <span class="stash-ref">{{ stash.selected.ref }}</span>
      <h2>{{ shortMessage(stash.selected.message) }}</h2>
      <p>
        创建时分支 <strong>{{ stash.selected.branch }}</strong>
      </p>
      <p class="stash-repository-note">仓库共享记录，可恢复到其他分支。</p>
      <p>{{ new Date(stash.selected.date).toLocaleString() }}</p>
      <code>{{ stash.selected.oid }}</code
      ><small>创建时的基础提交 {{ stash.selected.base.slice(0, 7) }}</small>
    </div>
    <div class="files-section-head">
      <span class="file-section-title"
        >贮藏文件 <span class="pill">{{ stash.details?.files.length || 0 }}</span></span
      >
    </div>
    <div
      class="inspector-scroll stash-files"
      aria-label="贮藏文件"
    >
      <div
        v-if="stash.loading"
        class="empty-state compact"
        role="status"
      >
        <Icon
          name="LoaderCircle"
          class="spin"
        /><span>正在读取贮藏…</span>
      </div>
      <div
        v-else-if="stash.readError"
        class="read-error"
        role="alert"
      >
        <p>{{ stash.readError }}</p>
        <button
          class="secondary-button"
          :disabled="store.busy"
          @click="stash.recheck"
        >
          刷新
        </button>
      </div>
      <template v-else
        ><button
          v-for="file in stash.details?.files || []"
          :key="file.path"
          class="stash-file"
          :data-file-status="fileStatusPresentation(file.status).kind"
          :class="{ selected: store.selectedFile?.path === file.path }"
          :data-stash-file-path="file.path"
          :aria-pressed="store.selectedFile?.path === file.path"
          :aria-label="`查看贮藏文件差异 ${file.path}`"
          v-overflow-title="{ text: file.path, target: '.file-name, span' }"
          @click="stash.preview(file.path)"
        >
          <Icon
            name="FileCode2"
            :size="14"
          /><span class="stash-file-name">{{ file.path }}</span
          ><small>{{
            file.status === '?'
              ? '未跟踪'
              : stash.details?.stagedPaths.includes(file.path)
                ? '含暂存'
                : ''
          }}</small
          ><code
            class="file-status"
            :class="`status-${fileStatusPresentation(file.status).code}`"
            :title="fileStatusPresentation(file.status).label"
            >{{ fileStatusPresentation(file.status).code }}</code
          >
        </button>
        <p
          v-if="!stash.details?.files.length"
          class="section-empty"
        >
          这条记录没有文件差异。
        </p></template
      >
    </div>
    <footer class="stash-restore-controls">
      <p class="stash-target">
        恢复到当前分支 <strong>{{ store.repo.branch }}</strong>
      </p>
      <label class="stash-checkbox"
        ><input
          v-model="stash.restoreIndex"
          type="checkbox"
          :disabled="store.busy"
        />恢复原暂存状态</label
      >
      <p class="stash-hint">
        默认恢复文件内容；勾选上项会同时尝试还原暂存状态，可能因目标分支差异失败。
      </p>
      <p
        v-if="stash.error"
        class="stash-error"
        role="alert"
      >
        {{ stash.error }}
      </p>
      <p
        v-if="stash.restoreBlocked"
        class="stash-hint"
        role="status"
      >
        {{ stash.restoreBlocked }}
      </p>
      <button
        v-if="stash.stale"
        class="text-button"
        :disabled="store.busy"
        @click="stash.recheck"
      >
        重新检查
      </button>
      <section
        v-if="stash.pendingRestore"
        class="stash-restore-confirm"
        aria-label="确认恢复到有修改的工作区"
      >
        <p role="status">
          当前有未暂存修改，恢复可能产生冲突。Git 不会强制覆盖本地修改；若发生冲突，贮藏记录会保留。
        </p>
        <div class="stash-restore-buttons">
          <button
            class="secondary-button"
            :disabled="store.busy"
            @click="stash.cancelRestore"
          >
            取消恢复
          </button>
          <button
            class="primary-button"
            :disabled="!!stash.restoreBlocked"
            @click="stash.confirmRestore"
          >
            {{
              stash.pendingRestore.operation === 'stash-pop'
                ? '继续恢复，成功后移除'
                : '继续恢复并保留'
            }}
          </button>
        </div>
      </section>
      <div
        v-else
        class="stash-restore-buttons"
      >
        <button
          class="primary-button"
          :disabled="!!stash.restoreBlocked"
          :title="stash.restoreBlocked || undefined"
          @click="stash.restore('stash-apply')"
        >
          <Icon
            v-if="store.busy && store.activeOperation === 'stash-apply'"
            name="LoaderCircle"
            :size="13"
            class="spin"
          />恢复并保留</button
        ><button
          class="secondary-button"
          :disabled="!!stash.restoreBlocked"
          :title="stash.restoreBlocked || undefined"
          @click="stash.restore('stash-pop')"
        >
          <Icon
            v-if="store.busy && store.activeOperation === 'stash-pop'"
            name="LoaderCircle"
            :size="13"
            class="spin"
          />恢复并移除
        </button>
      </div>
      <div class="stash-secondary-actions">
        <button
          class="text-button"
          :disabled="store.busy || stash.selectedMissing"
          @click="stash.requestDelete"
        >
          删除贮藏…</button
        ><button
          v-if="store.repo.unstaged.some((file) => file.status === 'U')"
          class="text-button"
          :disabled="store.busy"
          @click="stash.close"
        >
          查看工作区冲突
        </button>
      </div>
      <button
        v-if="store.busy && store.activeOperation.startsWith('stash-')"
        class="text-button"
        :disabled="store.cancelling"
        @click="store.cancelOperation()"
      >
        {{ store.cancelling ? '正在取消…' : '取消操作' }}
      </button>
      <p
        v-if="store.busy && store.activeOperation.startsWith('stash-')"
        class="stash-hint"
      >
        已完成的操作不会自动撤销。
      </p>
    </footer>
  </section>
</template>
<style scoped>
.stash-inspector {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.stash-inspector > .panel-header {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--panel);
}
.stash-detail {
  padding: 14px 15px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  min-width: 0;
}
.stash-ref {
  color: var(--theme-purple-text, #bd93d7);
  font: var(--ui-font-help)/1.5 var(--mono);
}
.stash-detail h2 {
  margin: 8px 0 10px;
  overflow-wrap: anywhere;
  max-height: 75px;
  overflow: auto;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
.stash-detail p {
  margin: 5px 0;
  font-size: var(--ui-font-help);
  color: var(--text-secondary);
}
.stash-detail code {
  display: block;
  font-size: var(--ui-font-help);
  color: var(--muted);
  overflow-wrap: anywhere;
  margin-top: 10px;
}
.stash-detail > small {
  display: block;
  font-size: var(--ui-font-help);
  color: var(--muted);
  margin-top: 6px;
}
.stash-files {
  flex: 1;
  min-height: 80px;
  padding: 4px 6px;
}
.stash-file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  padding: 0 7px;
  border-radius: 3px;
  font-size: var(--ui-font-size);
  text-align: left;
}
.stash-file > svg {
  flex-shrink: 0;
  color: var(--icon-color);
}
.stash-file > span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stash-file > small {
  flex-shrink: 0;
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.stash-file > code {
  flex-shrink: 0;
  font-size: var(--ui-font-size);
}
.stash-file:hover {
  background: var(--control-hover-bg);
}
.stash-file.selected {
  background: var(--view-selection-bg);
}
.stash-restore-confirm {
  font-size: var(--ui-font-help);
  line-height: 1.7;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
}
.stash-restore-confirm p {
  margin: 0 0 10px;
}
.stash-restore-controls {
  flex-shrink: 0;
  padding: 12px 15px 16px;
  border-top: 1px solid var(--line);
  background: var(--surface-tabs);
}
.stash-target {
  font-size: var(--ui-font-help);
  margin: 0 0 10px;
  overflow-wrap: anywhere;
}
.stash-target strong {
  color: var(--bright);
}
.stash-checkbox {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--ui-font-help);
  margin-bottom: 10px;
}
.stash-checkbox input {
  appearance: auto;
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
}
.stash-hint {
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
  line-height: 1.7;
  margin: 10px 0;
}
.stash-error {
  color: var(--git-deleted);
  font-size: var(--ui-font-help);
  line-height: 1.7;
  max-height: 110px;
  overflow: auto;
  overflow-wrap: anywhere;
}
.stash-restore-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.stash-restore-buttons button {
  flex: 1;
  min-width: 100px;
  font-size: var(--ui-font-size);
  padding: 0 8px;
}
.stash-secondary-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 9px;
}
.stash-secondary-actions button,
.stash-restore-controls > .text-button {
  font-size: var(--ui-font-size);
}
</style>
