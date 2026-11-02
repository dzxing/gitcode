<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import { isDesktop, pathName } from '../services/desktop'

const store = useRepositoryStore()
const query = ref('')
const recent = computed(() =>
  store.recent.filter((path) => path.toLowerCase().includes(query.value.trim().toLowerCase())),
)
function openResource(event: MouseEvent, resource: 'git-docs' | 'git-book') {
  if (isDesktop()) {
    event.preventDefault()
    void store.openResource(resource)
  }
}
</script>

<template>
  <main
    class="new-tab-page"
    aria-label="新标签页"
  >
    <section class="new-tab-repositories">
      <div class="new-tab-eyebrow">
        <Icon
          name="FolderGit2"
          :size="15"
        /><span>你的代码，从这里开始</span>
      </div>
      <h1>仓库</h1>
      <div class="repository-actions">
        <button
          class="repository-action"
          aria-label="打开仓库"
          :disabled="store.busy"
          @click="store.modal = 'open'"
        >
          <Icon
            name="FolderOpen"
            :size="20"
          /><span>打开仓库</span><kbd>Ctrl O</kbd>
        </button>
        <button
          class="repository-action"
          :disabled="store.busy"
          @click="store.modal = 'clone'"
        >
          <Icon
            name="Cloud"
            :size="20"
          /><span>克隆仓库</span>
        </button>
        <button
          class="repository-action"
          :disabled="store.busy"
          @click="store.modal = 'create'"
        >
          <Icon
            name="Plus"
            :size="20"
          /><span>创建仓库</span>
        </button>
      </div>
      <div class="recent-heading">
        <h2>最近打开</h2>
        <label
          v-if="store.recent.length"
          class="recent-search"
          ><Icon
            name="Search"
            :size="13" /><input
            v-model="query"
            placeholder="查找仓库…"
            aria-label="查找最近仓库"
        /></label>
      </div>
      <div
        v-if="store.recent.length"
        class="recent-repository-list"
      >
        <div
          v-for="path in recent"
          :key="path"
          class="recent-repository-row"
        >
          <button
            class="recent-repository-main"
            :disabled="store.busy"
            @click="store.open(path)"
          >
            <span class="recent-folder"
              ><Icon
                name="FolderGit2"
                :size="19" /></span
            ><span class="recent-repository-name"
              ><strong>{{ pathName(path) }}</strong
              ><small>{{ path }}</small></span
            ><span
              v-if="store.tabs.some((tab) => tab.kind === 'repository' && tab.path === path)"
              class="already-open"
              >已打开</span
            ><Icon
              name="ChevronRight"
              :size="14"
            /></button
          ><button
            class="icon-button remove-recent"
            :disabled="store.busy"
            :aria-label="`移除最近记录 ${path}`"
            title="移除记录，保留本地仓库"
            @click="store.forgetRecent(path)"
          >
            <Icon
              name="X"
              :size="13"
            />
          </button>
        </div>
        <p
          v-if="!recent.length"
          class="recent-no-match"
        >
          没有匹配的仓库，试试其他关键词。
        </p>
      </div>
      <div
        v-else
        class="recent-empty"
      >
        <Icon
          name="History"
          :size="23"
        />
        <div>
          <strong>下一次，从上次停下的地方继续</strong>
          <p>打开本地仓库后，它会显示在这里。</p>
        </div>
      </div>
      <div class="new-tab-local-note">
        <Icon
          name="ShieldCheck"
          :size="14"
        /><span>本地优先 · 仓库与代码保留在你的电脑上</span>
      </div>
    </section>
    <aside class="new-tab-resources">
      <span class="new-tab-resource-icon"
        ><Icon
          name="Command"
          :size="21"
      /></span>
      <h2>把注意力，留给代码。</h2>
      <p>在分支之间自由切换，让每一次更改都有迹可循。</p>
      <button
        class="secondary-button new-tab-help"
        @click="store.modal = 'help'"
      >
        <Icon
          name="Keyboard"
          :size="15"
        />快捷键与使用指南<Icon
          name="ChevronRight"
          :size="13"
        />
      </button>
      <div class="resource-links">
        <h3>资源</h3>
        <a
          href="https://git-scm.com/docs"
          target="_blank"
          rel="noopener noreferrer"
          @click="openResource($event, 'git-docs')"
          >Git 官方文档<Icon
            name="ExternalLink"
            :size="12" /></a
        ><a
          href="https://git-scm.com/book/zh/v2"
          target="_blank"
          rel="noopener noreferrer"
          @click="openResource($event, 'git-book')"
          >Pro Git 中文手册<Icon
            name="ExternalLink"
            :size="12" /></a
        ><button @click="store.modal = 'help'">
          了解 GitCode 的使用方式<Icon
            name="ChevronRight"
            :size="12"
          />
        </button>
      </div>
      <div class="new-tab-tips">
        <span>小提示</span>
        <p>打开多个仓库，用顶部标签随时切换。每个仓库的搜索条件和提交草稿会分别保留。</p>
        <div><kbd>Alt T</kbd><span>打开新标签页</span></div>
      </div>
    </aside>
  </main>
</template>
