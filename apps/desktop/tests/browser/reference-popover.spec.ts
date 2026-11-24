import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
async function open(page: import('@playwright/test').Page, right = false) {
  await page.addInitScript(
    (after) => localStorage.setItem('gitcode.graph-labels-after-message', String(after)),
    right,
  )
  const snapshot = structuredClone(repositoryFixture)
  snapshot.branches.push({
    name: 'dev',
    hash: snapshot.head,
    current: false,
    upstream: '',
    track: '',
    kind: 'local',
  })
  await openFixtureRepository(page, false, snapshot)
  return page.locator(`[data-commit-hash="${snapshot.head}"] .ref-more`)
}
for (const right of [false, true])
  test(`引用列表在按钮附近弹出且非模态 (${right ? 'right' : 'left'})`, async ({ page }) => {
    const trigger = await open(page, right)
    const anchor = (await trigger.boundingBox())!
    await trigger.click()
    const popup = page.getByRole('dialog', { name: '提交引用', exact: true })
    await expect(popup).toBeVisible()
    expect(await popup.evaluate((el) => el.matches(':popover-open'))).toBe(true)
    await expect(popup.locator('li')).toHaveCount(3)
    await page.screenshot({
      path: `design/idea-commit-menu/implementation/reference-popover-${right ? 'right' : 'left'}.png`,
    })
    const box = (await popup.boundingBox())!
    expect(Math.abs(box.y - anchor.y - anchor.height - 4)).toBeLessThanOrEqual(1)
    if (right) expect(Math.abs(box.x + box.width - anchor.x - anchor.width)).toBeLessThanOrEqual(1)
    else expect(Math.abs(box.x - anchor.x)).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await expect(popup).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await page.getByRole('textbox', { name: '搜索提交', exact: true }).click()
    await expect(popup).not.toBeVisible()
    await expect(page.getByRole('textbox', { name: '搜索提交', exact: true })).toBeFocused()
  })
test('浮层中右键沿用分支菜单，Esc 返回原 +N，点击本地分支使用受保护检出流程', async ({ page }) => {
  const trigger = await open(page, true)
  await trigger.click()
  const popup = page.getByRole('dialog', { name: '提交引用', exact: true })
  await popup
    .getByRole('button', { name: '切换到本地分支 dev', exact: true })
    .click({ button: 'right' })
  await expect(popup).not.toBeVisible()
  await expect(page.getByRole('menu')).toHaveAccessibleName('dev 右键菜单')
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.evaluate(() => {
    window.gitcode!.action = async (_repo, request) => {
      document.documentElement.dataset.popupCheckout = JSON.stringify(request)
      return {
        snapshot: null,
        output: '',
        outcome: 'failed',
        error: 'Test stops before writing Git',
      }
    }
  })
  await trigger.click()
  await popup.getByRole('button', { name: '切换到本地分支 dev', exact: true }).click()
  await expect(popup).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.popupCheckout))
    .toBeTruthy()
  expect(
    await page.evaluate(() => JSON.parse(document.documentElement.dataset.popupCheckout!)),
  ).toMatchObject({
    action: 'checkout',
    name: 'dev',
    expectedHead: repositoryFixture.head,
    expectedOid: repositoryFixture.head,
  })
})
test('引用浮层支持键盘选择，窄窗口保持边界，历史滚动后关闭', async ({ page }) => {
  const trigger = await open(page, true)
  await trigger.click()
  const popup = page.getByRole('dialog', { name: '提交引用', exact: true })
  await page.keyboard.press('End')
  await expect(popup.locator('.reference-popup-action').last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(popup.locator('.reference-popup-action').first()).toBeFocused()
  await page.setViewportSize({ width: 900, height: 500 })
  await expect
    .poll(async () => {
      const b = await popup.boundingBox()
      return !!b && b.x >= 8 && b.y >= 8 && b.x + b.width <= 892 && b.y + b.height <= 492
    })
    .toBe(true)
  await page.locator('.history-scroll').dispatchEvent('scroll')
  await expect(popup).not.toBeVisible()
})
