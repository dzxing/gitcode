<script setup lang="ts">
import { useRepositoryStore } from '../../repository/stores/repository'
import { useStashStore } from '../stores/stash'
import Icon from '../../../shared/ui/Icon.vue'
const store = useRepositoryStore(),
  stash = useStashStore()
</script>
<template>
  <form
    autocomplete="off"
    class="stash-create-form"
    aria-label="贮藏当前修改"
    @submit.prevent="stash.create"
  >
    <label for="stash-name">贮藏名称 <small>可选，留空自动命名</small></label>
    <input
      autocomplete="off"
      id="stash-name"
      v-model="stash.message"
      class="form-input"
      maxlength="500"
      placeholder="临时保存的修改…"
      :disabled="store.busy"
    />
    <label class="stash-checkbox"
      ><input
        v-model="stash.includeUntracked"
        type="checkbox"
        :disabled="store.busy"
      />包含未跟踪文件 <small>{{ stash.untrackedCount }} 个</small></label
    >
    <p class="stash-scope">
      全部已暂存及未暂存修改，不受勾选或筛选影响。忽略文件不包含，提交说明草稿保留。
    </p>
    <p
      v-if="stash.error"
      class="stash-error"
      role="alert"
    >
      {{ stash.error }}
    </p>
    <p
      class="stash-hint"
      role="status"
    >
      {{ stash.createBlocked || `收起 ${stash.count} 个文件的修改，稍后可从图谱恢复。` }}
    </p>
    <button
      class="primary-button stash-create-submit"
      :disabled="!!stash.createBlocked"
      :title="stash.createBlocked || '收起全部符合范围的修改'"
      type="submit"
    >
      <Icon
        :name="store.busy && store.activeOperation === 'stash-create' ? 'LoaderCircle' : 'Archive'"
        :class="{ spin: store.busy && store.activeOperation === 'stash-create' }"
        :size="15"
      />贮藏（{{ stash.count }}）
    </button>
    <button
      v-if="store.busy && store.activeOperation === 'stash-create'"
      class="text-button stash-cancel"
      :disabled="store.cancelling"
      type="button"
      @click="store.cancelOperation()"
    >
      {{ store.cancelling ? '正在取消…' : '取消操作' }}
    </button>
    <p
      v-if="store.busy && store.activeOperation === 'stash-create'"
      class="stash-hint"
    >
      已完成的操作不会自动撤销。
    </p>
  </form>
</template>
<style scoped>
.stash-create-form {
  padding: 0 15px 17px;
  background: var(--surface-tabs);
  font-size: var(--ui-font-size);
}
.stash-create-form > label:first-child {
  display: block;
  margin: 0 0 8px;
}
.stash-create-form small {
  color: var(--muted);
  font-size: var(--ui-font-help);
}
.stash-checkbox {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 12px 0;
}
.stash-checkbox input {
  appearance: auto;
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
}
.stash-scope,
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
  overflow-wrap: anywhere;
}
.stash-create-submit {
  width: 100%;
  font-size: var(--ui-font-size);
  min-height: 36px;
}
.stash-cancel {
  margin-top: 8px;
  font-size: var(--ui-font-size);
}
.stash-create-form input:not([type='checkbox']) {
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
</style>
