<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { desktop } from '../services/desktop'
import { useRepositoryStore } from '../stores/repository'
import type { GitConsoleEntry, GitConsoleReply } from '../gitConsoleTypes'

const props = defineProps<{ active: boolean }>()
const repository = useRepositoryStore()
interface History {
  epoch?: string
  cursor: number
  entries: GitConsoleEntry[]
  running: GitConsoleReply['running']
  truncated: boolean
}
const histories = reactive(new Map<string, History>())
const current = computed(() => histories.get(repository.repo.path))
const viewport = ref<HTMLElement>()
const follow = ref(true),
  softWrap = ref(true),
  clearing = ref(false),
  error = ref('')
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const time = (at: number) => `${clock.format(at)}.${String(at % 1000).padStart(3, '0')}`
function scrolled() {
  const node = viewport.value
  if (node) follow.value = node.scrollHeight - node.clientHeight - node.scrollTop < 24
}
async function scrollEnd() {
  await nextTick()
  if (follow.value && viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
}
function stop() {
  generation++
  clearTimeout(timer)
}
async function read(version: number, repo: string) {
  if (version !== generation || !props.active) return
  const history = histories.get(repo)!
  let delay = 200
  try {
    const reply = await desktop.gitConsole(repo, {
      action: 'read',
      epoch: history.epoch,
      cursor: history.cursor,
    })
    if (version !== generation) return
    error.value = ''
    if (reply.reset) history.entries = []
    history.truncated ||= reply.dropped || reply.reset
    history.epoch = reply.epoch
    history.cursor = reply.cursor
    if (
      history.running.map((entry) => entry.commandId).join() !==
      reply.running.map((entry) => entry.commandId).join()
    )
      history.running = reply.running
    for (const entry of reply.entries) {
      const last = history.entries.at(-1)
      const progressPhase = (text: string) => /^(.*?)\d+(?:\.\d+)?%/.exec(text)?.[1]
      const phase = progressPhase(entry.text)
      if (
        last?.progress &&
        last.commandId === entry.commandId &&
        last.kind === entry.kind &&
        phase !== undefined &&
        phase === progressPhase(last.text)
      )
        history.entries[history.entries.length - 1] = entry
      else history.entries.push(entry)
    }
    let characters = history.entries.reduce((total, entry) => total + entry.text.length, 0)
    while (history.entries.length > 1500 || characters > 256 * 1024) {
      characters -= history.entries.shift()!.text.length
      history.truncated = true
    }
    if (reply.entries.length) await scrollEnd()
    delay = reply.more ? 16 : 200
  } catch (reason) {
    if (version !== generation) return
    error.value = reason instanceof Error ? reason.message : '无法读取 Git 控制台。'
    delay = 1500
  }
  if (version === generation && props.active)
    timer = setTimeout(() => void read(version, repo), delay)
}
function start() {
  stop()
  error.value = ''
  const repo = repository.repo.path
  if (!props.active || !repo) return
  if (!histories.has(repo)) {
    // A bounded cache for previously opened repositories; backend recording continues independently.
    if (histories.size >= 20) histories.delete(histories.keys().next().value!)
    histories.set(repo, { cursor: 0, entries: [], running: [], truncated: false })
  }
  void read(generation, repo)
}
async function clear() {
  if (clearing.value) return
  stop()
  const version = generation,
    repo = repository.repo.path
  clearing.value = true
  try {
    const reply = await desktop.gitConsole(repo, { action: 'tail' })
    if (version !== generation) return
    histories.set(repo, {
      epoch: reply.epoch,
      cursor: reply.cursor,
      entries: [],
      running: reply.running,
      truncated: false,
    })
    follow.value = true
  } catch (reason) {
    if (version === generation)
      error.value = reason instanceof Error ? reason.message : '无法清空控制台。'
  } finally {
    clearing.value = false
    if (version === generation) void read(version, repo)
  }
}
watch([() => props.active, () => repository.repo.path], start, { immediate: true })
onUnmounted(stop)
</script>
<template>
  <section
    class="git-console"
    aria-label="Git 控制台输出"
  >
    <div class="git-console-actions">
      <span role="status">{{ current?.running.length ? 'Git 正在执行…' : 'Git 控制台' }}</span>
      <label
        ><input
          v-model="softWrap"
          type="checkbox"
        />自动换行</label
      >
      <label
        ><input
          v-model="follow"
          type="checkbox"
          @change="scrollEnd"
        />跟随输出</label
      >
      <button
        class="text-button"
        :disabled="clearing"
        @click="clear"
      >
        清空
      </button>
    </div>
    <p
      v-if="error"
      class="git-console-error"
      role="alert"
    >
      {{ error }}
    </p>
    <div
      ref="viewport"
      class="git-console-output"
      :class="{ 'soft-wrap': softWrap }"
      tabindex="0"
      aria-label="Git 命令与输出"
      @scroll="scrolled"
    >
      <p
        v-if="current?.truncated"
        class="git-console-note"
      >
        较早的输出已省略。
      </p>
      <p
        v-if="!current?.entries.length"
        class="git-console-note"
      >
        {{ current?.running.length ? '正在等待命令输出…' : '暂无 Git 命令输出' }}
      </p>
      <div
        v-for="entry in current?.entries"
        :key="`${current?.epoch}-${entry.sequence}`"
        class="git-console-line"
        :class="[entry.kind, entry.state]"
        :data-command-id="entry.commandId"
        :data-operation-id="entry.operationId"
        :data-sequence="entry.sequence"
      >
        <time>{{ time(entry.at) }}</time>
        <span v-if="entry.kind === 'finish'"
          >{{
            entry.state === 'cancelled'
              ? '已取消'
              : entry.state === 'succeeded'
                ? '执行完成'
                : '命令结束'
          }}
          · {{ entry.code === null ? '无退出码' : `退出码 ${entry.code}` }} ·
          {{ entry.elapsed }} ms{{ entry.text ? ` · ${entry.text}` : '' }}</span
        >
        <span v-else>{{ entry.text }}</span>
      </div>
    </div>
  </section>
</template>
