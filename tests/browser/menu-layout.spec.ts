import { expect, test, type Locator } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

async function measure(menu: Locator) {
  return menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    return {
      x: bounds.x,
      y: bounds.y,
      right: bounds.right,
      bottom: bounds.bottom,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      rows: [...element.querySelectorAll<HTMLElement>(':scope > button')].map((button) => {
        const r = button.getBoundingClientRect(),
          s = getComputedStyle(button)
        const label = button.querySelector('.context-menu-label, .application-item-label') || button
        const range = document.createRange()
        range.selectNodeContents(label)
        const text = range.getBoundingClientRect()
        return {
          name: button.textContent?.trim(),
          height: r.height,
          left: s.paddingLeft,
          top: s.paddingTop,
          bottom: s.paddingBottom,
          font: s.fontSize,
          line: parseFloat(s.lineHeight),
          offset: Math.abs(text.y + text.height / 2 - r.y - r.height / 2),
          overflow: button.scrollWidth > button.clientWidth,
        }
      }),
    }
  })
}
for (const [theme, size, width] of [
  ['dark', 13, 1440],
  ['islands-light', 13, 760],
  ['dark', 16, 760],
  ['islands-light', 16, 1440],
] as const)
  test(`${theme} ${size}px ${width}px: 菜单行高与留白一致，单击、右键及键盘操作可用`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 })
    await page.addInitScript(
      ({ theme, size }) => {
        localStorage.setItem('gitcode.theme', theme)
        localStorage.setItem(
          'gitcode.fonts',
          JSON.stringify({
            ui: { enabled: true, family: 'Inter', fallback: 'Noto Sans SC', size },
          }),
        )
      },
      { theme, size },
    )
    await openFixtureRepository(page)
    const check = async (menu: Locator) => {
      await expect(menu).toBeVisible()
      const m = await measure(menu)
      expect(m.x).toBeGreaterThanOrEqual(0)
      expect(m.y).toBeGreaterThanOrEqual(0)
      expect(m.right).toBeLessThanOrEqual(width)
      expect(m.bottom).toBeLessThanOrEqual(720)
      expect(m.padding).toEqual(['5px', '5px', '5px', '5px'])
      for (const row of m.rows) {
        expect(row.height, row.name).toBe(Math.max(30, size * 1.5 + 10))
        expect(row.top, row.name).toBe('5px')
        expect(row.bottom, row.name).toBe('5px')
        expect(row.offset, row.name).toBeLessThanOrEqual(1)
        expect(row.overflow, row.name).toBe(false)
      }
      return m
    }
    for (const id of ['file', 'edit', 'view', 'repository', 'help']) {
      const trigger = page.locator(`[data-top-menu="${id}"]`)
      await trigger.click()
      const menu = page.locator('.application-dropdown')
      await check(menu)
      const rowCount = await menu.locator(':scope > button').count()
      await expect(menu.locator(':scope > button .menu-check')).toHaveCount(
        id === 'view' ? rowCount : 0,
      )
      const textOffsets = await menu.evaluate((element) => {
        const left = element.getBoundingClientRect().left
        return [...element.querySelectorAll(':scope > button .application-item-label')].map(
          (label) => {
            const node = [...label.childNodes].find(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            )!
            const range = document.createRange()
            range.selectNodeContents(node)
            return range.getBoundingClientRect().left - left
          },
        )
      })
      for (const offset of textOffsets) expect(offset).toBeCloseTo(id === 'view' ? 36 : 16, 0)
      if (theme === 'dark' && size === 13 && width === 1440 && ['file', 'view'].includes(id))
        await page.screenshot({ path: '.tmp/menu-column-' + id + '.png' })
      await trigger.click()
      await expect(page.locator('.application-dropdown')).toHaveCount(0)
    }
    await page.locator('[data-top-menu="file"]').click()
    await page.locator('[data-top-menu="view"]').hover()
    await expect(page.locator('.application-dropdown')).toHaveAccessibleName('视图')
    const themeTrigger = page.locator('[data-submenu-trigger="view.theme"]')
    await themeTrigger.hover()
    await expect(page.locator('.application-submenu')).toBeVisible()
    await page.locator('.application-dropdown > button').first().hover()
    await expect(page.locator('.application-submenu')).toHaveCount(0)
    await themeTrigger.focus()
    await page.keyboard.press('ArrowRight')
    const submenu = page.locator('.application-submenu')
    await check(submenu)
    await expect(submenu.locator(':scope > button .menu-check')).toHaveCount(
      await submenu.locator(':scope > button').count(),
    )
    await page.keyboard.press('End')
    await expect(page.locator('.application-submenu > button').last()).toBeFocused()
    await expect(page.locator('.application-submenu > button').last()).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(themeTrigger).toBeFocused()
    await page.keyboard.press('Escape')
    const branch = page.locator(
      '[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main',
    )
    await branch.click({ button: 'right' })
    const branchMenu = await check(page.getByRole('menu'))
    // Branch menus reserve one aligned column for checkable actions.
    expect(branchMenu.rows[0]!.left).toBe('30px')
    await page.keyboard.press('Escape')
    await expect(branch).toBeFocused()
    await page.keyboard.press('Shift+F10')
    await check(page.getByRole('menu'))
    await page.keyboard.press('Escape')
    await page.locator('.commit-row .commit-select').first().click({ button: 'right' })
    await check(page.getByRole('menu'))
    await page.keyboard.press('End')
    await expect(page.getByRole('menu').locator('button:not(:disabled)').last()).toBeFocused()
    await page.keyboard.press('Escape')
    await page.locator('.repo-tab.active').click({ button: 'right' })
    const tabs = await check(page.getByRole('menu', { name: '标签页操作', exact: true }))
    expect(tabs.rows[0]!.left).toBe('10px')
    await page.mouse.click(width - 20, 650)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.getByLabel('同步选项', { exact: true }).click()
    await check(page.locator('.sync-options-menu'))
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('同步选项', { exact: true })).toBeFocused()
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    const worktree = page.locator('.worktree-menu-content')
    await expect(worktree).toBeVisible()
    await expect(worktree.locator('label')).toHaveCSS('font-size', size + 'px')
    await expect(worktree.locator('label')).toHaveCSS('min-height', '30px')
    await expect(worktree).toHaveCSS('padding', '5px')
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await page.locator('[data-top-menu="view"]').click()
    await page.screenshot({ path: `.tmp/menu-layout-${theme}-${size}.png` })
  })

test('长菜单滚动后关闭脱离锚点的子菜单，排队的滚动事件不误关新子菜单', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 380 })
  await openFixtureRepository(page)
  await page.locator('[data-top-menu="view"]').click()
  const trigger = page.locator('[data-submenu-trigger="view.theme"]')
  await trigger.focus()
  await page.keyboard.press('ArrowRight')
  const menu = page.locator('.application-dropdown'),
    submenu = page.locator('.application-submenu')
  await expect(submenu).toBeVisible()
  await menu.evaluate((el) => el.dispatchEvent(new Event('scroll')))
  await expect(submenu).toBeVisible()
  const moved = await menu.evaluate((el) => {
    const before = el.scrollTop
    el.scrollTop += before > 20 ? -20 : 20
    return Math.abs(el.scrollTop - before)
  })
  expect(moved).toBeGreaterThan(0)
  await expect(submenu).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
