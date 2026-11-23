import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('设置与视图共享配置、应用后保存且关闭后恢复焦点', async ({ page }) => {
  await openFixtureRepository(page)
  const input = page.getByRole('textbox', { name: '搜索提交', exact: true })
  await input.focus()
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await settings.getByLabel('标签样式', { exact: true }).selectOption('idea')
  await settings.getByLabel('标签位置', { exact: true }).selectOption('true')
  await settings.getByLabel('展开长连线', { exact: true }).check()
  await settings.getByLabel('淡化合并提交', { exact: true }).uncheck()
  await expect(page.locator('.history-panel')).toHaveAttribute('data-label-style', 'idea')
  await expect(page.locator('.history-panel')).toHaveClass(/labels-after-message/)
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(input).toBeFocused()
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await expect(
    page.getByRole('menuitemcheckbox', { name: '展开长连线', exact: true }),
  ).toBeChecked()
  await expect(
    page.getByRole('menuitemcheckbox', { name: '淡化合并提交', exact: true }),
  ).not.toBeChecked()
  await page.getByRole('menuitem', { name: '分支标签位置', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '关系图左侧', exact: true }).click()
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: /^设置…/ }).click()
  await expect(settings.getByLabel('标签位置', { exact: true })).toHaveValue('false')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  await expect(settings.getByLabel('标签样式', { exact: true })).toHaveValue('idea')
  await expect(settings.getByLabel('标签位置', { exact: true })).toHaveValue('false')
  await expect(settings.getByLabel('展开长连线', { exact: true })).toBeChecked()
  await expect(settings.getByLabel('淡化合并提交', { exact: true })).not.toBeChecked()
  await page.screenshot({ path: 'design/reference-style-comparison/preferences.png' })
})

test('没有打开仓库时也可设置，设置窗口拦截全局操作快捷键', async ({ page }) => {
  await openFixtureRepository(page)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  const tabs = await page.locator('.tab').count()
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await page.keyboard.press('Control+w')
  await expect(settings).toBeVisible()
  expect(await page.locator('.tab').count()).toBe(tabs)
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(settings).toHaveCount(0)
})

test('左侧分类和字体用途分开，主题与字体仅预览，取消同时恢复且不写配置', async ({ page }) => {
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const nav = settings.getByRole('tablist', { name: '设置分类', exact: true })
  await expect(nav).toHaveAttribute('aria-orientation', 'vertical')
  await settings.getByLabel('主题', { exact: true }).selectOption('light')
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  const box = await nav.boundingBox(),
    content = await settings.locator('#settings-fonts-panel').boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(content!.x + 1)
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await expect(settings.getByRole('tabpanel', { name: '界面', exact: true })).toBeHidden()
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByLabel('编辑器字号', { exact: true }).fill('18')
  await expect(settings.getByLabel('编辑器字体预览', { exact: true })).toHaveCSS(
    'font-size',
    '18px',
  )
  expect(
    await page.evaluate(() => [
      localStorage.getItem('gitcode.theme'),
      localStorage.getItem('gitcode.fonts'),
    ]),
  ).toEqual([null, null])
  await page.screenshot({ path: '.tmp/preferences-desktop-preview.png' })
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--code-font-size')),
  ).toBe('')
})

test('应用更新取消基准，之后的预览可撤销，确定保存并关闭', async ({ page }) => {
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByLabel('主题', { exact: true }).selectOption('light')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(settings.getByRole('button', { name: '应用', exact: true })).toBeDisabled()
  await settings.getByLabel('主题', { exact: true }).selectOption('dark')
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('light')
  await page.keyboard.press('Control+,')
  await settings.getByLabel('主题', { exact: true }).selectOption('idea-dark')
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'idea-dark')
})

test('应用失败回滚已保存的主题，保留预览和输入，取消恢复外观', async ({ page }) => {
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByLabel('主题', { exact: true }).selectOption('light')
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  await settings.getByLabel('界面字号', { exact: true }).fill('15')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gitcode.fonts') throw Error('quota')
      original.call(this, key, value)
    }
  })
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('alert')).toContainText('已恢复原有保存值')
  expect(
    await page.evaluate(() => [
      localStorage.getItem('gitcode.theme'),
      localStorage.getItem('gitcode.fonts'),
    ]),
  ).toEqual([null, null])
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('非法字体阻止确定，其他窗口保存的设置不会被覆盖或取消撤回', async ({ page }) => {
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  await settings.getByRole('combobox', { name: '界面主字体', exact: true }).fill('bad; font')
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('alert')).toContainText('有效的字体名称')
  await expect(settings.getByRole('combobox', { name: '界面主字体', exact: true })).toHaveValue(
    'bad; font',
  )
  await settings.getByRole('combobox', { name: '界面主字体', exact: true }).fill('Inter')
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByLabel('主题', { exact: true }).selectOption('light')
  await page.evaluate(() => localStorage.setItem('gitcode.theme', 'github-light'))
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('其他窗口更新')
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'github-light')
})

test('打开设置前保存失败的主题可以重试应用，不会空提交清除警告', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Object.assign(window, {
      restorePreferenceStorage: () => {
        Storage.prototype.setItem = original
      },
    })
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gitcode.theme') throw Error('quota')
      original.call(this, key, value)
    }
  })
  await page.keyboard.press('Alt+v')
  await page.getByRole('menuitem', { name: '主题', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'IDEA 深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'idea-dark')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBeNull()
  await page.evaluate(() =>
    (window as unknown as { restorePreferenceStorage: () => void }).restorePreferenceStorage(),
  )
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('button', { name: '应用', exact: true })).toBeEnabled()
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await expect(settings).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('idea-dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'idea-dark')
})
