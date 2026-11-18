import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const [id, name] of [
  ['islands-dark', 'Islands Dark'],
  ['islands-light', 'Islands Light'],
  ['islands-darcula', 'Islands Darcula'],
] as const) {
  test(`${name} 分区保留缩放拖动与切回普通主题的布局`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await openFixtureRepository(page)
    const sidebar = page.locator('.sidebar')
    const before = await sidebar.boundingBox()
    await page.keyboard.press('Alt+v')
    await page.getByRole('menuitem', { name: '主题', exact: true }).click()
    const menu = page.getByRole('menu', { name: '主题', exact: true })
    const bounds = await menu.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720)
    await menu.getByRole('menuitemradio', { name, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-palette', id)
    await expect(sidebar).toHaveCSS('border-top-left-radius', '8px')
    await expect(sidebar).toHaveCSS('margin-top', '6px')
    const historyPanel = page.locator('.history-panel'),
      inspector = page.locator('.inspector')
    for (const panel of [historyPanel, inspector]) {
      await expect(panel).toHaveCSS('border-top-left-radius', '8px')
      await expect(panel).toHaveCSS('margin-top', '6px')
    }
    await expect(inspector).toHaveCSS('border-left-width', '0px')
    await expect(page.locator('.history-tool-host')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    )
    const rightHandle = page.getByRole('separator', { name: '调整详情面板宽度', exact: true })
    const right = await rightHandle.boundingBox(),
      historyBounds = await historyPanel.boundingBox(),
      inspectorBounds = await inspector.boundingBox()
    expect(right!.x + right!.width / 2).toBeGreaterThanOrEqual(
      historyBounds!.x + historyBounds!.width,
    )
    expect(right!.x + right!.width / 2).toBeLessThanOrEqual(inspectorBounds!.x)
    await expect(
      page.locator('.toolbar').getByRole('button', { name: '打开仓库', exact: true }),
    ).toBeEnabled()
    const selection = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--view-selection-bg').trim(),
    )
    const rgb = `rgb(${[1, 3, 5].map((offset) => parseInt(selection.slice(offset, offset + 2), 16)).join(', ')})`
    await expect(page.locator('.wip-row.selected')).toHaveCSS('background-color', rgb)
    await page.screenshot({ path: `design/theme-presets/${id}-framing.png` })
    const handle = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    const after = await sidebar.boundingBox()
    expect(after!.width).toBe(before!.width + 10 - 9)
    const handleBounds = await handle.boundingBox()
    const history = await page.locator('.history-panel').boundingBox()
    const handleCenter = handleBounds!.x + handleBounds!.width / 2
    expect(handleCenter).toBeGreaterThanOrEqual(after!.x + after!.width)
    expect(handleCenter).toBeLessThanOrEqual(history!.x)
    const dragX = handleCenter
    const dragY = handleBounds!.y + handleBounds!.height / 2
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX + 20, dragY)
    await page.mouse.up()
    expect((await sidebar.boundingBox())!.width).toBe(after!.width + 20)
    await page.evaluate(() => {
      window.gitk!.historyTools = async () => ({
        versions: [0, 1, 2].map((i) => ({ exists: true, binary: false, text: `version ${i}` })),
      })
    })
    await page.locator('.worktree-file-main').first().click()
    await page.getByRole('button', { name: '比较三个版本', exact: true }).click()
    await expect(page.getByRole('region', { name: '三版本对照', exact: true })).toBeVisible()
    await expect(page.locator('.history-tool-view')).toHaveCSS('border-top-left-radius', '8px')
    await expect(page.locator('.history-tool-view')).toHaveCSS('overflow', 'hidden')
    await expect(page.locator('.history-tool-tabs')).toHaveCSS('border-top-left-radius', '8px')
    await page.screenshot({ path: `design/theme-presets/${id}-tool-framing.png` })
    await page.getByRole('tab', { name: '提交历史', exact: true }).click()
    await expect(historyPanel).toHaveCSS('border-top-left-radius', '8px')
    await page.keyboard.press('Alt+v')
    await page.getByRole('menuitem', { name: '主题', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'GitCode 深色', exact: true }).click()
    await expect(historyPanel).toHaveCSS('border-top-left-radius', '0px')
    await expect(inspector).toHaveCSS('border-left-width', '1px')
    await expect(page.locator('.history-tool-tabs')).toHaveCSS('border-top-left-radius', '0px')
    await expect(sidebar).toHaveCSS('margin-top', '0px')
    await expect(sidebar).toHaveCSS('border-top-left-radius', '0px')
    expect((await sidebar.boundingBox())!.width).toBe(before!.width + 30)
    expect(
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--window-bg')),
    ).toBe('')
  })
}
