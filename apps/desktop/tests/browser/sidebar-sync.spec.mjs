import { test } from '@playwright/test'
import { verifySidebarSync } from '../../scripts/verify-sidebar-sync-ui.mjs'
test('navigation shows current branch sync counts and honest upstream states without overlapping controls', async ({
  page,
  baseURL,
}) => {
  await verifySidebarSync(page, { url: baseURL })
})
