import { test } from '@playwright/test'
import { verifySyncDivergence } from '../../scripts/verify-sync-divergence-ui.mjs'
for (const [name, sameLine, abortMerge] of [
  ['clean merge', false, false],
  ['manual conflict resolution', true, false],
  ['abort conflicted merge', true, true],
])
  test(
    name + ' from rejected push through explicit merge integration',
    async ({ page, baseURL }) => {
      test.setTimeout(90000)
      await verifySyncDivergence(page, { url: baseURL, sameLine, abortMerge, mergeAfter: true })
    },
  )
