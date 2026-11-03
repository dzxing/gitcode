import { test } from '@playwright/test'
import { verifyRemoteTree } from './remote-tree-flow'
test('remote display settings switch directory tree and flat layout while preserving branch actions and preferences', async ({
  page,
}) => {
  await verifyRemoteTree(page)
})
