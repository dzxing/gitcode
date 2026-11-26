import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRepositoryStore } from '../features/repository/stores/repository'
import { currentNativeWindow } from '../infrastructure/windowBridge'
import { getUIPlatform } from '../infrastructure/uiPlatform'

export function useDesktopWindow() {
  const store = useRepositoryStore()
  const native = currentNativeWindow()
  const platform = computed(getUIPlatform)
  const nativeWindow = computed(() => !!native)
  const nativeControls = computed(() => native?.nativeControls === true)
  const customFrame = computed(
    () => !!native && !nativeControls.value && platform.value !== 'macos',
  )
  const maximized = ref(false)
  const fullscreen = ref(false)
  const focused = ref(true)
  const unlisteners: (() => void)[] = []
  let disposed = false
  let revision = 0

  async function refreshState() {
    if (!native) return
    const version = ++revision
    try {
      const [max, full, focus] = await Promise.all([
        native.isMaximized(),
        native.isFullscreen(),
        native.isFocused(),
      ])
      if (disposed || version !== revision) return
      maximized.value = max
      fullscreen.value = full
      focused.value = focus
    } catch (error) {
      if (!disposed) store.notify(`无法读取窗口状态：${String(error)}`, true)
    }
  }

  async function action(kind: 'minimize' | 'maximize' | 'close') {
    if (!native) return
    try {
      if (kind === 'minimize') await native.minimize()
      if (kind === 'maximize') {
        await native.toggleMaximize()
        await refreshState()
      }
      if (kind === 'close') await native.close()
    } catch (error) {
      store.notify(`窗口操作失败：${String(error)}`, true)
    }
  }

  async function listen(promise: Promise<() => void>) {
    try {
      const unlisten = await promise
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    } catch (error) {
      if (!disposed) store.notify(`窗口事件连接失败：${String(error)}`, true)
    }
  }

  onMounted(() => {
    if (!native) return
    void refreshState()
    void listen(
      native.onResized(() => {
        void refreshState()
      }),
    )
    void listen(
      native.onFocusChanged((event) => {
        focused.value = event.payload
        if (event.payload) store.requestExternalRefresh()
      }),
    )
  })
  onUnmounted(() => {
    disposed = true
    revision++
    unlisteners.forEach((unlisten) => unlisten())
  })

  return {
    customFrame,
    nativeControls,
    nativeWindow,
    platform,
    maximized,
    fullscreen,
    focused,
    action,
  }
}
