import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
async function toggle(page: import('@playwright/test').Page) {
  const after = (await page.locator('.history-panel').getAttribute('class'))!.includes(
    'labels-after-message',
  )
  await page.getByRole('menubar').getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitem', { name: '分支标签位置', exact: true }).click()
  await page
    .getByRole('menuitemradio', { name: after ? '关系图左侧' : '提交说明后', exact: true })
    .click()
}
test('视图勾选切换真实标签位置并记忆；取消回到图前且连接线恢复', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('gitcode.graph-labels-after-message') === null)
      localStorage.setItem('gitcode.graph-labels-after-message', 'false')
  })
  await openFixtureRepository(page)
  const panel = page.locator('.history-panel')
  const row = page.locator(`[data-commit-hash="${repositoryFixture.head}"]`)
  await expect(panel).not.toHaveClass(/labels-after-message/)
  const before = await row.locator('.ref-cell').boundingBox()
  const graphBefore = await page.locator('.commit-graph').boundingBox()
  expect(before!.x).toBeLessThan(graphBefore!.x)
  await toggle(page)
  await expect(panel).toHaveClass(/labels-after-message/)
  await expect(
    row.locator('.commit-message .ref-cell .ref-labels-content .reference-badge'),
  ).toBeVisible()
  const position = await row.evaluate((el) => {
    const text = el.querySelector('.commit-subject')!.getBoundingClientRect()
    const ref = el.querySelector('.ref-cell')!.getBoundingClientRect()
    const graph = el.querySelector('.graph-lane-cell')!.getBoundingClientRect()
    return {
      text: text.x,
      textRight: text.right,
      ref: ref.x,
      graph: graph.x,
      graphRight: graph.right,
      y: ref.y,
      rowY: el.getBoundingClientRect().y,
    }
  })
  expect(position.ref).toBeGreaterThanOrEqual(position.textRight)
  expect(position.text).toBeGreaterThanOrEqual(position.graphRight)
  const alignment = await page.locator('.commit-row').evaluateAll((rows) =>
    rows
      .filter((row) => row.querySelector('.ref-labels-content'))
      .map((row) => {
        const message = row.querySelector('.commit-message')!
        const labels = row.querySelector('.ref-labels-content')!
        return {
          right: labels.getBoundingClientRect().right,
          expected:
            message.getBoundingClientRect().right -
            parseFloat(getComputedStyle(message).paddingRight),
        }
      }),
  )
  expect(alignment.length).toBeGreaterThan(1)
  for (const row of alignment) expect(Math.abs(row.right - row.expected)).toBeLessThanOrEqual(1)
  expect(await page.locator('.reference-connectors line').count()).toBe(0)
  expect(
    await page.evaluate(() => localStorage.getItem('gitcode.graph-labels-after-message')),
  ).toBe('true')
  await page.screenshot({ path: 'design/idea-commit-menu/implementation/labels-after-message.png' })
  await openFixtureRepository(page)
  await expect(panel).toHaveClass(/labels-after-message/)
  await page.getByRole('menubar').getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitem', { name: '分支标签位置', exact: true }).click()
  await expect(
    page.getByRole('menuitemradio', { name: '提交说明后', exact: true }),
  ).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await toggle(page)
  await expect(panel).not.toHaveClass(/labels-after-message/)
  await expect(row.locator(':scope > .ref-cell')).toBeVisible()
  await expect.poll(() => page.locator('.reference-connectors line').count()).toBeGreaterThan(0)
})
test('两种位置复用标签右键操作，切换不会重复标签或改变选中提交', async ({ page }) => {
  await openFixtureRepository(page)
  const row = page.locator(`[data-commit-hash="${repositoryFixture.head}"]`)
  const badges = await row.locator('.ref-labels-content .reference-badge').count()
  await toggle(page)
  expect(await row.locator('.ref-labels-content .reference-badge').count()).toBe(badges)
  await expect(page.locator('.wip-row')).toHaveClass(/selected/)
  await row.locator('.ref-labels-content .ref-primary').first().click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: '复制分支名', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await toggle(page)
  expect(await row.locator('.ref-labels-content .reference-badge').count()).toBe(badges)
})
