import { test } from '@playwright/test'
import { verifySidebar } from '../../scripts/verify-sidebar-ui.mjs'

test('sidebar sorting, hierarchy, keyboard reordering and persistence use the real renderer', async ({
  page,
  baseURL,
}) => {
  await verifySidebar(page, { url: baseURL })
})
