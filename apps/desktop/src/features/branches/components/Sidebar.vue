<script setup lang="ts">
import { vOverflowTitle } from '../../../shared/ui/overflowTitle'
import { useHistoryToolsStore } from '../../history/stores/historyTools'
import { version as appVersion } from '../../../../package.json'
import { computed, nextTick, ref, watch } from 'vue'
import { useRepositoryStore } from '../../repository/stores/repository'
import Icon from '../../../shared/ui/Icon.vue'
import AppBrand from '../../../shared/ui/AppBrand.vue'
import SidebarBranchRow from './SidebarBranchRow.vue'
import BranchTreeFolder from './BranchTreeFolder.vue'
import BranchTreeNode from './BranchTreeNode.vue'
import BranchDirectoryList from './BranchDirectoryList.vue'
import SidebarCollapse from './SidebarCollapse.vue'
import StashSection from '../../stash/components/StashSection.vue'
import { useContextMenuStore } from '../../../app/stores/contextMenu'
import { useGitFlowStore } from '../../gitflow/stores/gitflow'
import { flowKind } from '../../gitflow/branchKinds'
import { useSidebarStore } from '../stores/sidebar'
import { SIDEBAR_SECTIONS, remoteBranchGroups } from '../sidebarModel'
import { branchReference } from '../../../shared/lib/references'

const store = useRepositoryStore(),
  menu = useContextMenuStore(),
  flow = useGitFlowStore(),
  sidebar = useSidebarStore()
const sidebarElement = ref<HTMLElement>()
const filterInput = ref<HTMLInputElement>()
defineExpose({ focusFilter: () => filterInput.value?.focus() })
let checkoutFocus: HTMLElement | null = null
watch(
  () => store.checkingOut,
  async (active) => {
    if (active) {
      const focused = document.activeElement as HTMLElement | null
      checkoutFocus = focused && sidebarElement.value?.contains(focused) ? focused : null
    } else {
      await nextTick()
      if (checkoutFocus?.isConnected && !document.querySelector('dialog[open]'))
        checkoutFocus.focus({ preventScroll: true })
      checkoutFocus = null
    }
  },
)
const filter = computed({
    get: () => store.sidebarQuery,
    set: (value) => {
      store.sidebarQuery = value
    },
  }),
  collapsed = ref(new Set<string>())
const matches = (name: string) => name.toLowerCase().includes(filter.value.trim().toLowerCase())
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
      ? `本地缺少基础分支：${flow.state.missing.join('、')}，可核对远端后恢复本地分支`
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
      store.repo.branches.filter((b) =>
        id === 'gitflow'
          ? b.kind === 'local' && !!flow.state?.ready && !!flowKind(flow.state.config, b.name)
          : b.kind === id && !(id === 'remote' && b.symbolicTarget),
      ),
    )
    return {
      id,
      ...SIDEBAR_SECTIONS[id],
      branches,
      visible: branches.filter((b) => matches(b.name)),
    }
  }),
)
const remoteGroups = computed(() =>
  remoteBranchGroups(
    store.repo.branches,
    store.repo.remotes || [],
    store.repo.branches
      .filter((branch) => sidebar.isFavorite(store.repo.path, branch))
      .map(branchReference),
    sidebar.sortMode(store.repo.path, 'remote'),
    filter.value,
  ),
)
function showWorktree() {
  useHistoryToolsStore().active = ''
  store.clearSelection()
}
function showHistory() {
  useHistoryToolsStore().active = ''
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
  <aside
    ref="sidebarElement"
    class="sidebar"
    :aria-busy="store.checkingOut"
  >
    <div
      class="sidebar-content"
      :inert="store.checkingOut"
    >
      <div class="sidebar-heading">
        <span>仓库导航</span>
        <div class="sidebar-heading-actions">
          <button
            class="icon-button"
            aria-label="仓库导航显示设置"
            :title="menu.hoverTitle('仓库导航显示设置')"
            aria-haspopup="menu"
            @click="menu.open($event, { kind: 'navigation' })"
          >
            <Icon
              name="Settings2"
              :size="13"
            />
          </button>
          <button
            class="icon-button"
            :disabled="store.busy"
            :title="menu.hoverTitle('打开仓库')"
            aria-label="打开仓库"
            @click="store.requestOpen()"
          >
            <Icon
              name="Plus"
              :size="15"
            />
          </button>
        </div>
      </div>
      <nav
        class="workspace-nav"
        aria-label="工作区导航"
      >
        <button
          :class="{ active: !store.selectedCommit && !store.selectedStash }"
          @click="showWorktree"
        >
          <Icon
            name="GitCommitHorizontal"
            :size="14"
          /><span>工作区变更</span><span class="count">{{ store.changes }}</span>
        </button>
        <button
          :class="{ active: !!store.selectedCommit }"
          :disabled="!store.repo.commits.length"
          @click="showHistory"
        >
          <Icon
            name="History"
            :size="14"
          /><span>提交历史</span><span class="nav-subtle">{{ store.repo.total }}</span>
        </button>
      </nav>
      <div class="sidebar-divider"></div>
      <label class="branch-search"
        ><Icon
          name="Search"
          :size="14"
        /><input
          autocomplete="off"
          v-model="filter"
          placeholder="筛选分支…"
          aria-label="筛选分支"
          ref="filterInput"
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
              /><span class="section-title">{{ section.title }}</span>
            </button>
            <button
              v-if="section.id === 'gitflow'"
              class="section-action icon-button gitflow-panel-action"
              :disabled="store.busy"
              aria-label="打开 GitFlow 操作面板"
              :aria-controls="flow.panel ? 'gitflow-panel' : undefined"
              :aria-expanded="!!flow.panel"
              :title="menu.hoverTitle('打开 GitFlow 操作面板')"
              @click="flow.open()"
            >
              操作
            </button>
            <button
              v-else-if="section.id === 'local'"
              class="section-action icon-button"
              :disabled="store.busy"
              aria-label="新建分支"
              :title="menu.hoverTitle('新建分支')"
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
              v-if="
                section.id === 'gitflow' &&
                flow.state?.ready &&
                sidebar.groupDirectories(store.repo.path)
              "
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
                  <BranchTreeFolder
                    v-if="group.folder"
                    :node-key="JSON.stringify(['gitflow', group.key])"
                    :label="group.title"
                    :depth="1"
                    :query="filter"
                    :flow-group="group.key"
                  >
                    <BranchDirectoryList
                      :branches="group.visible"
                      section="gitflow"
                      :query="filter"
                      :scope="['gitflow', group.key]"
                      :label-prefix="group.prefix"
                      :depth="2"
                    />
                  </BranchTreeFolder>
                  <BranchDirectoryList
                    v-else
                    :branches="group.visible"
                    section="gitflow"
                    :query="filter"
                    :scope="['gitflow', group.key]"
                  />
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
              v-else-if="section.id === 'gitflow' && !flow.state?.ready"
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
              v-else-if="section.id === 'remote' && sidebar.groupDirectories(store.repo.path)"
              class="branch-list remote-branch-tree"
            >
              <BranchTreeFolder
                v-for="group in remoteGroups"
                :key="group.key"
                :node-key="group.key"
                :label="group.remote"
                :depth="1"
                :query="filter"
                remote
              >
                <SidebarBranchRow
                  v-for="item in group.favorites"
                  :key="item.branch.fullRef || item.branch.name"
                  :branch="item.branch"
                  :label="item.label"
                  :depth="2"
                  section="remote"
                />
                <BranchTreeNode
                  v-for="node in group.children"
                  :key="node.key"
                  :node="node"
                  :depth="2"
                  :query="filter"
                  section="remote"
                />
                <p
                  v-if="!group.count"
                  class="section-empty"
                >
                  暂无远程分支
                </p>
              </BranchTreeFolder>
              <p
                v-if="!remoteGroups.length"
                class="section-empty"
              >
                {{ filter ? '无匹配分支' : '暂无远程分支' }}
              </p>
            </div>
            <div
              v-else-if="
                sidebar.groupDirectories(store.repo.path) &&
                (section.id === 'local' || section.id === 'tag')
              "
              class="branch-list"
            >
              <BranchDirectoryList
                :branches="section.visible"
                :section="section.id"
                :query="filter"
              />
              <p
                v-if="!section.visible.length"
                class="section-empty"
              >
                {{ filter ? '无匹配分支' : `暂无${section.title}` }}
              </p>
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
        <button
          class="help-button"
          @click="store.modal = 'help'"
        >
          <Icon name="CircleHelp" /><span>使用帮助</span><kbd>?</kbd>
        </button>
        <div class="sidebar-version">
          <AppBrand
            class="mini-brand"
            :show-mark="false"
          />
          <span>v{{ appVersion }}</span>
        </div>
      </div>
    </div>
    <div
      v-if="store.checkingOut"
      class="sidebar-checkout-progress"
      role="status"
      aria-live="polite"
    >
      <Icon
        name="LoaderCircle"
        :size="30"
        class="spin"
        aria-hidden="true"
      />
      <strong>{{ store.cancelling ? '正在取消并核对结果…' : '正在检出分支…' }}</strong>
      <span v-overflow-title="menu.hoverTitle(store.checkoutTarget)">{{
        store.checkoutTarget
      }}</span>
    </div>
  </aside>
</template>
