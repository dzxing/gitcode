import type { Page } from '@playwright/test'

export function verifyCheckoutProgress(
  page: Page,
  options?: { url?: string; screenshotDirectory?: string },
): Promise<{
  passed: boolean
  realGit: boolean
  postCheckoutHook: boolean
  navigationBlocked: boolean
  branchUpdatedAfterSnapshot: boolean
}>
