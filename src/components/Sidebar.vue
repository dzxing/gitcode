<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import SidebarBranchRow from './SidebarBranchRow.vue'
import SidebarCollapse from './SidebarCollapse.vue'
import StashSection from './StashSection.vue'
import { useContextMenuStore } from '../stores/contextMenu'
import { flowKind, useGitFlowStore } from '../stores/gitflow'
import { useSidebarStore } from '../stores/sidebar'
import { SIDEBAR_SECTIONS } from '../sidebar'

const store = useRepositoryStore(),
  menu = useContextMenuStore(),
  flow = useGitFlowStore(),
  sidebar = useSidebarStore()
const filter = computed({
    get: () => store.sidebarQuery,
    set: (value) => {
      store.sidebarQuery = value
    },
  }),
  collapsed = ref(new Set<string>())
const matches = (name: string) => name.toLowerCase().includes(filter.value.toLowerCase())
const flowGroups = computed(() =>
  [
    {
      key: 'production',
      title: flow.state?.config.production || 'main',
      folder: false,
      prefix: '',
    },
    { key: 'develop', title: flow.state?.config.develop || 'develop', folder: false, prefix: '' },
    ...(['feature', 'release', 'hotfix'] as const).map((key) => ({
      key,
      title: flow.state?.config[key].replace(/\/$/, '') || key,
      folder: true,
      prefix: flow.state?.config[key] || `${key}/`,
    })),
  ].map((group) => {
    const branches = flow.state?.ready
      ? sidebar.sortedBranches(
          store.repo.path,
          'gitflow',
          store.repo.branches.filter(
            (b) => b.kind === 'local' && flowKind(flow.state!.config, b.name) === group.key,
          ),
        )
      : []
    return {
      ...group,
      branches,
      visible: branches.filter((b) => matches(b.name) && !sidebar.isFavorite(store.repo.path, b)),
    }
  }),
)
const flowFavorites = computed(() =>
  flow.state?.ready
    ? sidebar.sortedBranches(
        store.repo.path,
        'gitflow',
        store.repo.branches.filter(
          (branch) =>
            branch.kind === 'local' &&
            flowKind(flow.state!.config, branch.name) &&
            sidebar.isFavorite(store.repo.path, branch) &&
            matches(branch.name),
        ),
      )
    : [],
)
const flowCount = computed(() =>
  flowGroups.value.reduce((count, group) => count + group.branches.length, 0),
)
const flowSetupLabel = computed(() =>
  flow.state?.error
    ? '检查 GitFlow 规则'
    : flow.state?.configured
      ? '补齐基础分支'
      : '配置 GitFlow',
)
const flowSetupNote = computed(() =>
  flow.state?.error
    ? 'GitFlow 规则异常，请检查设置。'
    : flow.state?.configured
      ? `缺少基础分支：${flow.state.missing.join('、')}`
      : '配置分支规则后可使用 GitFlow。',
)
function configureFlow() {
  if (flow.state?.configured && flow.state.missing.length && !flow.state.error)
    flow.openInitialization()
  else flow.open('settings')
}
const sections = computed(() =>
  sidebar.order.map((id) => {
    const branches = sidebar.sortedBranches(
      store.repo.path,
      id,
      store.repo.branches.filter((b) => b.kind === id),
    )
    return {
      id,
      ...SIDEBAR_SECTIONS[id],
      branches,
      visible: branches.filter((b) => matches(b.name)),
    }
  }),
)
function showHistory() {
  if (store.selectedCommit && !store.selectedStash) return
  store.query = ''
  store.clearBranchFilter()
  const commit = store.repo.commits.find((c) => c.hash === store.repo.head) || store.repo.commits[0]
  if (commit) void store.selectCommit(commit)
}
function toggle(key: string) {
  if (collapsed.value.has(key)) collapsed.value.delete(key)
  else collapsed.value.add(key)
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-heading">
      <span>仓库导航</span
      ><button
        class="icon-button"
        :disabled="store.busy"
        title="打开仓库"
        aria-label="打开仓库"
        @click="store.modal = 'open'"
      >
        <Icon
          name="Plus"
          :size="15"
        />
      </button>
    </div>
    <nav
      class="workspace-nav"
      aria-label="工作区导航"
    >
      <button
        :class="{ active: !store.selectedCommit && !store.selectedStash }"
        @click="store.clearSelection()"
      >
        <Icon name="GitCommitHorizontal" /><span>工作区变更</span
        ><span class="count">{{ store.changes }}</span>
      </button>
      <button
        :class="{ active: !!store.selectedCommit }"
        :disabled="!store.repo.commits.length"
        @click="showHistory"
      >
        <Icon name="History" /><span>提交历史</span
        ><span class="nav-subtle">{{ store.repo.total }}</span>
      </button>
    </nav>
    <div class="sidebar-divider"></div>
    <label class="branch-search"
      ><Icon
        name="Search"
        :size="14"
      /><input
        v-model="filter"
        placeholder="筛选分支…"
        aria-label="筛选分支"
      /><kbd>/</kbd></label
    >
    <p
      v-if="sidebar.warning"
      class="sidebar-order-note"
      role="status"
    >
      {{ sidebar.warning }}
    </p>
    <div
      class="branch-sections"
      aria-label="分支分组，右键标题可调整顺序"
    >
      <section
        v-for="section in sections"
        :key="section.id"
        class="branch-section"
        :class="{ 'gitflow-tree': section.id === 'gitflow' }"
        :data-sidebar-section="section.id"
        :aria-label="`${section.title}分组`"
      >
        <div
          class="section-head"
          :class="{
            'gitflow-sidebar-entry': section.id === 'gitflow',
            'has-section-action': section.id === 'gitflow' || section.id === 'local',
          }"
          @contextmenu="menu.open($event, { kind: 'section', section: section.id })"
          @keydown="menu.keyboard($event, { kind: 'section', section: section.id })"
        >
          <button
            class="section-toggle"
            :aria-label="section.id === 'gitflow' ? '展开或折叠 GitFlow 分类' : undefined"
            :aria-controls="`sidebar-group-${section.id}`"
            :aria-expanded="!collapsed.has(section.id)"
            title="展开或折叠；右键设置分支排序或调整分组顺序"
            @click="toggle(section.id)"
          >
            <Icon
              name="ChevronRight"
              class="disclosure-chevron"
              :class="{ 'is-open': !collapsed.has(section.id) }"
              :size="12"
            /><Icon
              :name="section.icon"
              :size="14"
            /><span class="section-title">{{ section.title }}</span
            ><small
              class="section-count"
              :title="
                section.id === 'gitflow'
                  ? flow.state?.ready
                    ? '本地分类分支总数，与本地分支列表共享同一批分支'
                    : flowSetupNote
                  : '分组分支总数'
              "
              >{{
                section.id === 'gitflow'
                  ? flow.state?.ready
                    ? flowCount
                    : '—'
                  : section.branches.length
              }}</small
            >
          </button>
          <button
            v-if="section.id === 'gitflow'"
            class="section-action icon-button gitflow-panel-action"
            :disabled="store.busy"
            aria-label="打开 GitFlow 操作面板"
            :aria-controls="flow.panel ? 'gitflow-panel' : undefined"
            :aria-expanded="!!flow.panel"
            title="打开 GitFlow 操作面板"
            @click="flow.open()"
          >
            操作
          </button>
          <button
            v-else-if="section.id === 'local'"
            class="section-action icon-button"
            :disabled="store.busy"
            aria-label="新建分支"
            title="新建分支"
            @click="store.modal = 'branch'"
          >
            <Icon
              name="Plus"
              :size="13"
            />
          </button>
        </div>
        <SidebarCollapse
          :id="`sidebar-group-${section.id}`"
          :open="!collapsed.has(section.id)"
        >
          <div
            v-if="section.id === 'gitflow' && flow.state?.ready"
            class="branch-list"
          >
            <div
              v-if="flowFavorites.length"
              class="gitflow-favorites"
            >
              <div class="gitflow-favorites-label">收藏</div>
              <SidebarBranchRow
                v-for="branch in flowFavorites"
                :key="branch.fullRef || branch.name"
                :branch="branch"
                section="gitflow"
              />
            </div>
            <template
              v-for="group in flowGroups"
              :key="group.key"
            >
              <div
                v-if="group.visible.length"
                class="gitflow-subgroup"
              >
                <button
                  v-if="group.folder"
                  class="gitflow-group-label"
                  :data-flow-group="group.key"
                  :aria-controls="`sidebar-flow-${group.key}`"
                  :aria-expanded="!collapsed.has(`gitflow-${group.key}`)"
                  @click="toggle(`gitflow-${group.key}`)"
                >
                  <Icon
                    name="ChevronRight"
                    class="disclosure-chevron"
                    :class="{ 'is-open': !collapsed.has(`gitflow-${group.key}`) }"
                    :size="12"
                  /><Icon
                    name="FolderOpen"
                    :size="14"
                  /><span>{{ group.title }}</span
                  ><small>{{
                    group.branches.filter((branch) => !sidebar.isFavorite(store.repo.path, branch))
                      .length
                  }}</small>
                </button>
                <SidebarCollapse
                  :id="`sidebar-flow-${group.key}`"
                  :open="!group.folder || !collapsed.has(`gitflow-${group.key}`)"
                >
                  <div class="branch-list">
                    <SidebarBranchRow
                      v-for="branch in group.visible"
                      :key="branch.fullRef || branch.name"
                      :branch="branch"
                      section="gitflow"
                      :depth="group.folder ? 2 : 1"
                      :label="group.folder ? branch.name.slice(group.prefix.length) : branch.name"
                    />
                  </div>
                </SidebarCollapse>
              </div>
            </template>
            <p
              v-if="!flowFavorites.length && !flowGroups.some((group) => group.visible.length)"
              class="section-empty"
            >
              {{ filter ? '无匹配的 GitFlow 分支' : '暂无 GitFlow 分支' }}
            </p>
          </div>
          <div
            v-else-if="section.id === 'gitflow'"
            class="gitflow-setup"
          >
            <p>{{ flowSetupNote }}</p>
            <button
              class="text-button"
              :disabled="store.busy"
              @click="configureFlow"
            >
              <Icon
                name="Settings2"
                :size="13"
              />{{ flowSetupLabel }}
            </button>
          </div>
          <div
            v-else
            class="branch-list"
          >
            <SidebarBranchRow
              v-for="branch in section.visible"
              :key="branch.fullRef || branch.name"
              :branch="branch"
              :section="section.id"
            />
            <p
              v-if="!section.visible.length"
              class="section-empty"
            >
              {{ section.branches.length ? '无匹配分支' : `暂无${section.title}` }}
            </p>
          </div>
        </SidebarCollapse>
      </section>
      <StashSection />
    </div>
    <div class="sidebar-bottom">
      <div class="local-label">
        <Icon
          name="ShieldCheck"
          :size="16"
        /><span>本地优先，代码留在本机</span>
      </div>
      <button
        class="help-button"
        @click="store.modal = 'help'"
      >
        <Icon name="CircleHelp" /><span>使用帮助</span><kbd>?</kbd>
      </button>
      <div class="sidebar-version">
        <span class="mini-brand">Git<span>Code</span></span
        ><span>v0.1.0 <i>Preview</i></span>
      </div>
    </div>
  </aside>
</template>
