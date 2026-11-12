import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const [parent, child] of [
  ['分支标签位置', '提交说明后'],
  ['分支标签样式', 'IDEA 风格'],
  ['主题', '跟随系统'],
]) {
  test(`${parent}: diagonal pointer movement reaches submenu without switching it`, async ({
    page,
  }) => {
    await openFixtureRepository(page)
    await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
    const trigger = page.getByRole('menuitem', { name: parent, exact: true })
    await trigger.click()
    const menu = page.getByRole('menu', { name: parent, exact: true })
    const source = (await trigger.boundingBox())!
    const target = (await menu
      .getByRole('menuitemradio', { name: child, exact: true })
      .boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitemradio', { name: child, exact: true }).click()
    await expect(page.getByRole('menu')).not.toBeVisible()
    if (parent === '分支标签样式')
      await expect(page.locator('.history-panel')).toHaveAttribute('data-label-style', 'idea')
    if (parent === '分支标签位置')
      await expect(page.locator('.history-panel')).toHaveClass(/labels-after-message/)
    if (parent === '主题')
      expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('system')
  })
}

test('left-opening submenu also tolerates diagonal movement', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 })
  await openFixtureRepository(page)
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  const trigger = page.getByRole('menuitem', { name: '分支标签样式', exact: true })
  await trigger.click()
  const menu = page.getByRole('menu', { name: '分支标签样式', exact: true })
  const a = (await trigger.boundingBox())!
  const b = (await menu
    .getByRole('menuitemradio', { name: 'IDEA 风格', exact: true })
    .boundingBox())!
  expect(b.x).toBeLessThan(a.x)
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
  await expect(menu).toBeVisible()
  await page.waitForTimeout(350)
  await menu.getByRole('menuitemradio', { name: 'IDEA 风格', exact: true }).click()
  await expect(page.locator('.history-panel')).toHaveAttribute('data-label-style', 'idea')
})

test('pausing on another parent switches menus; Escape cancels pending hover', async ({ page }) => {
  await openFixtureRepository(page)
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  const trigger = page.getByRole('menuitem', { name: '分支标签样式', exact: true })
  await trigger.click()
  const a = (await trigger.boundingBox())!
  const theme = (await page.getByRole('menuitem', { name: '主题', exact: true }).boundingBox())!
  const menu = page.getByRole('menu', { name: '分支标签样式', exact: true })
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.move(a.x + a.width - 8, theme.y + theme.height / 2, { steps: 10 })
  await expect(page.getByRole('menu', { name: '主题', exact: true })).toBeVisible()
  await expect(menu).not.toBeVisible()
  await trigger.click()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.move(a.x + a.width - 8, theme.y + theme.height / 2, { steps: 10 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
  await expect(page.getByRole('menu')).not.toBeVisible()
})

test('View commands change actual columns, merge appearance, focus and refresh result', async ({
  page,
}) => {
  await openFixtureRepository(page)
  async function view(label: string, checkbox = false) {
    await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
    await page
      .getByRole(checkbox ? 'menuitemcheckbox' : 'menuitem', { name: new RegExp(`^${label}`) })
      .click()
  }
  const panel = page.locator('.history-panel')
  for (const [label, css, cell] of [
    ['显示作者', 'show-author', '.author-cell'],
    ['显示时间', 'show-time', '.commit-row .time-cell'],
    ['显示提交 SHA', 'show-sha', '.commit-row .sha-cell'],
  ]) {
    await view(label, true)
    await expect(panel).toHaveClass(new RegExp(css))
    await expect(page.locator(cell).first()).toBeVisible()
  }
  await view('恢复默认列显示')
  await expect(panel).not.toHaveClass(/show-author|show-time|show-sha/)
  await expect(page.locator('.commit-row.is-merge').first()).toBeVisible()
  await view('淡化合并提交', true)
  await expect(page.locator('.commit-row.is-merge')).toHaveCount(0)
  await view('淡化合并提交', true)
  await expect(page.locator('.commit-row.is-merge').first()).toBeVisible()
  await view('搜索提交')
  await expect(page.getByLabel('搜索提交', { exact: true })).toBeFocused()
  await page.evaluate(() => {
    const snapshot = window.gitk!.snapshot
    window.gitk!.snapshot = async (...args) => ({ ...(await snapshot(...args)), total: 987 })
  })
  await view('刷新本地状态')
  await expect(page.locator('.history-heading .pill')).toHaveText('987')
})
