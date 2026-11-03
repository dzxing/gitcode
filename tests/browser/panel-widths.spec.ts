import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
const key = 'gitcode.panel-widths'
const width = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => element.getBoundingClientRect().width)
async function drag(page: Page, name: string, delta: number) {
  const bounds = (await page.getByRole('separator', { name, exact: true }).boundingBox())!
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + 50
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + delta, y, { steps: 5 })
  await page.mouse.up()
}
test('dragged panel widths survive reload, repository tabs and a newly opened browser page', async ({
  page,
  context,
}) => {
  await openFixtureRepository(page)
  await drag(page, '调整侧栏宽度', 30)
  await drag(page, '调整详情面板宽度', -50)
  const sidebar = await width(page, '.sidebar'),
    inspector = await width(page, '.inspector')
  expect(sidebar).toBeCloseTo(280, 0)
  expect(inspector).toBeCloseTo(380, 0)
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual({
    sidebar,
    inspector,
  })
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.locator('.repo-tab:not(.new-page-tab) .tab-select').first().click()
  expect(await width(page, '.sidebar')).toBe(sidebar)
  await page.reload()
  await openFixtureRepository(page)
  expect(await width(page, '.sidebar')).toBe(sidebar)
  expect(await width(page, '.inspector')).toBe(inspector)
  const reopened = await context.newPage()
  try {
    await openFixtureRepository(reopened)
    expect(await width(reopened, '.sidebar')).toBe(sidebar)
    expect(await width(reopened, '.inspector')).toBe(inspector)
  } finally {
    await reopened.close()
  }
})
test('narrow layouts temporarily shrink and never overwrite the saved widths', async ({ page }) => {
  await openFixtureRepository(page)
  await drag(page, '调整侧栏宽度', 40)
  await drag(page, '调整详情面板宽度', -40)
  const saved = await page.evaluate((key) => localStorage.getItem(key), key)
  await page.setViewportSize({ width: 900, height: 850 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '190px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '290px')
  const divider = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await expect(divider).toHaveAttribute('aria-disabled', 'true')
  await divider.dispatchEvent('keydown', { key: 'ArrowRight' })
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(saved)
  await page.reload()
  await openFixtureRepository(page)
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(saved)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '290px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '370px')
})
test('keyboard widths persist while an untouched panel keeps its responsive default', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const divider = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual({
    sidebar: 270,
  })
  await page.setViewportSize({ width: 1920, height: 1000 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '270px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '400px')
  await page.reload()
  await openFixtureRepository(page)
  await expect(page.locator('.sidebar')).toHaveCSS('width', '270px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '400px')
})
for (const [name, value, sidebar, inspector] of [
  ['corrupt', '{broken', 250, 330],
  ['out-of-range', JSON.stringify({ sidebar: 99999, inspector: -3 }), 330, 290],
  ['wrong types', JSON.stringify({ sidebar: '280', inspector: null }), 250, 330],
] as const) {
  test(`saved panel widths handle ${name} settings safely`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key, value })
    await openFixtureRepository(page)
    await expect(page.locator('.sidebar')).toHaveCSS('width', `${sidebar}px`)
    await expect(page.locator('.inspector')).toHaveCSS('width', `${inspector}px`)
  })
}

test('View reset removes saved widths and restores responsive defaults without changing columns or drafts', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await drag(page, '调整侧栏宽度', 40)
  await drag(page, '调整详情面板宽度', -50)
  await page.getByLabel('提交说明', { exact: true }).fill('Keep this draft')
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '显示 SHA', exact: true }).click()
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page
    .getByRole('menu', { name: '视图', exact: true })
    .getByRole('menuitem', { name: '重置视图', exact: true })
    .click()
  await expect(page.locator('.sidebar')).toHaveCSS('width', '250px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '330px')
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
  await expect(page.locator('.history-panel')).toHaveClass(/show-sha/)
  await expect(page.getByLabel('提交说明', { exact: true })).toHaveValue('Keep this draft')
  await page.setViewportSize({ width: 1920, height: 1000 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '260px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '400px')
  await page.getByLabel('提交说明', { exact: true }).fill('')
  await page.reload()
  await openFixtureRepository(page)
  await expect(page.locator('.sidebar')).toHaveCSS('width', '260px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '400px')
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
})

test('reset is available on the repository hub and narrow layouts do not persist their temporary widths', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await drag(page, '调整侧栏宽度', 30)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.setViewportSize({ width: 900, height: 850 })
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  const reset = page.getByRole('menuitem', { name: '重置视图', exact: true })
  await expect(reset).toBeEnabled()
  await reset.click()
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
  await page.locator('.repo-tab:not(.new-page-tab) .tab-select').first().click()
  await expect(page.locator('.sidebar')).toHaveCSS('width', '190px')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '250px')
})
