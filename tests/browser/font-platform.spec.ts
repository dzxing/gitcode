import { expect, test, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

async function platform(page: Page, browser: string, desktop?: string) {
  await page.addInitScript(
    ({ browser, desktop }) => {
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        value: { platform: browser },
      })
      Object.defineProperty(navigator, 'platform', { configurable: true, value: browser })
      Object.defineProperty(window, 'queryLocalFonts', {
        configurable: true,
        value: () => {
          throw Error('Default fonts must not request font enumeration')
        },
      })
      if (desktop)
        window.gitkWindow = {
          platform: desktop,
          minimize: async () => {},
          toggleMaximize: async () => {},
          close: async () => {},
          isMaximized: async () => false,
          isFullscreen: async () => false,
          isFocused: async () => true,
          onResized: async () => () => {},
          onFocusChanged: async () => () => {},
        }
    },
    { browser, desktop },
  )
}

for (const scenario of [
  { browser: 'Windows', fallback: 'Microsoft YaHei' },
  { browser: 'MacIntel', fallback: 'PingFang SC' },
  { browser: 'Linux', fallback: 'Noto Sans SC' },
  { browser: 'Unknown', fallback: 'Noto Sans SC' },
  { browser: 'Windows', desktop: 'darwin', fallback: 'PingFang SC' },
  { browser: 'MacIntel', desktop: 'win32', fallback: 'Microsoft YaHei' },
]) {
  test(`${scenario.desktop || scenario.browser}: 默认、预览、重置一致，字体不取决于 Git 服务系统`, async ({
    page,
  }) => {
    await platform(page, scenario.browser, scenario.desktop)
    await openFixtureRepository(page)
    const root = page.locator('html')
    const original = await root.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(original).toContain(`"Cascadia Mono", "${scenario.fallback}"`)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    const fallback = settings.getByRole('combobox', { name: '界面后备字体', exact: true })
    await expect(fallback).toHaveValue(scenario.fallback)
    await expect(settings.getByLabel('界面字体预览', { exact: true })).toHaveCSS(
      'font-family',
      original,
    )
    await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
    await expect(root).toHaveCSS('font-family', original)
    await settings.getByRole('combobox', { name: '界面主字体', exact: true }).fill('Inter')
    await settings.getByLabel('界面字号', { exact: true }).click()
    await expect(root).toHaveCSS('font-family', /Inter/)
    await settings.getByRole('button', { name: '恢复界面字体默认值', exact: true }).click()
    await expect(fallback).toHaveValue(scenario.fallback)
    await expect(root).toHaveCSS('font-family', original)
    await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
    await expect(
      settings.getByRole('combobox', { name: '编辑器后备字体', exact: true }),
    ).toHaveValue(scenario.fallback)
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    expect(await page.evaluate(() => localStorage.getItem('gitcode.fonts'))).toBeNull()
  })
}

test('macOS 保留已有 Windows 个人字体；系统字体缺失时实际使用内置中文字体', async ({ page }) => {
  await platform(page, 'MacIntel')
  const saved = {
    ui: { enabled: true, family: 'MissingFont-20261111', fallback: 'Microsoft YaHei', size: 14 },
    code: {
      enabled: true,
      family: 'MissingCodeFont-20261111',
      fallback: 'Microsoft YaHei',
      size: 15,
      lineHeight: 1.75,
      ligatures: false,
    },
  }
  await page.addInitScript(
    (value) => localStorage.setItem('gitcode.fonts', JSON.stringify(value)),
    saved,
  )
  await openFixtureRepository(page)
  const family = await page.locator('html').evaluate((el) => getComputedStyle(el).fontFamily)
  expect(family).toContain('MissingFont-20261111, "Microsoft YaHei", "PingFang SC", "Noto Sans SC"')
  await page.evaluate(() => document.fonts.load('14px "Noto Sans SC"', '文件'))
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-top-menu="file"]',
  })
  await page.screenshot({ path: '.tmp/font-platform-fallback.png' })
  const actual = await session.send('CSS.getPlatformFontsForNode', { nodeId })
  expect(
    actual.fonts.some(
      (font) => /^NotoSansSC(?:-|$)/.test(font.postScriptName) && font.isCustomFont,
    ),
  ).toBe(true)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await expect(settings.getByRole('combobox', { name: '界面后备字体', exact: true })).toHaveValue(
    'Microsoft YaHei',
  )
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!))).toEqual(
    saved,
  )
})
