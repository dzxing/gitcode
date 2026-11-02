<script setup lang="ts">
import { useRepositoryStore } from '../stores/repository'
import { useStashStore } from '../stores/stash'
import Icon from './Icon.vue'
const store = useRepositoryStore(),
  stash = useStashStore()
</script>
<template>
  <form
    class="stash-create-form"
    aria-label="贮藏当前修改"
    @submit.prevent="stash.create"
  >
    <label for="stash-name">贮藏名称 <small>可选，留空自动命名</small></label>
    <input
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
        :name="store.busy ? 'LoaderCircle' : 'Archive'"
        :class="{ spin: store.busy }"
        :size="15"
      />贮藏并收起修改（{{ stash.count }}）
    </button>
    <button
      v-if="store.busy && store.activeOperation === 'stash-create'"
      class="text-button stash-cancel"
      :disabled="store.cancelling"
      type="button"
      @click="store.cancelOperation()"
    >
      {{ store.cancelling ? '正在取消并核对…' : '取消当前操作（不等于回滚）' }}
    </button>
  </form>
</template>
<style scoped>
.stash-create-form {
  padding: 0 15px 17px;
  background: var(--surface-tabs);
  font-size: 11px;
}
.stash-create-form > label:first-child {
  display: block;
  margin: 0 0 8px;
}
.stash-create-form small {
  color: var(--muted);
  font-size: 10px;
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
  font-size: 10px;
  line-height: 1.7;
  margin: 10px 0;
}
.stash-error {
  color: var(--git-deleted);
  font-size: 11px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.stash-create-submit {
  width: 100%;
  font-size: 11px;
  min-height: 36px;
}
.stash-cancel {
  margin-top: 8px;
  font-size: 10px;
}
</style>
