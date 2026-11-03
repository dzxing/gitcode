import { test } from '@playwright/test'
import { verifyGitKrakenParity } from '../../scripts/verify-gitkraken-parity-ui.mjs'

test('GitKraken parity: upstream chooser, automatic local protection, and explicit remote checkout decisions', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000)
  await verifyGitKrakenParity(page, { url: baseURL })
})
