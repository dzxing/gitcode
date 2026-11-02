import { test } from '@playwright/test'
import { verifyReferenceCheckout } from '../../scripts/verify-reference-checkout-ui.mjs'

test('local reference click attempts a guarded real checkout while preserving dirty edits and read-only references', async ({
  page,
  baseURL,
}) => {
  await verifyReferenceCheckout(page, { url: baseURL })
})
