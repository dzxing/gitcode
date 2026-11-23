import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { verifyLocalCore } from './verify-local-core-ui.mjs'

const endpoint = process.argv[2] || 'http://127.0.0.1:9222'
if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
  process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '[::1]']
    .filter(Boolean)
    .join(',')
  process.env.no_proxy = [process.env.no_proxy, process.env.NO_PROXY].filter(Boolean).join(',')
}
let browser, context, page
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 })
  const existing = browser
    .contexts()
    .flatMap((item) => item.pages())
    .find((page) => /https?:\/\/[^/]+:43187\//.test(page.url()))
  const url = process.argv[3] || existing?.url() || 'http://localhost:43187/'
  context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  page = await context.newPage()
  await mkdir('design', { recursive: true })
  const report = {
    verifiedAt: new Date().toISOString(),
    ...(await verifyLocalCore(page, { url, screenshotPath: 'design/local-core-verification.png' })),
  }
  await writeFile('design/local-core-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: 'design/local-core-verification-failure.png', fullPage: true })
      .catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  try {
    await context?.close()
  } finally {
    await browser?.close()
  }
}
