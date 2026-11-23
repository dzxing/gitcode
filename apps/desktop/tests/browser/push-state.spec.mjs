import { test } from '@playwright/test'
import { verifyPushStates } from '../../scripts/verify-push-state-ui.mjs'
test('push checks existing targets, preserves failed-check inputs, invalidates edited plans and warns about deleted targets', async ({
  page,
  baseURL,
}) => {
  await verifyPushStates(page, { url: baseURL })
})
