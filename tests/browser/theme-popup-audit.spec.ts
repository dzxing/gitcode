import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { openFixtureRepository } from './repository-fixture'
import { measureThemeContrast } from './theme-audit-metrics'
const presets = createRequire(import.meta.url)('../../electron/theme-presets.json')
const states = [
  ...Object.entries(presets).map(([id, preset]) => ({
    id,
    theme: id,
    mode: (preset as { mode: 'dark' | 'light' }).mode,
  })),
  ...(['dark', 'light'] as const).map((mode) => ({ id: 'system-' + mode, theme: 'system', mode })),
]
for (const { id, theme, mode } of states)
  test(`${id}: 小组件选中态与悬停态颜色审查`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await openFixtureRepository(page)
    const dir = '.tmp/ui-theme-audit/' + id,
      report = JSON.parse(await readFile(dir + '/metrics.json', 'utf8'))
    await page.getByLabel('同步选项', { exact: true }).click()
    report.moduleColors['sync-options'] = await measureThemeContrast(page, {
      item: '.sync-options-menu button',
    })
    const syncItem = page.locator('.sync-options-menu button').first()
    await syncItem.hover()
    const hoverBackground = await syncItem.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = 'var(--view-selection-hover-bg)'
      el.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    })
    await expect(syncItem).toHaveCSS('background-color', hoverBackground)
    report.moduleColors['sync-options-hover'] = await measureThemeContrast(page, {
      item: '.sync-options-menu button',
    })
    await page
      .locator('.sync-options-menu')
      .screenshot({ path: dir + '/sync-options.png', animations: 'disabled' })
    await page.keyboard.press('Tab')
    await expect(syncItem).toBeFocused()
    await page.mouse.move(0, 0)
    await expect(syncItem).toHaveCSS('background-color', hoverBackground)
    await page.keyboard.press('Escape')
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    report.moduleColors['worktree-options'] = await measureThemeContrast(page, {
      title: '.worktree-menu-content strong',
      label: '.worktree-menu-content label',
      density: '.worktree-menu-content .file-view-toggle button',
    })
    const compression = page.locator('.worktree-menu-content label')
    await expect(compression.locator('input')).toBeDisabled()
    await compression.hover()
    await expect(compression).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page
      .locator('.worktree-menu-content')
      .screenshot({ path: dir + '/worktree-options.png', animations: 'disabled' })
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await page.getByRole('button', { name: '目录视图', exact: true }).click()
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await expect(compression.locator('input')).toBeEnabled()
    await compression.hover()
    expect(await compression.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    )
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    report.interactionChecks = {
      syncPointer: true,
      syncKeyboard: true,
      disabledCompressionDoesNotHighlight: true,
      enabledCompressionHighlights: true,
    }
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
    await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
    await page
      .locator('.font-picker-popup')
      .screenshot({ path: dir + '/font-picker.png', animations: 'disabled' })
    report.moduleColors['font-picker'] = await measureThemeContrast(page, {
      selected: '.font-picker-options button[aria-selected="true"] .font-picker-name',
      source: '.font-picker-options button[aria-selected="true"] small',
      search: '.font-picker-popup input',
    })
    await writeFile(dir + '/metrics.json', JSON.stringify(report, null, 2))
    for (const [module, samples] of Object.entries(report.moduleColors) as [
      string,
      Awaited<ReturnType<typeof measureThemeContrast>>,
    ][]) {
      for (const c of samples)
        if (!c.disabled) expect.soft(c.ratio, module + ': ' + c.role).toBeGreaterThanOrEqual(4.5)
    }
  })
