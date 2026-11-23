import { test } from '@playwright/test'
import { verifyPublish } from '../../scripts/verify-publish-ui.mjs'
for (const custom of [false, true])
  test(`GitFlow first push ${custom ? 'custom target from another branch' : 'default origin target'}`, async ({
    page,
    baseURL,
  }) => {
    await verifyPublish(page, { url: baseURL, custom })
  })
