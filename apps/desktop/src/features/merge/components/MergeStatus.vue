<script setup lang="ts">
import { useMergeStore } from '../stores/merge'
import { useRepositoryStore } from '../../repository/stores/repository'
import Icon from '../../../shared/ui/Icon.vue'
const merge = useMergeStore(),
  repo = useRepositoryStore()
</script>
<template>
  <div
    v-if="!repo.repo.gitflow?.finish && (merge.state || merge.dirty)"
    class="merge-status"
    role="status"
  >
    <Icon
      name="GitMerge"
      :size="15"
    /><strong>{{
      merge.state
        ? merge.state.rebase
          ? '变基进行中'
          : merge.state.active
            ? '合并进行中'
            : '恢复修改有冲突'
        : '冲突处理草稿'
    }}</strong
    ><template v-if="merge.state"
      ><span>{{
        merge.state.files.length
          ? `还有 ${merge.state.files.length} 个冲突文件`
          : merge.state.rebase
            ? '请检查右侧变基进度'
            : merge.state.active
              ? '冲突已解决，请检查并完成合并'
              : '请检查工作区修改'
      }}</span
      ><span
        v-if="merge.state.unsupported"
        :title="merge.state.unsupportedReason"
        >当前操作请通过外部 Git 完成或中止</span
      ><button
        v-else
        class="secondary-button"
        :disabled="repo.busy"
        @click="merge.open"
      >
        {{
          merge.state.rebase
            ? '查看变基进度'
            : merge.state.files.length
              ? '继续处理冲突'
              : '检查合并结果'
        }}
      </button></template
    ><template v-else
      ><span>仓库冲突状态已结束，未保存的编辑结果仍保留。</span
      ><button
        class="secondary-button"
        :disabled="repo.busy"
        @click="merge.session.editor = true"
      >
        返回草稿
      </button></template
    >
  </div>
</template>
<style scoped>
.merge-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 7px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
}
.merge-status > svg,
.merge-status > strong {
  color: var(--git-modified);
}
.merge-status > button {
  margin-left: auto;
  min-height: 26px;
  font-size: var(--ui-font-size);
}
</style>
