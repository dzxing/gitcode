<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useGitFlowStore, flowLabels, flowTypes } from '../stores/gitflow'
import { useRepositoryStore } from '../stores/repository'
import Icon from './Icon.vue'
import type { GitFlowConfig } from '../types'

const flow = useGitFlowStore(),
  repo = useRepositoryStore()
const panelElement = ref<HTMLElement>()
const initializationElement = ref<HTMLElement>(),
  initPlanElement = ref<HTMLElement>(),
  resultElement = ref<HTMLElement>()
let trigger: HTMLElement | null = null
const fields: { key: keyof GitFlowConfig; label: string; hint: string }[] = [
  { key: 'production', label: '生产分支', hint: '已发布版本所在的分支，例如 main 或 master' },
  { key: 'develop', label: '开发分支', hint: '下一版本的集成分支' },
  { key: 'feature', label: 'Feature 前缀', hint: '新功能分支，必须以 / 结尾' },
  { key: 'release', label: 'Release 前缀', hint: '发布准备分支，必须以 / 结尾' },
  { key: 'hotfix', label: 'Hotfix 前缀', hint: '生产紧急修复分支，必须以 / 结尾' },
  { key: 'versionTag', label: '版本标签前缀', hint: '例如 v，也可留空；保存时不会创建标签' },
]
const fieldGroups = [
  {
    id: 'branches',
    title: '基础分支',
    hint: '生产分支保存已发布版本，开发分支集成下一版本。',
    fields: fields.slice(0, 2),
  },
  {
    id: 'prefixes',
    title: '命名前缀',
    hint: '分支前缀以 / 结尾；版本标签前缀可留空，保存不会创建标签。',
    fields: fields.slice(2),
  },
]
const title = computed(
  () =>
    ({
      overview: 'GitFlow',
      settings: '仓库设置',
      start: '开始新分支',
      finish: '完成 GitFlow 分支',
    })[flow.panel || 'overview'],
)
const rulesVerified = computed(
  () =>
    repo.connected &&
    repo.runtime?.gitAvailable !== false &&
    !!flow.state?.ready &&
    !flow.requiresRecheck,
)
const readinessStatus = computed(() =>
  !repo.connected
    ? '本机核心未连接 · 规则状态待核对'
    : repo.runtime?.gitAvailable === false
      ? '本机 Git 不可用'
      : flow.requiresRecheck
        ? 'GitFlow 状态待核对'
        : flow.state?.error
          ? 'GitFlow 规则异常'
          : !flow.state?.configured
            ? 'GitFlow 尚未配置'
            : !flow.state.ready
              ? 'GitFlow 基础分支待补齐'
              : 'GitFlow 规则已就绪',
)
const settingsLabel = computed(() =>
  flow.state?.error
    ? '检查 GitFlow 规则'
    : flow.state?.ready
      ? '查看 GitFlow 设置'
      : flow.state?.configured
        ? '补齐基础分支'
        : '配置 GitFlow',
)
const repairMode = computed(
  () => !!flow.state?.configured && flow.state.missing.length > 0 && !flow.state.error,
)
function configure() {
  if (repairMode.value) flow.openInitialization()
  else flow.open('settings')
}
function chooseSource(branch: string, event: Event) {
  flow.sourceChoices[branch] = (event.target as HTMLSelectElement).value
}
function close() {
  flow.close()
  if (trigger?.isConnected) trigger.focus({ preventScroll: true })
}
watch(
  () => [flow.panel, flow.settingsFocusRequest] as const,
  async ([value], [previous]) => {
    if (!value) return
    if (!previous) trigger = document.activeElement as HTMLElement
    await nextTick()
    if (
      value === 'settings' &&
      flow.settingsTarget === 'initialization' &&
      initializationElement.value
    ) {
      initializationElement.value.scrollIntoView({ block: 'start' })
      const source = initializationElement.value.querySelector<HTMLElement>('select:not(:disabled)')
      ;(source || initializationElement.value).focus({ preventScroll: true })
      return
    }
    const field = panelElement.value?.querySelector<HTMLElement>('[data-flow-focus]:not(:disabled)')
    ;(field || panelElement.value)?.focus({ preventScroll: true })
  },
)
watch(
  () => flow.plan,
  async (value) => {
    if (!value || flow.panel !== 'settings') return
    await nextTick()
    initPlanElement.value?.scrollIntoView({ block: 'nearest' })
    initPlanElement.value?.focus({ preventScroll: true })
  },
)
watch(
  () => flow.resultFocusRequest,
  async () => {
    if (!flow.visibleResult) return
    await nextTick()
    resultElement.value?.scrollIntoView({ block: 'nearest' })
    resultElement.value?.focus({ preventScroll: true })
  },
)
function showWorktree() {
  repo.clearSelection()
  close()
}
</script>

<template>
  <section
    v-if="flow.panel"
    id="gitflow-panel"
    ref="panelElement"
    class="gitflow-panel"
    :class="{ 'gitflow-settings': flow.panel === 'settings' }"
    tabindex="-1"
    aria-labelledby="gitflow-title"
    @keydown.esc.stop.prevent="close"
  >
    <header class="gitflow-panel-head">
      <div>
        <small>{{ repo.repo.name }} · 本地仓库</small>
        <h2 id="gitflow-title">
          <Icon
            name="GitMerge"
            :size="19"
          />{{ title }}
        </h2>
      </div>
      <button
        class="icon-button"
        aria-label="收起 GitFlow 面板"
        title="收起，保留草稿"
        @click="close"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
    </header>
    <div
      class="gitflow-location"
      :title="repo.repo.path"
    >
      {{ repo.repo.path }}
    </div>
    <div class="gitflow-panel-layout">
      <nav
        v-if="flow.panel === 'settings'"
        class="gitflow-settings-nav"
        aria-label="仓库设置分类"
      >
        <button aria-current="page"><Icon name="GitMerge" />GitFlow</button
        ><small>设置应用于当前仓库</small
        ><button
          class="text-button"
          :disabled="repo.busy"
          @click="flow.open('overview')"
        >
          返回 GitFlow
        </button>
      </nav>
      <div class="gitflow-panel-body">
        <div class="gitflow-content">
          <div
            v-if="!repo.connected"
            class="gitflow-warning"
            role="status"
          >
            本机核心未连接，当前规则与结果仅供查看，执行前需重新核对。
            <button
              class="text-button"
              :disabled="repo.busy || repo.connecting"
              @click="flow.recheck"
            >
              {{ repo.connecting ? '正在连接…' : '连接并核对' }}
            </button>
          </div>
          <p
            v-if="flow.draftRestored"
            class="gitflow-note"
          >
            已保留本仓库的表单草稿，请以操作结果确认执行状态。<button
              class="text-button"
              :disabled="repo.busy"
              @click="flow.resetDraft"
            >
              丢弃草稿
            </button>
          </p>
          <p
            v-if="flow.restartNotice"
            class="gitflow-note"
          >
            已从本机存储恢复输入，起点按本次打开的仓库状态重新读取。请核对后再执行；这不代表恢复了之前的
            Git 操作。
          </p>
          <div
            v-if="flow.result && !flow.visibleResult"
            class="gitflow-note"
          >
            <strong>{{
              flow.resultAction === 'gitflow-start'
                ? '有一项创建分支的操作结果'
                : '有一项配置或初始化的操作结果'
            }}</strong>
            <p v-if="flow.result.outcome !== 'succeeded'">
              {{ flow.result.warning || flow.result.error || '操作未正常完成，请查看具体结果。' }}
            </p>
            <button
              class="text-button"
              :disabled="repo.busy"
              @click="flow.open(flow.resultPanel)"
            >
              查看对应操作结果
            </button>
          </div>
          <p
            v-if="flow.draftWarning"
            class="gitflow-warning"
            role="status"
          >
            {{ flow.draftWarning }}
          </p>
          <p
            v-if="flow.state?.error"
            class="gitflow-warning"
          >
            {{ flow.state.error }}
          </p>
          <p
            v-if="flow.state?.operationError"
            class="gitflow-warning"
          >
            {{ flow.state.operationError
            }}<button
              class="text-button"
              @click="showWorktree"
            >
              查看工作区状态
            </button>
          </p>
          <p
            v-if="flow.requiresRecheck"
            class="gitflow-warning"
          >
            上次操作需要核实。请先刷新检查实际状态，再执行新的操作。<button
              class="text-button"
              :disabled="repo.busy"
              @click="flow.recheck"
            >
              刷新核对
            </button>
          </p>
          <p
            v-if="flow.stale"
            class="gitflow-warning"
          >
            仓库状态已变化，请重新核对配置和起点。<button
              class="text-button"
              :disabled="repo.busy"
              @click="flow.recheck"
            >
              刷新核对
            </button>
          </p>
          <template v-if="flow.panel === 'overview'">
            <div
              class="gitflow-status"
              role="status"
            >
              <span
                class="connection-dot"
                :class="{ online: rulesVerified }"
              ></span
              >{{ readinessStatus }}
            </div>
            <p>使用功能、发布准备和紧急修复分支组织工作。本地完成与推送远程是独立操作。</p>
            <div class="gitflow-task-buttons">
              <div>
                <button
                  class="secondary-button"
                  data-flow-focus
                  :disabled="!!flow.startEntryBlocked"
                  :title="flow.startEntryBlocked"
                  :aria-describedby="flow.startEntryBlocked ? 'flow-start-entry-reason' : undefined"
                  @click="flow.open('start')"
                >
                  <Icon name="Plus" />开始新分支…
                </button>
                <p
                  v-if="flow.startEntryBlocked"
                  id="flow-start-entry-reason"
                  class="gitflow-disabled-reason"
                >
                  {{ flow.startEntryBlocked }}
                </p>
              </div>
              <div>
                <button
                  class="secondary-button"
                  :disabled="!!flow.finishEntryBlocked"
                  :title="flow.finishEntryBlocked"
                  aria-describedby="flow-finish-entry-note"
                  @click="flow.open('finish')"
                >
                  <Icon name="GitMerge" />完成分支…
                </button>
                <p
                  id="flow-finish-entry-note"
                  class="gitflow-disabled-reason"
                >
                  {{ flow.finishEntryBlocked || '执行合并，可按选项创建标签和清理本地分支。' }}
                </p>
              </div>
            </div>
            <div
              v-if="flow.state?.ready"
              class="gitflow-summary"
            >
              <small>生产分支</small><strong>{{ flow.state.config.production }}</strong
              ><small>开发分支</small><strong>{{ flow.state.config.develop }}</strong>
            </div>
            <div
              v-else
              class="gitflow-note"
            >
              {{
                flow.state?.error
                  ? '规则存在异常，请检查仓库 GitFlow 设置。'
                  : flow.state?.configured
                    ? `缺少基础分支：${flow.state.missing.join('、')}`
                    : '基础分支已存在时保存规则即可；如有缺失，请选择起点并预览初始化，确认时会同时保存规则。'
              }}
            </div>
            <button
              class="text-button"
              :data-flow-focus="flow.startEntryBlocked ? '' : undefined"
              :disabled="repo.busy"
              @click="configure"
            >
              <Icon name="Settings2" />{{ settingsLabel }}
            </button>
          </template>
          <template v-else-if="flow.panel === 'settings'">
            <div class="gitflow-settings-form">
              <h3>GitFlow 分支规则</h3>
              <p>只作用于当前仓库；保存规则不会移动或重命名已有分支。</p>
              <form @submit.prevent="flow.execute('gitflow-save')">
                <fieldset
                  v-for="group in fieldGroups"
                  :key="group.id"
                  class="gitflow-rule-group"
                  :disabled="repo.busy"
                >
                  <legend>{{ group.title }}</legend>
                  <p
                    :id="`flow-${group.id}-hint`"
                    class="gitflow-group-help"
                  >
                    {{ group.hint }}
                  </p>
                  <div class="gitflow-rule-rows">
                    <div
                      v-for="field in group.fields"
                      :key="field.key"
                      class="gitflow-rule-row"
                    >
                      <label :for="`flow-${field.key}`">{{ field.label }}</label>
                      <div class="gitflow-rule-control">
                        <input
                          :id="`flow-${field.key}`"
                          v-model="flow.config[field.key]"
                          :data-flow-focus="field.key === 'production' ? '' : undefined"
                          :aria-describedby="`flow-${group.id}-hint flow-${field.key}-hint`"
                          class="form-input"
                          :required="field.key !== 'versionTag'"
                          maxlength="200"
                          autocomplete="off"
                          spellcheck="false"
                        />
                        <small
                          :id="`flow-${field.key}-hint`"
                          class="gitflow-sr-only"
                          >{{ field.hint }}</small
                        >
                        <div
                          v-if="flow.configConflicts.includes(field.key)"
                          class="gitflow-warning"
                          role="status"
                        >
                          仓库当前值：<strong>{{
                            flow.state?.config[field.key] || '（空）'
                          }}</strong>
                          <div class="gitflow-actions">
                            <button
                              type="button"
                              class="text-button"
                              @click="flow.resolveConflict(field.key, 'repository')"
                            >
                              采用仓库规则</button
                            ><button
                              type="button"
                              class="text-button"
                              @click="flow.resolveConflict(field.key, 'draft')"
                            >
                              保留我的修改
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </fieldset>
                <details class="gitflow-field-help">
                  <summary>字段说明</summary>
                  <dl>
                    <div
                      v-for="field in fields"
                      :key="field.key"
                    >
                      <dt>{{ field.label }}</dt>
                      <dd>{{ field.hint }}</dd>
                    </div>
                  </dl>
                </details>
                <details
                  v-if="flow.legacyConfig"
                  class="gitflow-note"
                >
                  <summary>待确认的旧版配置草稿</summary>
                  <p>旧格式缺少编辑基线，无法判断哪些规则是你修改的，因此没有自动套用。</p>
                  <p
                    v-for="field in fields"
                    :key="field.key"
                  >
                    {{ field.label }}：{{ flow.legacyConfig[field.key] || '（空）' }}
                  </p>
                  <div class="gitflow-actions">
                    <button
                      type="button"
                      class="text-button"
                      :disabled="repo.busy"
                      @click="flow.resolveLegacy(true)"
                    >
                      采用这份旧草稿</button
                    ><button
                      type="button"
                      class="text-button"
                      :disabled="repo.busy"
                      @click="flow.resolveLegacy(false)"
                    >
                      丢弃旧规则草稿
                    </button>
                  </div>
                </details>
                <p
                  v-if="flow.saveBlocked"
                  id="flow-save-reason"
                  class="gitflow-disabled-reason"
                >
                  {{ flow.saveBlocked }}
                </p>
                <div class="gitflow-actions gitflow-save-actions">
                  <button
                    type="submit"
                    class="secondary-button"
                    :disabled="!!flow.saveBlocked"
                    :title="flow.saveBlocked"
                    :aria-describedby="flow.saveBlocked ? 'flow-save-reason' : undefined"
                  >
                    保存规则</button
                  ><button
                    type="button"
                    class="text-button"
                    :disabled="repo.busy"
                    @click="flow.resetConfig"
                  >
                    恢复已保存规则
                  </button>
                </div>
              </form>
              <section
                ref="initializationElement"
                class="gitflow-initialize"
                tabindex="-1"
                aria-labelledby="flow-init-heading"
              >
                <h3 id="flow-init-heading">{{ repairMode ? '补齐基础分支' : '初始化基础分支' }}</h3>
                <p>只创建缺失的生产与开发分支，不切换分支、不推送，保留工作区现有修改。</p>
                <p
                  v-if="flow.missing.length"
                  class="gitflow-note"
                >
                  {{
                    flow.dirtyConfig ? '按上方尚未保存的规则' : '按当前规则'
                  }}，需要创建：<strong>{{ flow.missing.join('、') }}</strong
                  >。为每条分支选择起点，然后预览计划。确认时会同时保存规则，无需先单独保存。
                </p>
                <p
                  v-if="!repo.repo.head"
                  class="gitflow-warning"
                >
                  仓库尚无提交，请先完成首次提交。
                </p>
                <p
                  v-if="!flow.missing.length"
                  class="gitflow-note"
                >
                  基础分支已存在，无需创建。{{
                    !flow.state?.configured
                      ? '直接保存规则即可启用 GitFlow。'
                      : '如需更新规则，请使用上方保存按钮。'
                  }}
                </p>
                <div
                  v-for="branch in flow.missing"
                  :key="branch"
                  class="gitflow-field"
                >
                  <label :for="`flow-source-${branch}`"
                    >为 <strong>{{ branch }}</strong> 选择起点</label
                  ><select
                    :id="`flow-source-${branch}`"
                    :value="flow.sourceChoices[branch] || ''"
                    :disabled="repo.busy"
                    @change="chooseSource(branch, $event)"
                  >
                    <option
                      value=""
                      disabled
                    >
                      请选择现有本地分支
                    </option>
                    <option
                      v-for="source in flow.localBranches"
                      :key="source.name"
                      :value="source.fullRef || `refs/heads/${source.name}`"
                    >
                      {{ source.name }}
                    </option>
                  </select>
                </div>
                <p
                  v-if="flow.previewBlocked"
                  id="flow-init-reason"
                  class="gitflow-disabled-reason"
                >
                  {{ flow.previewBlocked }}
                </p>
                <button
                  :class="repairMode ? 'primary-button' : 'secondary-button'"
                  :disabled="!!flow.previewBlocked"
                  :title="flow.previewBlocked"
                  :aria-describedby="flow.previewBlocked ? 'flow-init-reason' : undefined"
                  @click="flow.previewInit"
                >
                  {{ repairMode ? '预览补齐计划' : '预览初始化' }}
                </button>
                <div
                  v-if="flow.plan"
                  ref="initPlanElement"
                  class="gitflow-plan"
                  tabindex="-1"
                  aria-labelledby="flow-init-plan-heading"
                >
                  <h4 id="flow-init-plan-heading">
                    {{ repairMode ? '确认补齐计划' : '确认初始化计划' }}
                  </h4>
                  <p
                    v-if="flow.planExpired"
                    class="gitflow-warning"
                  >
                    计划已过期，请重新预览。
                  </p>
                  <p
                    v-for="branch in flow.plan.retained"
                    :key="branch"
                  >
                    保留 <strong>{{ branch }}</strong
                    >，不移动
                  </p>
                  <p
                    v-for="item in flow.plan.creates"
                    :key="item.name"
                  >
                    创建 <strong>{{ item.name }}</strong
                    ><br /><span
                      >基于 {{ item.sourceRef.replace('refs/heads/', '') }} ·
                      {{ item.oid.slice(0, 8) }}</span
                    >
                  </p>
                  <p>同时保存当前分支规则，工作区内容保持原样。</p>
                  <button
                    class="primary-button"
                    :disabled="!!flow.confirmBlocked"
                    :title="flow.confirmBlocked"
                    @click="flow.execute('gitflow-init')"
                  >
                    {{ repairMode ? '确认补齐基础分支' : '确认初始化' }}
                  </button>
                </div>
              </section>
            </div>
          </template>
          <template v-else-if="flow.panel === 'start'">
            <form @submit.prevent="!flow.startBlocked && flow.execute('gitflow-start')">
              <fieldset :disabled="repo.busy">
                <div
                  class="gitflow-type-picker"
                  role="group"
                  aria-label="分支类型"
                >
                  <button
                    v-for="kind in flowTypes"
                    :key="kind"
                    type="button"
                    :aria-pressed="flow.type === kind"
                    @click="flow.type = kind"
                  >
                    {{ kind }}<small>{{ flowLabels[kind] }}</small>
                  </button>
                </div>
                <div class="gitflow-field">
                  <label for="flow-branch-name">分支名称</label
                  ><input
                    id="flow-branch-name"
                    v-model="flow.name"
                    data-flow-focus
                    class="form-input"
                    placeholder="例如 login 或 1.2.0"
                    maxlength="200"
                    autocomplete="off"
                    spellcheck="false"
                    required
                  /><small>填写后缀，前缀由仓库规则自动添加。</small>
                </div>
                <div class="gitflow-plan">
                  <small>创建分支</small
                  ><strong class="gitflow-full-name">{{ flow.fullName }}</strong
                  ><small>基于本地分支</small
                  ><strong class="gitflow-full-name">{{ flow.sourceName || '尚未配置' }}</strong>
                  <details v-if="flow.sourceOid">
                    <summary>版本详情</summary>
                    <code>{{ flow.sourceOid }}</code>
                  </details>
                </div>
                <label class="gitflow-check"
                  ><input
                    v-model="flow.switchAfter"
                    type="checkbox"
                  />创建后切换到新分支</label
                >
              </fieldset>
              <p
                v-if="flow.startBlocked"
                id="flow-start-reason"
                class="gitflow-warning"
              >
                {{ flow.startBlocked }}
              </p>
              <div
                v-if="!flow.state?.ready"
                class="gitflow-actions"
              >
                <button
                  type="button"
                  class="text-button"
                  :disabled="repo.busy"
                  @click="flow.open('settings')"
                >
                  前往配置与初始化
                </button>
              </div>
              <button
                v-else-if="repo.changes"
                type="button"
                class="text-button"
                @click="showWorktree"
              >
                查看工作区更改
              </button>
              <p class="gitflow-muted">
                本地更改会自动贮藏，操作成功后恢复；冲突或中断时保留记录。不自动推送。
              </p>
              <button
                class="primary-button"
                :disabled="!!flow.startBlocked"
                :title="flow.startBlocked"
                :aria-describedby="flow.startBlocked ? 'flow-start-reason' : undefined"
              >
                {{ repo.busy ? '正在执行…' : flow.switchAfter ? '创建并切换' : '仅创建分支' }}
              </button>
            </form>
          </template>

          <div
            v-if="flow.error"
            class="gitflow-warning"
            role="alert"
          >
            {{ flow.error }}
            <div>
              <button
                class="text-button"
                :disabled="repo.busy"
                @click="flow.recheck"
              >
                刷新核对
              </button>
            </div>
          </div>
          <div
            v-if="flow.visibleResult"
            ref="resultElement"
            class="gitflow-result"
            tabindex="-1"
            :class="{
              incomplete:
                flow.visibleResult.outcome !== 'succeeded' || !!flow.visibleResult.refreshError,
            }"
            role="status"
          >
            <strong>{{
              flow.visibleResult.outcome === 'succeeded'
                ? '本地操作已完成'
                : flow.visibleResult.outcome === 'partial'
                  ? '操作未完整完成，请核对状态'
                  : '操作未完成'
            }}</strong>
            <p>
              {{
                flow.visibleResult.output || flow.visibleResult.warning || flow.visibleResult.error
              }}
            </p>
            <p v-if="flow.visibleResult.refreshError">
              状态读取失败：{{ flow.visibleResult.refreshError }}。请刷新核对，不要重复执行。
            </p>
            <button
              v-if="
                flow.visibleResult.outcome === 'succeeded' &&
                flow.panel === 'settings' &&
                !flow.startEntryBlocked
              "
              class="primary-button"
              @click="flow.open('start')"
            >
              开始新分支…</button
            ><button
              v-else-if="flow.requiresRecheck"
              class="secondary-button"
              :disabled="repo.busy"
              @click="flow.recheck"
            >
              刷新核对
            </button>
          </div>
        </div>
      </div>
    </div>
    <footer class="gitflow-panel-footer">
      <button
        class="text-button"
        :disabled="repo.busy"
        @click="flow.open(flow.panel === 'settings' ? 'overview' : 'settings')"
      >
        <Icon name="Settings2" />{{
          flow.panel === 'settings' ? '返回操作面板' : '仓库 GitFlow 设置'
        }}</button
      ><span>收起保留表单草稿</span>
    </footer>
  </section>
</template>
