import { expect, test, type Page, type Locator } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { bundledFonts, commonSystemFonts } from '../../src/features/preferences/fontPreferences'
import fontCatalog from '../../src/features/preferences/fontCatalog.json' with { type: 'json' }

async function readSystemFonts(dialog: Locator) {
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  const expand = dialog.getByRole('button', { name: '展开界面主字体列表', exact: true })
  await expand.click()
  const popup = dialog.getByRole('dialog', { name: '选择界面主字体', exact: true })
  if (await popup.isVisible())
    await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).press('Escape')
}

async function fonts(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () =>
        Array.from({ length: 217 }, (_, i) => ({ family: `Family ${String(i).padStart(3, '0')}` })),
    })
  })
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await readSystemFonts(settings)
  return settings
}
test('读取 217 个字体后可直接展开完整列表，搜索不改变设置，点击选择生效且重新展开仍显示全部', async ({
  page,
}) => {
  const settings = await fonts(page)
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  const input = settings.getByRole('combobox', { name: '界面主字体', exact: true })
  await expect(input).toHaveValue('Cascadia Mono')
  await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
  const popup = settings.getByRole('dialog', { name: '选择界面主字体', exact: true })
  await expect(popup.getByRole('option')).toHaveCount(
    217 + bundledFonts.length + commonSystemFonts.length,
  )
  await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).fill('216')
  await expect(popup.getByRole('option')).toHaveCount(1)
  await expect(input).toHaveValue('Cascadia Mono')
  await popup.getByRole('option', { name: 'Family 216', exact: true }).click()
  await expect(input).toHaveValue('Family 216')
  await expect(popup).toBeHidden()
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!).ui.family),
  ).toBe('Family 216')
  await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
  await expect(popup.getByRole('option')).toHaveCount(
    217 + bundledFonts.length + commonSystemFonts.length,
  )
  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await expect(settings).toBeVisible()
  await expect(settings.locator('.font-intro, .font-list-action')).toHaveCount(0)
  await page.screenshot({ path: '.tmp/font-settings-clean.png' })
})
test('编辑器字体未启用时解释禁用原因；窄窗底部的列表可点击且支持键盘选择', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 600 })
  const settings = await fonts(page)
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await expect(
    settings.getByRole('button', { name: '展开编辑器后备字体列表', exact: true }),
  ).toBeDisabled()
  await expect(
    settings.getByText('勾选“使用自定义编辑器字体”后，可选择字体并调整字号。', { exact: true }),
  ).toBeVisible()
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByRole('button', { name: '展开编辑器后备字体列表', exact: true }).click()
  const popup = settings.getByRole('dialog', { name: '选择编辑器后备字体', exact: true })
  const search = popup.getByRole('combobox', { name: '搜索编辑器后备字体', exact: true })
  await search.fill('Family 215')
  const option = popup.getByRole('option', { name: 'Family 215', exact: true })
  await expect(option).toBeInViewport()
  expect(
    await option.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit === el || el.contains(hit)
    }),
  ).toBe(true)
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(settings.getByRole('combobox', { name: '编辑器后备字体', exact: true })).toHaveValue(
    'Family 215',
  )
  await expect(popup).toBeHidden()
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
})

test('内置字体不依赖系统字体授权或外部网络，所有常规体与斜体均可解码', async ({ page }) => {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' ? route.continue() : route.abort()
  })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => {
        throw new Error('This test must not read local fonts')
      },
    })
  })
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByRole('button', { name: '展开编辑器主字体列表', exact: true }).click()
  const popup = settings.getByRole('dialog', { name: '选择编辑器主字体', exact: true })
  await expect(popup.getByRole('option')).toHaveCount(
    bundledFonts.length + commonSystemFonts.length,
  )
  await expect(popup.getByText('内置', { exact: true })).toHaveCount(bundledFonts.length)
  await popup.getByRole('option', { name: 'JetBrains Mono', exact: true }).click()
  await expect(settings.getByRole('combobox', { name: '编辑器主字体', exact: true })).toHaveValue(
    'JetBrains Mono',
  )
  const loaded = await page.evaluate(async (catalog) => {
    return Promise.all(
      catalog.map(async ({ family, style }) => {
        const faces = await document.fonts.load(`${style} 400 13px "${family}"`, 'GitCode')
        return {
          family,
          style,
          count: faces.length,
          loaded: faces.every((face) => face.status === 'loaded'),
        }
      }),
    )
  }, fontCatalog)
  expect(loaded).toHaveLength(fontCatalog.length)
  for (const face of loaded) {
    expect(face.count, `${face.family} ${face.style}`).toBeGreaterThan(0)
    expect(face.loaded, `${face.family} ${face.style}`).toBe(true)
  }
})

test('打开前排队的滚动事件不误关字体列表，实际滚动锚点后关闭', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 600 })
  const settings = await fonts(page)
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByRole('button', { name: '展开编辑器主字体列表', exact: true }).click()
  const popup = settings.getByRole('dialog', { name: '选择编辑器主字体', exact: true })
  const panel = settings.locator('#settings-fonts-panel')
  await expect(popup).toBeVisible()
  await panel.evaluate((el) => el.dispatchEvent(new Event('scroll', { bubbles: true })))
  await expect(popup).toBeVisible()
  const moved = await panel.evaluate((el) => {
    const before = el.scrollTop
    el.scrollTop += before > 24 ? -24 : 24
    return Math.abs(el.scrollTop - before)
  })
  expect(moved).toBeGreaterThan(0)
  await expect(popup).toBeHidden()
})

test('Windows 未读取系统字体也能中文搜索微软雅黑，标注系统来源，读取别名后不重复', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { platform: 'Windows' },
    })
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => [{ family: '微软雅黑' }, { family: 'Microsoft YaHei' }],
    })
  })
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  const open = () =>
    settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
  const popup = settings.getByRole('dialog', { name: '选择界面主字体', exact: true })
  await open()
  await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).fill('微软雅黑')
  const yahei = popup.getByRole('option', { name: '微软雅黑 · Microsoft YaHei', exact: true })
  await expect(popup.getByRole('option')).toHaveCount(1)
  await expect(yahei.getByText('系统', { exact: true })).toBeVisible()
  await expect(yahei.getByText('内置', { exact: true })).toHaveCount(0)
  await yahei.click()
  await expect(settings.getByRole('combobox', { name: '界面主字体', exact: true })).toHaveValue(
    'Microsoft YaHei',
  )
  expect(await page.evaluate(() => localStorage.getItem('gitcode.fonts'))).toBeNull()
  await readSystemFonts(settings)
  await open()
  await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).fill('yahei')
  await expect(popup.getByRole('option')).toHaveCount(1)
  await expect(yahei).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!).ui.family),
  ).toBe('Microsoft YaHei')
})

test('常用系统字体未检测到时仍提示回退，不把推荐候选当作已安装', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => [{ family: 'Inter' }],
    }),
  )
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  await settings.getByRole('combobox', { name: '界面主字体', exact: true }).fill('Microsoft YaHei')
  await readSystemFonts(settings)
  await expect(settings.getByText(/读取的字体列表中未包含所选主字体/)).toBeVisible()
})
