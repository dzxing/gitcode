import { ref } from 'vue'
import { desktop } from '../../infrastructure/desktop'
import { noticePresentation } from '../../shared/lib/noticePresentation'
import type { RepositoryTrustInfo } from '../../shared/contracts'

// One controller per repository Store; never grants trust without a fresh user action.
export function createRepositoryTrust() {
  const trustRequest = ref<RepositoryTrustInfo | null>(null)
  const trustError = ref('')
  const trustApproving = ref(false)
  let resolveTrust: ((approved: boolean) => void) | null = null
  function cancelTrust() {
    if (trustApproving.value) return
    trustRequest.value = null
    resolveTrust?.(false)
    resolveTrust = null
  }
  async function approveTrust() {
    const request = trustRequest.value
    if (!request || trustApproving.value) return
    trustApproving.value = true
    trustError.value = ''
    try {
      await desktop.approveRepositoryTrust(request.path, request.token)
      trustRequest.value = null
      resolveTrust?.(true)
      resolveTrust = null
    } catch (error) {
      trustError.value = noticePresentation((error as Error).message, true).text
      // A consumed/expired challenge is never replayed. Refresh the metadata,
      // then require a fresh click before granting consent.
      try {
        trustRequest.value = await desktop.repositoryTrust(request.path)
      } catch {
        /* Keep cancellation available. */
      }
    } finally {
      trustApproving.value = false
    }
  }
  async function confirmRepositoryTrust(path: string) {
    const info = await desktop.repositoryTrust(path)
    if (info.trusted) return true
    trustError.value = ''
    trustRequest.value = info
    return new Promise<boolean>((resolve) => {
      resolveTrust = resolve
    })
  }
  return {
    trustRequest,
    trustError,
    trustApproving,
    cancelTrust,
    approveTrust,
    confirmRepositoryTrust,
  }
}
