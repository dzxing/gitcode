import { expect, test } from '@playwright/test'
import { openFixtureRepository, openRepositoryFallback } from './repository-fixture'

test('视图主题子菜单直接切换、保持单选并与设置及系统状态同步', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openFixtureRepository(page)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  async function themes() {
    await page.keyboard.press('Alt+v')
    await page.getByRole('menuitem', { name: '主题', exact: true }).click()
    return page.getByRole('menu', { name: '主题', exact: true })
  }
  let menu = await themes()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(12)
  await menu.getByRole('menuitemradio', { name: 'IDEA 深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'idea-dark')
  await page.reload()
  menu = await themes()
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
  await expect(menu.getByRole('menuitemradio', { name: 'IDEA 深色', exact: true })).toBeChecked()
  await menu.getByRole('menuitemradio', { name: '跟随系统', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'dark')
  menu = await themes()
  await expect(menu.getByRole('menuitemradio', { name: '跟随系统', exact: true })).toBeChecked()
  await expect(
    menu.getByRole('menuitemradio', { name: 'GitCode 深色', exact: true }),
  ).not.toBeChecked()
  await page.screenshot({ path: 'design/theme-presets/theme-menu.png' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+,')
  await expect(
    page.getByRole('dialog', { name: '设置', exact: true }).getByLabel('主题', { exact: true }),
  ).toHaveValue('system')
})

async function settings(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('浅色主题覆盖工作台、菜单与弹窗并在刷新后恢复', async ({ page }) => {
  await openFixtureRepository(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const dialog = await settings(page)
  await dialog.getByLabel('主题', { exact: true }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
  await expect(dialog).toHaveCSS('background-color', 'rgb(238, 241, 245)')
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  await page.screenshot({ path: 'design/themes/light-settings.png' })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'design/themes/light-workbench.png' })
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await expect(page.getByRole('menu', { name: '视图', exact: true })).toHaveCSS(
    'background-color',
    'rgb(238, 241, 245)',
  )
  await page.screenshot({ path: 'design/themes/light-menu.png' })
  await page.keyboard.press('Escape')
  await openRepositoryFallback(page)
  const openDialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await openDialog.getByLabel('仓库路径', { exact: true }).fill('/test-fixtures/repository')
  const primary = openDialog.getByRole('button', { name: '打开仓库', exact: true })
  await primary.hover()
  await expect(primary).toHaveCSS('background-color', 'rgb(0, 103, 124)')
  await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)')
  await page.keyboard.press('Escape')
  await openFixtureRepository(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const reopened = await settings(page)
  await expect(reopened.getByLabel('主题', { exact: true })).toHaveValue('light')
  await reopened.getByLabel('主题', { exact: true }).selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(reopened).toHaveCSS('background-color', 'rgb(46, 50, 58)')
  expect(errors).toEqual([])
})

test('跟随系统实时响应，手动主题不受系统切换影响', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openFixtureRepository(page)
  const dialog = await settings(page)
  await dialog.getByLabel('主题', { exact: true }).selectOption('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('system')
  await dialog.getByLabel('主题', { exact: true }).selectOption('light')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect((await settings(page)).getByLabel('主题', { exact: true })).toHaveValue('light')
})

test('无效主题安全回退，保存失败仍可切换并提示', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gitcode.theme', 'invalid'))
  await openFixtureRepository(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const dialog = await settings(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gitcode.theme') throw new DOMException('Full', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  await dialog.getByLabel('主题', { exact: true }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法保存设置')
})

test('主题选择与系统变化同步发布给桌面原生菜单', async ({ page }) => {
  await page.addInitScript(() => {
    window.gitcodeApp = {
      setMenuState: async (state) => {
        Object.assign(window, { appearanceMenuState: state })
      },
      edit: async () => {},
      requestQuit: async () => {},
      acknowledgeClose: async () => true,
      approveClose: async () => true,
      cancelClose: async () => {},
      info: async () => ({ name: 'GitCode', version: '1.0.1', electron: '45', platform: 'win32' }),
      onCommand: () => () => {},
      onCloseRequested: () => () => {},
    }
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await openFixtureRepository(page)
  const dialog = await settings(page)
  await dialog.getByLabel('主题', { exact: true }).selectOption('system')
  const nativeTheme = () =>
    page.evaluate(() => {
      const state = (
        window as unknown as { appearanceMenuState: { theme: string; resolvedTheme: string } }
      ).appearanceMenuState
      return [state.theme, state.resolvedTheme]
    })
  await expect.poll(nativeTheme).toEqual(['system', 'light'])
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(nativeTheme).toEqual(['system', 'dark'])
  for (const palette of ['vscode-dark', 'idea-dark', 'github-light']) {
    await dialog.getByLabel('主题', { exact: true }).selectOption(palette)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { appearanceMenuState: { palette: string } }).appearanceMenuState
              .palette,
        ),
      )
      .toBe(palette)
    await expect
      .poll(nativeTheme)
      .toEqual(palette === 'github-light' ? ['light', 'light'] : ['dark', 'dark'])
  }
})
