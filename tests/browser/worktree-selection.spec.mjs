import { test } from '@playwright/test'
import { verifyStagingZones } from '../../scripts/verify-staging-zones-ui.mjs'

test('dual staging zones keep batch selection separate from commit scope through the real core', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000)
  await verifyStagingZones(page, { url: baseURL })
})
