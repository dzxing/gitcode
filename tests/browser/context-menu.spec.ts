import { openFixtureRepository } from './repository-fixture'
import { expect, test } from '@playwright/test'

test('branch and commit menus target the right-clicked object without changing selection', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const selected = page.locator('.wip-row')
  await expect(selected).toHaveClass(/selected/)
  await page
    .locator('.branch-main')
    .filter({ hasText: 'develop' })
    .first()
    .click({ button: 'right' })
  let menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.context-menu-heading')).toHaveText('develop')
  await expect(menu.getByRole('menuitem', { name: /创建分支/ })).toBeEnabled()
  await expect(selected).toHaveClass(/selected/)
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(page.locator('.branch-main').filter({ hasText: 'develop' }).first()).toBeFocused()

  const row = page.locator('.commit-row').nth(2)
  await row.locator('.commit-select').click({ button: 'right' })
  menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: '查看提交详情', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '切换到此分支', exact: true })).toHaveCount(0)
  await expect(selected).toHaveClass(/selected/)
  await menu.getByRole('menuitem', { name: '查看提交详情', exact: true }).click()
  await expect(row).toHaveClass(/selected/)
})

test('reference labels, keyboard invocation, columns and menu edges work', async ({ page }) => {
  await openFixtureRepository(page)
  await page.locator('.ref-tag').first().click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: '复制分支名', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  const header = page.getByLabel('历史列表显示列', { exact: true })
  await header.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'SHA', exact: true }).click()
  await expect(page.locator('.history-panel')).toHaveClass(/show-sha/)
  await page.locator('.history-scroll').click({ button: 'right', position: { x: 800, y: 700 } })
  const bounds = await page.getByRole('menu').boundingBox()
  const viewport = page.viewportSize()!
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).not.toBeVisible()
})
