import { expect, test } from '@playwright/test'
import { openFixtureRepository, openRepositoryFallback } from './repository-fixture'
import { createRequire } from 'node:module'
const themePresets = createRequire(import.meta.url)('../../electron/theme-presets.json')
const testedThemes = Object.keys(themePresets).filter((id) => id !== 'dark' && id !== 'light')

for (const id of testedThemes) {
  test(`${id} 配色覆盖工作台、弹窗和按钮且保存后恢复`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openFixtureRepository(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const preset = themePresets[id]
    const preview = settings.getByRole('button', { name: preset.name, exact: true })
    if (await preview.count()) await preview.click()
    else await settings.getByLabel('主题', { exact: true }).selectOption(id)
    await expect(settings.getByLabel('主题', { exact: true })).toHaveValue(id)
    await expect(page.locator('html')).toHaveAttribute('data-palette', id)
    await expect(page.locator('html')).toHaveAttribute('data-theme', preset.mode)
    if (await preview.count()) await expect(preview).toHaveAttribute('aria-pressed', 'true')
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      ),
    ).toBe(preset.tokens['--bg'])
    await settings.getByRole('button', { name: '应用', exact: true }).click()
    expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe(id)
    await page.screenshot({ path: `design/theme-presets/${id}-settings.png` })
    await page.keyboard.press('Escape')
    await page.screenshot({ path: `design/theme-presets/${id}-workbench.png` })
    await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
    const menu = page.getByRole('menu', { name: '视图', exact: true })
    await expect(menu).toBeVisible()
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    )
    await page.keyboard.press('Escape')
    await openRepositoryFallback(page)
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill('/test-fixtures/repository')
    const primary = open.getByRole('button', { name: '打开仓库', exact: true })
    await primary.hover()
    await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)')
    const hover = preset.tokens['--button-primary-hover']
    const rgb = `rgb(${[1, 3, 5].map((offset) => parseInt(hover.slice(offset, offset + 2), 16)).join(', ')})`
    await expect(primary).toHaveCSS('background-color', rgb)
    await openFixtureRepository(page)
    await expect(page.locator('html')).toHaveAttribute('data-palette', id)
    await page.keyboard.press('Control+,')
    await settings.getByLabel('主题', { exact: true }).selectOption('dark')
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--button-primary-bg'),
      ),
    ).toBe('')
    await page.emulateMedia({ colorScheme: 'light' })
    await settings.getByLabel('主题', { exact: true }).selectOption('system')
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dark')
    expect(errors).toEqual([])
  })
}
