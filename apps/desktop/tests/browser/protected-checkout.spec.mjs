import { test } from '@playwright/test'
import { verifyProtectedCheckout } from '../../scripts/verify-protected-checkout-ui.mjs'
for (const scenario of ['safe', 'cancel', 'stale', 'conflict', 'staged'])
  test(`protected checkout: ${scenario}`, async ({ page, baseURL }) => {
    await verifyProtectedCheckout(page, { url: baseURL, scenario })
  })
