import { test } from '@playwright/test'
import { verifyDeleteBranch } from '../../scripts/verify-delete-branch-ui.mjs'
test('local unmerged deletion requires explicit confirmation while cancellation preserves the branch', async ({
  page,
  baseURL,
}) => {
  await verifyDeleteBranch(page, { url: baseURL })
})
