import { test } from '@playwright/test'
import { verifySyncDivergence } from '../../scripts/verify-sync-divergence-ui.mjs'
for (const sameLine of [false, true])
  test(`divergence: local commit succeeds, push and ff-only pull preserve both histories (${sameLine ? 'same line' : 'different files'})`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60000)
    await verifySyncDivergence(page, { url: baseURL, sameLine })
  })
