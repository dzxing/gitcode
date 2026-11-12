<script setup lang="ts">
import { useGitFlowFinishStore } from '../stores/gitflowFinish'
import { useRepositoryStore } from '../stores/repository'
import { useMergeStore } from '../stores/merge'
const finish = useGitFlowFinishStore(),
  repo = useRepositoryStore(),
  merge = useMergeStore()
</script>
<template>
  <section
    v-if="finish.progress"
    class="flow-finish-progress"
    aria-label="GitFlow 执行进度"
  >
    <div class="flow-finish-progress-head">
      <strong>GitFlow · {{ finish.progress.branch }}</strong
      ><span
        >{{ finish.progress.index }} / {{ finish.progress.steps.length }} ·
        {{ finish.progress.current }}</span
      ><button
        v-if="repo.repo.merge"
        class="secondary-button"
        :disabled="repo.busy"
        @click="merge.open"
      >
        {{
          repo.repo.merge?.files.length
            ? `解决冲突（${repo.repo.merge.files.length}）`
            : '完成当前合并'
        }}</button
      ><button
        v-else
        class="primary-button"
        :disabled="repo.busy || finish.progress.blocked"
        @click="finish.resume"
      >
        继续完成 GitFlow</button
      ><button
        v-if="merge.dirty && !repo.repo.merge"
        class="secondary-button"
        :disabled="repo.busy"
        @click="merge.session.editor = true"
      >
        返回处理草稿</button
      ><button
        class="text-button"
        :disabled="repo.busy || !!repo.repo.merge || finish.progress.blocked"
        @click="finish.requestStop"
      >
        停止后续步骤
      </button>
    </div>
    <details>
      <summary>查看已执行步骤</summary>
      <div
        v-for="(step, index) in finish.progress.steps"
        :key="index"
      >
        {{ step.done ? '✓' : '○' }} {{ step.label }}
      </div>
    </details>
    <p
      v-if="finish.progress.error || finish.error"
      role="alert"
    >
      {{ finish.progress.error || finish.error }}
    </p>
    <div
      v-if="finish.stopSignature"
      class="flow-finish-stop"
    >
      <span>停止不会回滚已完成的合并或标签，不会清理工作区修改，也不会强制删除源分支。</span
      ><button
        class="secondary-button"
        :disabled="repo.busy"
        @click="finish.stopSignature = ''"
      >
        保留流程</button
      ><button
        class="secondary-button"
        :disabled="repo.busy"
        @click="finish.stop"
      >
        确认停止后续步骤
      </button>
    </div>
  </section>
</template>
<style scoped>
.flow-finish-progress {
  padding: 7px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  color: var(--text-secondary);
  font-size: var(--ui-font-help);
  flex-shrink: 0;
}
.flow-finish-progress-head {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.flow-finish-progress-head strong {
  color: var(--git-modified);
  overflow-wrap: anywhere;
}
.flow-finish-progress-head > span {
  flex: 1;
  min-width: 0;
}
.flow-finish-progress button {
  font-size: var(--ui-font-size);
  min-height: 26px;
}
.flow-finish-progress details {
  margin-top: 5px;
  max-height: 180px;
  overflow: auto;
}
.flow-finish-progress details div {
  padding: 3px 0;
}
.flow-finish-progress > p {
  color: var(--git-deleted);
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.flow-finish-stop {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 0;
}
.flow-finish-stop span {
  flex: 1;
  min-width: 180px;
}
</style>
