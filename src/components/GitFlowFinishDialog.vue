<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useGitFlowFinishStore, finishLabels } from '../stores/gitflowFinish'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
const finish = useGitFlowFinishStore(),
  repo = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>()
let previous: HTMLElement | null = null
watch(
  () => repo.modal === 'gitflow-finish',
  async (open) => {
    if (open) {
      previous = document.activeElement as HTMLElement
      await nextTick()
      dialog.value?.showModal()
      const focusTarget =
        dialog.value?.querySelector<HTMLElement>('select') ||
        dialog.value?.querySelector<HTMLElement>('#flow-finish-title')
      focusTarget?.focus()
    } else {
      dialog.value?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  },
)
</script>
<template>
  <dialog
    ref="dialog"
    class="dialog flow-finish-dialog"
    aria-labelledby="flow-finish-title"
    @cancel.prevent="finish.close"
    @click="$event.target === dialog && finish.close()"
  >
    <div class="dialog-content">
      <button
        class="icon-button dialog-close"
        aria-label="关闭 GitFlow 完成确认"
        :disabled="repo.busy"
        @click="finish.close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <h2
        id="flow-finish-title"
        tabindex="-1"
      >
        {{ finish.type ? finishLabels[finish.type] : '完成 GitFlow 分支' }}
      </h2>
      <div class="flow-finish-scroll">
        <p>使用本地已有提交执行合并，不自动获取或推送。</p>
        <label
          v-if="finish.canChooseBranch"
          class="flow-finish-field"
          >完成分支<select
            class="form-input"
            :value="finish.branch"
            aria-label="要完成的 GitFlow 分支"
            :disabled="repo.busy"
            @change="finish.select(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="branch in finish.candidates"
              :key="branch.name"
              :value="branch.name"
            >
              {{ branch.name }}
            </option>
          </select></label
        >
        <div
          v-else
          class="flow-finish-source"
        >
          <small>完成分支</small><strong>{{ finish.branch }}</strong>
        </div>
        <div class="flow-finish-targets">
          <strong>本次操作</strong
          ><span
            v-for="(target, i) in finish.targets"
            :key="target"
            >{{ i === 0 ? finish.branch : finish.targets[0] }} → {{ target }}</span
          ><small>使用 Merge 合并并保留分支历史。发生冲突时暂停，解决后继续。</small>
        </div>
        <fieldset :disabled="repo.busy">
          <label class="flow-finish-check"
            ><input
              v-model="finish.deleteBranch"
              type="checkbox"
            />完成后删除本地分支</label
          ><label
            v-if="finish.type && finish.type !== 'feature'"
            class="flow-finish-check"
            ><input
              v-model="finish.createTag"
              type="checkbox"
            />创建版本标签</label
          ><template v-if="finish.createTag"
            ><label class="flow-finish-field"
              >标签名称<input
                autocomplete="off"
                v-model="finish.tagName"
                aria-label="版本标签名称"
                maxlength="200" /></label
            ><label class="flow-finish-field"
              >标签说明<textarea
                autocomplete="off"
                v-model="finish.tagMessage"
                aria-label="版本标签说明"
                rows="2"
                maxlength="20000"
              /></label
            ><small>附注标签标记生产分支的合并结果，遵循本机 Git 签名设置。</small></template
          >
        </fieldset>
        <p>完成后停留在 {{ finish.targets.at(-1) || '开发分支' }}。远端分支保持不变。</p>
        <p
          v-if="finish.blocked"
          class="flow-finish-reason"
        >
          {{ finish.blocked }}
        </p>
        <p
          v-if="finish.error"
          class="flow-finish-error"
          role="alert"
        >
          {{ finish.error }}
          <button
            class="text-button"
            :disabled="repo.busy"
            @click="finish.reread"
          >
            重新检查
          </button>
        </p>
      </div>
      <div class="dialog-actions">
        <button
          class="secondary-button flow-finish-cancel"
          :disabled="repo.busy"
          @click="finish.close"
        >
          取消</button
        ><button
          class="primary-button"
          :disabled="!!finish.blocked"
          @click="finish.finish"
        >
          {{ repo.busy ? '正在完成…' : finish.type ? finishLabels[finish.type] : '完成分支' }}
        </button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.flow-finish-dialog {
  width: 520px;
}
.flow-finish-dialog .dialog-content {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 64px);
  overflow: hidden;
}
.flow-finish-scroll {
  overflow-y: auto;
  min-height: 0;
  padding-right: 4px;
}
.flow-finish-dialog h2,
.flow-finish-dialog .dialog-actions {
  flex-shrink: 0;
}
.flow-finish-dialog .dialog-actions {
  margin-top: 14px;
}
.flow-finish-dialog h2:focus {
  outline: none;
}
.flow-finish-source {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--dialog-font-body);
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.flow-finish-source small {
  color: var(--text-secondary);
}
.flow-finish-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--dialog-font-body);
  margin: 12px 0;
}
.flow-finish-field input,
.flow-finish-field textarea,
.flow-finish-field select {
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  min-width: 0;
  max-width: 100%;
  font-family: var(--font-ui);
  font-size: var(--dialog-font-body);
  line-height: 1.5;
}
.flow-finish-field :is(input, textarea, select):focus {
  border-color: var(--accent);
  outline: 1px solid var(--accent);
  outline-offset: 0;
}
.flow-finish-targets {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  margin: 12px 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: var(--dialog-font-body);
  overflow-wrap: anywhere;
}
.flow-finish-targets small,
fieldset > small {
  font-size: var(--dialog-font-help);
  color: var(--text-secondary);
  line-height: 1.6;
}
.flow-finish-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  font-size: var(--dialog-font-body);
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.flow-finish-reason {
  color: var(--git-modified);
}
.flow-finish-error {
  color: var(--git-deleted);
}
.flow-finish-field textarea {
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
</style>
