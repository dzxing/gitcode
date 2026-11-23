import { test } from '@playwright/test'
import { verifyLocalCore } from '../../scripts/verify-local-core-ui.mjs'

test('browser connects to local Git, selects a directory, creates and commits a temporary repository', async ({
  page,
  baseURL,
}) => {
  await verifyLocalCore(page, { url: baseURL })
})
