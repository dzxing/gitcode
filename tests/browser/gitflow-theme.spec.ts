import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { ThemePalette } from '../../src/themePresets'
import { repositoryFixture } from '../fixtures/repository'
import { openFixtureRepository } from './repository-fixture'
import { measureThemeContrast } from './theme-audit-metrics'
const themePresets: (typeof import('../../src/themePresets'))['themePresets'] = createRequire(
  import.meta.url,
)('../../electron/theme-presets.json')

async function resolvedColor(page: Page, value: string) {
  return page.evaluate((value) => {
    const probe = document.createElement('span')
    probe.style.color = value
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, value)
}
async function tokenColor(page: Page, token: string) {
  return resolvedColor(page, `var(${token})`)
}

for (const [theme, preset] of Object.entries(themePresets)) {
  test(`${theme}: GitFlow surfaces, Islands borders and open dialogs follow theme changes`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: preset.mode as 'dark' | 'light' })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: 'v',
      },
      signature: 'theme-fixture',
      configured: true,
      ready: true,
      finishSupported: true,
      missing: [],
      error: '',
      writeError: '',
    }
    snapshot.stashes = [
      {
        ref: 'stash@{0}',
        oid: 'a'.repeat(40),
        message: 'Theme separator fixture',
        date: new Date().toISOString(),
        branch: 'main',
        base: snapshot.head,
      },
    ]
    await openFixtureRepository(page, false, snapshot)
    await page.getByRole('textbox', { name: '提交说明', exact: true }).focus()
    expect(
      await page.locator('.commit-editor').evaluate((e) => getComputedStyle(e).boxShadow),
    ).toContain(await resolvedColor(page, 'color-mix(in srgb, var(--accent) 2%, transparent)'))
    const separator = await tokenColor(page, '--line-soft')
    for (const selector of ['.commit-row', '.stash-row']) {
      await expect(page.locator(selector).first()).toBeVisible()
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((e) => getComputedStyle(e).boxShadow),
      ).toContain(separator)
    }

    const panel = page.locator('.gitflow-panel')
    const dir = `.tmp/theme-popup-fix/${theme}`
    await mkdir(dir, { recursive: true })
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()

    async function checkPanel(id: string) {
      await expect(panel).toHaveCSS('background-color', await tokenColor(page, '--panel'))
      await expect(panel).toHaveCSS('color', await tokenColor(page, '--text'))
      await expect(panel).toHaveCSS('border-right-color', await tokenColor(page, '--line'))
      await expect(panel).toHaveCSS('border-radius', id.startsWith('islands-') ? '8px' : '0px')
      if (id.startsWith('islands-')) {
        await expect(panel).toHaveCSS('border-top-width', '1px')
        await expect(panel).toHaveCSS('border-left-width', '1px')
        const [bounds, host] = await Promise.all([
          panel.boundingBox(),
          page.locator('.workbench').boundingBox(),
        ])
        expect(bounds!.y - host!.y).toBe(6)
        expect(host!.y + host!.height - bounds!.y - bounds!.height).toBe(6)
      }
      const shadow = await panel.evaluate((element) => getComputedStyle(element).boxShadow)
      expect(shadow).toContain(await tokenColor(page, '--drawer-shadow-color'))
    }
    await checkPanel(theme)
    await panel.screenshot({ path: `${dir}/overview.png`, animations: 'disabled' })
    await panel.getByRole('button', { name: '完成分支…', exact: true }).click()
    const originalFinish = page.getByRole('dialog', { name: '完成功能分支', exact: true })
    await expect(originalFinish).toHaveCSS(
      'background-color',
      await tokenColor(page, '--theme-dialog, #202730'),
    )
    await expect(originalFinish).toHaveCSS('color', await tokenColor(page, '--text'))
    await expect(originalFinish).toHaveCSS(
      'border-color',
      await tokenColor(page, '--theme-border, #3e4c5c'),
    )
    const branchChoice = originalFinish.getByLabel('要完成的 GitFlow 分支', { exact: true })
    await expect(branchChoice).toBeFocused()
    await expect(branchChoice).toHaveCSS('outline-color', await tokenColor(page, '--accent'))
    await expect(branchChoice).toHaveCSS('border-color', await tokenColor(page, '--accent'))
    await originalFinish.screenshot({ path: `${dir}/finish-original.png`, animations: 'disabled' })
    await originalFinish.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()

    await panel.getByRole('button', { name: 'GitFlow 设置', exact: true }).click()
    await checkPanel(theme)
    const input = panel.getByLabel('Feature 前缀', { exact: true })
    await expect(input).toHaveCSS('background-color', await tokenColor(page, '--bg'))
    await input.fill('work/')
    expect(await input.evaluate((e) => getComputedStyle(e).boxShadow)).toContain(
      await resolvedColor(page, 'color-mix(in srgb, var(--accent) 4%, transparent)'),
    )
    await panel.screenshot({ path: `${dir}/settings.png`, animations: 'disabled' })
    const contrast = await measureThemeContrast(page, {
      title: '.gitflow-panel h2',
      label: '.gitflow-rule-row > label',
      input: '.gitflow-rule-control input',
    })
    expect(contrast).toHaveLength(3)
    for (const sample of contrast) expect(sample.ratio, sample.role).toBeGreaterThanOrEqual(4.5)

    // Exercise the actual theme menu while the panel and its unsaved input remain open.
    const next: ThemePalette = preset.mode === 'light' ? 'idea-dark' : 'islands-light'
    await page.locator('[data-top-menu="view"]').click()
    await page.getByRole('menuitem', { name: '主题', exact: true }).click()
    await page.getByRole('menuitemradio', { name: themePresets[next].name, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-palette', next)
    await checkPanel(next)
    await expect(input).toHaveValue('work/')
    await panel.screenshot({ path: `${dir}/switched.png`, animations: 'disabled' })

    await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
    await panel.getByRole('button', { name: '完成分支…', exact: true }).click()
    const finish = page.getByRole('dialog', { name: '完成功能分支', exact: true })
    await expect(finish).toBeVisible()
    await expect(finish).toHaveCSS('color', await tokenColor(page, '--text'))
    await expect(finish).toHaveCSS('border-color', await tokenColor(page, '--theme-border'))
    const shadow = await finish.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(shadow).toContain(await tokenColor(page, '--dialog-shadow-color'))
    await finish.screenshot({ path: `${dir}/finish.png`, animations: 'disabled' })
  })
}

test('Islands GitFlow keeps navigation and close controls reachable in narrow windows', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('gitcode.theme', 'islands-light'))
  await openFixtureRepository(page, true)
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  const panel = page.locator('.gitflow-panel')
  await panel.getByRole('button', { name: 'GitFlow 设置', exact: true }).click()
  for (const width of [1280, 960]) {
    await page.setViewportSize({ width, height: 720 })
    const [bounds, navigation, host] = await Promise.all([
      panel.boundingBox(),
      page.locator('.sidebar').boundingBox(),
      page.locator('.workbench').boundingBox(),
    ])
    expect(bounds!.x).toBeGreaterThanOrEqual(navigation!.x + navigation!.width)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(host!.x + host!.width - 6)
    await expect(
      panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }),
    ).toBeVisible()
    await panel.screenshot({
      path: `.tmp/theme-popup-fix/islands-light/settings-${width}.png`,
      animations: 'disabled',
    })
  }
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})

for (const theme of ['dark', 'light']) {
  test(`${theme}: menus and font pickers use theme shadows`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await openFixtureRepository(page)
    const shadow = await tokenColor(page, '--popup-shadow-color')
    await page.getByLabel('同步选项', { exact: true }).click()
    expect(
      await page.locator('.sync-options-menu').evaluate((e) => getComputedStyle(e).boxShadow),
    ).toContain(shadow)
    await page.keyboard.press('Escape')
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    expect(
      await page.locator('.worktree-menu-content').evaluate((e) => getComputedStyle(e).boxShadow),
    ).toContain(shadow)
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
    await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
    expect(
      await page.locator('.font-picker-popup').evaluate((e) => getComputedStyle(e).boxShadow),
    ).toContain(shadow)
    await page.keyboard.press('Escape')
    await settings.getByRole('button', { name: '取消', exact: true }).click()
  })
}

test('open GitFlow follows system theme and restores theme after cancelling preferences', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => localStorage.setItem('gitcode.theme', 'system'))
  await openFixtureRepository(page, true)
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  const panel = page.locator('.gitflow-panel')
  await panel.getByRole('button', { name: 'GitFlow 设置', exact: true }).click()
  const input = panel.getByLabel('Feature 前缀', { exact: true })
  await input.fill('work/')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'light')
  await expect(panel).toHaveCSS('background-color', await tokenColor(page, '--panel'))
  expect(await panel.evaluate((e) => getComputedStyle(e).boxShadow)).toContain(
    await tokenColor(page, '--drawer-shadow-color'),
  )
  await page.locator('[data-top-menu="file"]').focus()
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByLabel('主题', { exact: true }).selectOption('islands-dark')
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'islands-dark')
  await expect(panel).toHaveCSS('border-radius', '8px')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'light')
  await expect(panel).toHaveCSS('border-radius', '0px')
  await expect(input).toHaveValue('work/')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'dark')
  await expect(panel).toHaveCSS('background-color', await tokenColor(page, '--panel'))
  await expect(input).toHaveValue('work/')
})
