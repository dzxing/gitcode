<script setup lang="ts">
import { vOverflowTitle } from '../../../shared/ui/overflowTitle'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { coreBridge, isDesktop, pathName } from '../../../infrastructure/coreBridge'
import { useRepositoryStore } from '../stores/repository'
import type { DirectoryEntry, DirectoryListing } from '../../../shared/contracts'
import Icon from '../../../shared/ui/Icon.vue'

const props = defineProps<{ initialPath?: string; mode: 'repo' | 'parent' }>()
const emit = defineEmits<{ select: [path: string]; close: [] }>()
const store = useRepositoryStore()
const dialog = ref<HTMLDialogElement>()
const listing = ref<DirectoryListing | null>(null)
const address = ref('')
const query = ref('')
const selected = ref<DirectoryEntry | null>(null)
const showHidden = ref(false)
const loading = ref(false)
const error = ref('')
let version = 0
let previousFocus: HTMLElement | null = null
const visible = computed(() =>
  (listing.value?.folders || []).filter(
    (folder) =>
      (showHidden.value || !folder.hidden) &&
      folder.name.toLowerCase().includes(query.value.toLowerCase()),
  ),
)
const selection = computed(() => selected.value?.path || listing.value?.path || '')
const distributionList = computed(() =>
  /^\\\\(?:wsl\.localhost|wsl\$)\\?$/i.test(listing.value?.path || ''),
)
const virtualSelection = computed(() => /^\\\\(?:wsl\.localhost|wsl\$)\\?$/i.test(selection.value))

async function navigate(path?: string) {
  const request = ++version
  const addressAtStart = address.value
  loading.value = true
  error.value = ''
  selected.value = null
  query.value = ''
  try {
    const next = await coreBridge.listDirectory(path)
    if (request !== version) return
    listing.value = next
    // A late initial listing must not overwrite a path the user is typing.
    if (address.value === addressAtStart) address.value = next.path
  } catch (reason) {
    if (request === version) error.value = (reason as Error).message
  } finally {
    if (request === version) loading.value = false
  }
}

async function systemPicker() {
  try {
    const path = await coreBridge.chooseDirectory(
      listing.value?.path,
      props.mode === 'parent' ? 'parent' : 'repository',
    )
    if (path) emit('select', path)
  } catch (reason) {
    error.value = (reason as Error).message
  }
}

onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement
  await nextTick()
  dialog.value?.showModal()
  await navigate(props.initialPath)
  if (!listing.value && props.initialPath) await navigate()
})
onUnmounted(() => {
  version++
  previousFocus?.focus()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="directory-dialog"
    aria-labelledby="directory-heading"
    @cancel.prevent="emit('close')"
    @click="$event.target === dialog && emit('close')"
  >
    <header class="directory-heading">
      <div>
        <Icon
          name="FolderGit2"
          :size="19"
        />
        <h2 id="directory-heading">{{ mode === 'repo' ? '选择 Git 仓库' : '选择父目录' }}</h2>
        <span>{{
          store.runtime?.environment === 'wsl' ||
          /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(listing?.path || '')
            ? 'WSL 目录'
            : '本机目录'
        }}</span>
      </div>
      <button
        class="icon-button"
        aria-label="关闭目录浏览器"
        @click="emit('close')"
      >
        <Icon
          name="X"
          :size="18"
        />
      </button>
    </header>
    <div class="directory-toolbar">
      <button
        class="icon-button"
        :disabled="!listing?.parent || loading"
        title="上一级目录"
        aria-label="上一级目录"
        @click="listing?.parent && navigate(listing.parent)"
      >
        <Icon name="ArrowUp" />
      </button>
      <form
        autocomplete="off"
        @submit.prevent="navigate(address)"
      >
        <Icon
          name="FolderOpen"
          :size="15"
        /><input
          autocomplete="off"
          v-model="address"
          aria-label="目录地址"
          placeholder="输入本机绝对路径，按 Enter 跳转"
          spellcheck="false"
        />
      </form>
      <button
        class="icon-button"
        :disabled="loading"
        aria-label="刷新目录"
        title="刷新目录"
        @click="navigate(listing?.path)"
      >
        <Icon
          name="RefreshCw"
          :class="{ spin: loading }"
          :size="15"
        />
      </button>
    </div>
    <div class="directory-body">
      <nav
        class="directory-shortcuts"
        aria-label="目录快捷入口"
      >
        <span>位置</span
        ><button @click="navigate(listing?.home)">
          <Icon
            name="FolderOpen"
            :size="15"
          />用户目录</button
        ><button
          v-if="listing"
          @click="navigate(listing.root)"
        >
          <Icon
            name="Monitor"
            :size="15"
          />{{ listing.root }}</button
        ><button
          v-for="location in listing?.locations || []"
          :key="location.path"
          @click="navigate(location.path)"
        >
          <Icon
            name="FolderOpen"
            :size="15"
          />{{ location.name }}</button
        ><span v-if="store.recent.length">最近仓库</span
        ><button
          v-for="recent in store.recent"
          :key="recent"
          v-overflow-title="recent"
          @click="navigate(recent)"
        >
          <Icon
            name="FolderGit2"
            :size="14"
          /><span>{{ pathName(recent) }}</span>
        </button>
      </nav>
      <section class="directory-content">
        <div class="directory-filter">
          <label
            ><Icon
              name="Search"
              :size="14" /><input
              autocomplete="off"
              v-model="query"
              placeholder="筛选当前目录…"
              aria-label="筛选当前目录" /></label
          ><label class="hidden-toggle"
            ><input
              v-model="showHidden"
              type="checkbox"
            />隐藏目录</label
          >
        </div>
        <p
          v-if="error"
          class="directory-error"
          role="alert"
        >
          <Icon
            name="AlertCircle"
            :size="15"
          />{{ error }}
        </p>
        <div
          v-if="loading"
          class="empty-state compact"
        >
          <Icon
            name="LoaderCircle"
            class="spin"
          /><span>正在读取目录…</span>
        </div>
        <div
          v-else
          class="directory-entries"
        >
          <div
            v-for="folder in visible"
            :key="folder.path"
            class="directory-row"
            :class="{ selected: selected?.path === folder.path }"
          >
            <button
              class="directory-folder"
              :aria-pressed="selected?.path === folder.path"
              @click="selected = folder"
              @dblclick="navigate(folder.path)"
            >
              <Icon
                :name="folder.isGit ? 'FolderGit2' : 'FolderOpen'"
                :size="19"
              /><span>{{ folder.name }}</span
              ><span
                v-if="folder.isGit"
                class="directory-git-tag"
                ><Icon
                  name="GitBranch"
                  :size="11"
                />Git 仓库</span
              ></button
            ><button
              class="icon-button"
              :aria-label="`进入目录 ${folder.name}`"
              title="进入目录"
              @click="navigate(folder.path)"
            >
              <Icon
                name="ChevronRight"
                :size="15"
              />
            </button>
          </div>
          <div
            v-if="!visible.length && !error"
            class="empty-state compact"
          >
            <Icon
              name="FolderOpen"
              :size="28"
            /><span>{{
              query
                ? '没有匹配的目录'
                : distributionList
                  ? '未发现已安装的 WSL 发行版'
                  : '当前目录没有可显示的子目录'
            }}</span
            ><small>{{
              distributionList
                ? '请先在 Windows 中安装或导入 WSL 发行版。'
                : '可以直接选择当前目录，或输入其他路径。'
            }}</small>
          </div>
        </div>
        <p
          v-if="listing?.truncated"
          class="directory-limit"
        >
          目录较多，仅显示前 2000 个。可在地址栏输入具体路径。
        </p>
      </section>
    </div>
    <footer class="directory-footer">
      <div>
        <span>已选择</span
        ><strong v-overflow-title="selection">{{ selection || '尚未选择目录' }}</strong>
      </div>
      <div>
        <button
          v-if="isDesktop()"
          class="text-button muted"
          @click="systemPicker"
        >
          系统选择器</button
        ><button
          class="secondary-button"
          @click="emit('close')"
        >
          取消</button
        ><button
          class="primary-button"
          :disabled="!selection || virtualSelection || loading || !!error"
          @click="emit('select', selection)"
        >
          <Icon
            name="Check"
            :size="15"
          />{{ mode === 'repo' ? '选择仓库目录' : '选择父目录' }}
        </button>
      </div>
    </footer>
  </dialog>
</template>
