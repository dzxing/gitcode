import { computed, ref } from 'vue'

export function createHistoryColumns() {
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth || 1440 : 1440)
  const authorPreference = ref<boolean | null>(null),
    timePreference = ref<boolean | null>(null)
  const showAuthor = computed({
    get: () => authorPreference.value ?? viewportWidth.value >= 1600,
    set: (value: boolean) => {
      authorPreference.value = value
    },
  })
  const showTime = computed({
    get: () => timePreference.value ?? viewportWidth.value >= 1600,
    set: (value: boolean) => {
      timePreference.value = value
    },
  })
  const showSha = ref(false)
  function updateViewport(width: number) {
    viewportWidth.value = width
  }
  function resetColumns() {
    authorPreference.value = null
    timePreference.value = null
    showSha.value = false
  }
  return { viewportWidth, showAuthor, showTime, showSha, updateViewport, resetColumns }
}
