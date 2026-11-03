import { test } from '@playwright/test'
import { verifyMenuEntry } from '../../scripts/verify-menu-entry-ui.mjs'
test('navigation hides impossible actions and routes upstream and dirty stash decisions without writes', async ({
  page,
  baseURL,
}) => {
  await verifyMenuEntry(page, { url: baseURL })
})
