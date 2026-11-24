import { test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { verifySyncDivergence } from '../../scripts/verify-sync-divergence-ui.mjs'
for (const sameLine of [false, true])
  test(
    sameLine
      ? 'pull-and-push pauses at conflicts and manual completion never resumes publication'
      : 'pull-and-push integrates and publishes after fresh verification',
    async ({ page, baseURL }) => {
      test.setTimeout(90000)
      await verifySyncDivergence(page, {
        url: baseURL,
        sameLine,
        recoverPush: true,
        screenshotDirectory: fileURLToPath(
          new URL('../../../../design/sync-recovery/', import.meta.url),
        ),
      })
    },
  )
