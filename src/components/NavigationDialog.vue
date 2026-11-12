<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useNavigationStore } from '../stores/navigation'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
const navigation = useNavigationStore(),
  repo = useRepositoryStore(),
  dialog = ref<HTMLDialogElement>()
let previous: HTMLElement | null = null
watch(
  () => repo.modal === 'navigation',
  async (open) => {
    if (open) {
      previous = document.activeElement as HTMLElement
      await nextTick()
      dialog.value?.showModal()
      dialog.value?.querySelector<HTMLElement>('input, .navigation-cancel')?.focus()
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
    class="dialog navigation-dialog"
    :class="{
      'navigation-comparison': navigation.comparing,
      'prompt-bar': !navigation.comparing,
      'dialog-confirmation': navigation.mode === 'delete-remote-branch',
    }"
    aria-labelledby="navigation-title"
    @cancel.prevent="navigation.close"
    @click="$event.target === dialog && navigation.close()"
  >
    <form
      autocomplete="off"
      v-if="navigation.target"
      class="dialog-content"
      @submit.prevent="navigation.execute"
    >
      <button
        type="button"
        class="icon-button dialog-close"
        aria-label="关闭导航操作"
        :disabled="navigation.writing || repo.busy"
        @click="navigation.close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
      <h2 id="navigation-title">{{ navigation.heading }}</h2>
      <p class="navigation-target">
        <strong>{{ navigation.target.name }}</strong
        ><code>{{ navigation.info?.oid.slice(0, 12) || navigation.target.hash.slice(0, 12) }}</code>
      </p>
      <template v-if="navigation.mode === 'merge-branch' || navigation.mode === 'fast-forward'">
        <p>
          来源：{{ navigation.target.name }} → 当前分支：<strong>{{
            navigation.info?.branch || repo.repo.branch
          }}</strong>
        </p>
        <p>
          {{
            navigation.mode === 'fast-forward'
              ? '只移动当前分支到来源提交，不创建合并提交。'
              : '将来源提交合入当前分支。发生冲突时进入冲突处理，产生合并提交前可检查结果。'
          }}
        </p>
        <p>本地修改会自动贮藏，成功后恢复；发生冲突或中断时保留恢复记录。不会自动推送。</p>
      </template>
      <template
        v-if="navigation.mode === 'create-tag' || navigation.mode === 'create-annotated-tag'"
      >
        <label for="navigation-tag-name">标签名称</label
        ><input
          autocomplete="off"
          id="navigation-tag-name"
          v-model="navigation.name"
          class="form-input"
          required
          :disabled="navigation.writing"
          placeholder="v1.0.0"
          spellcheck="false"
        />
        <label v-if="navigation.mode === 'create-tag'"
          ><input
            v-model="navigation.tagAnnotated"
            type="checkbox"
            :disabled="navigation.writing || repo.busy"
          />
          创建附注标签</label
        >
        <template v-if="navigation.annotated"
          ><label for="navigation-tag-message">标签说明</label
          ><textarea
            autocomplete="off"
            id="navigation-tag-message"
            v-model="navigation.message"
            class="form-input"
            rows="4"
            required
            :disabled="navigation.writing"
          />
        </template>
        <p>
          在上方提交创建{{
            navigation.annotated ? '附注' : '轻量'
          }}标签，仅保存在本地，不覆盖已有标签。
        </p>
      </template>
      <template v-if="navigation.mode === 'delete-remote-branch'">
        <p>
          将删除服务器上的
          <strong
            >{{ navigation.info?.remote?.remote }} /
            {{ navigation.info?.remote?.remoteRef.replace(/^refs\/heads\//, '') }}</strong
          >。
        </p>
        <p>本地分支会保留。操作会再次核对远程提交；远程期间有更新时停止删除。</p>
        <p
          v-if="navigation.info?.remote"
          class="navigation-check"
          role="status"
        >
          已核对远程提交 {{ navigation.info.remote.oid.slice(0, 12) }}
        </p>
      </template>
      <p
        v-if="navigation.loading"
        role="status"
      >
        正在读取{{ navigation.mode === 'delete-remote-branch' ? '远程状态' : '引用和比较结果' }}…
      </p>
      <p
        v-if="navigation.stale"
        class="directory-error"
        role="alert"
      >
        当前仓库状态已变化，请关闭后重新打开操作。
      </p>
      <p
        v-if="navigation.error"
        class="directory-error"
        role="alert"
      >
        {{ navigation.error }}
      </p>
      <p
        v-if="
          navigation.blocked && !navigation.loading && !navigation.error && !navigation.comparing
        "
        class="form-help"
        role="status"
      >
        {{ navigation.blocked }}
      </p>
      <section
        v-if="navigation.comparing"
        class="navigation-compare"
        aria-label="分支比较结果"
      >
        <p>
          左侧基准：{{ navigation.target.name }}；右侧：{{
            navigation.mode === 'compare-working'
              ? '当前工作区（含暂存、未暂存和未跟踪文件）'
              : repo.repo.branch
          }}
        </p>
        <div class="navigation-compare-grid">
          <nav aria-label="比较文件">
            <button
              v-for="entry in navigation.info?.files || []"
              :key="entry.path"
              type="button"
              :class="{ selected: navigation.file === entry.path }"
              :aria-busy="navigation.loading && navigation.file === entry.path"
              :disabled="navigation.stale"
              @click="navigation.read(entry.path)"
            >
              <small>{{ entry.status }}</small
              ><span>{{ entry.path }}</span>
            </button>
          </nav>
          <div
            class="navigation-compare-diff"
            aria-label="比较差异"
          >
            <p v-if="!navigation.info?.files?.length && !navigation.loading">没有文件差异。</p>
            <p v-else-if="!navigation.file">选择文件查看差异。</p>
            <pre
              v-else
            ><code v-for="(line,index) in (navigation.info?.diff?.diff||'').split('\n')" :key="index" :class="line.startsWith('+')?'added':line.startsWith('-')?'removed':''">{{line}}<br /></code></pre>
            <p v-if="navigation.info?.diff?.truncated">差异内容过长，已截断显示。</p>
          </div>
        </div>
      </section>
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary-button navigation-cancel"
          :disabled="navigation.writing || repo.busy"
          @click="navigation.close"
        >
          {{ navigation.comparing ? '关闭' : '取消' }}
        </button>
        <button
          type="button"
          class="secondary-button"
          :disabled="navigation.loading || navigation.writing || repo.busy || navigation.stale"
          @click="navigation.read()"
        >
          {{ navigation.comparing ? '刷新比较' : '重新核对' }}
        </button>
        <button
          v-if="!navigation.comparing"
          type="submit"
          :class="navigation.mode === 'delete-remote-branch' ? 'danger-button' : 'primary-button'"
          :disabled="
            !!navigation.blocked ||
            ((navigation.mode === 'create-tag' || navigation.mode === 'create-annotated-tag') &&
              !navigation.name.trim()) ||
            (navigation.annotated && !navigation.message.trim())
          "
        >
          {{
            navigation.writing
              ? '正在执行…'
              : navigation.mode === 'delete-remote-branch'
                ? '确认删除远程分支'
                : navigation.heading
          }}
        </button>
      </div>
    </form>
  </dialog>
</template>
<style scoped>
.navigation-dialog {
  width: 560px;
  max-height: calc(100dvh - 48px);
}
.dialog-content {
  max-height: calc(100dvh - 52px);
  overflow: auto;
}
.navigation-target {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow-wrap: anywhere;
}
.navigation-target code {
  font: var(--ui-font-help)/1.5 var(--mono);
  color: var(--muted);
}
.navigation-check {
  color: var(--git-added);
}
.navigation-comparison {
  width: 1100px;
}
.navigation-compare-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: min(480px, 50vh);
  border: 1px solid var(--line);
}
.navigation-compare-grid nav {
  overflow: auto;
  border-right: 1px solid var(--line);
}
.navigation-compare-grid nav button {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  padding: 7px 10px;
  text-align: left;
  gap: 8px;
  font-size: var(--dialog-font-body);
}
.navigation-compare-grid nav span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.navigation-compare-grid nav small {
  color: var(--muted);
}
.navigation-compare-grid nav button.selected {
  background: var(--view-selection-bg);
}
.navigation-compare-diff {
  overflow: auto;
  padding: 10px;
  font-size: var(--ui-font-help);
}
.navigation-compare-diff pre {
  margin: 0;
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
  white-space: pre;
}
.navigation-compare-diff code {
  font: inherit;
}
.added {
  color: var(--git-added);
}
.removed {
  color: var(--git-deleted);
}
#navigation-tag-message {
  font: var(--code-font-size)/var(--code-line-height) var(--font-code);
  font-variant-ligatures: var(--code-ligatures);
}
</style>
