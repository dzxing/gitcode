import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

for (const host of ['macOS', 'Windows']) {
  test(`${host} 浏览器连接 Linux/WSL Git 时，快捷键与字体权限始终跟随浏览器`, async ({ page }) => {
    await page.addInitScript((host) => {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: host === 'macOS' ? 'MacIntel' : 'Win32',
      })
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        value: { platform: host },
      })
      Object.defineProperty(window, 'queryLocalFonts', {
        configurable: true,
        value: async () => [{ family: `${host} Renderer Font` }],
      })
    }, host)
    await openFixtureRepository(page, false, repositoryFixture, false, {
      platform: 'linux',
      environment: 'wsl',
      transport: 'local',
      gitAvailable: true,
      gitVersion: 'git version 2.54.0',
      gitPath: '/usr/bin/git',
      gitError: '',
    })
    const command = host === 'macOS' ? 'Meta' : 'Control'
    await page.keyboard.press(command + '+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
    await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
    const picker = settings.getByRole('dialog', { name: '选择界面主字体', exact: true })
    await expect(
      picker.getByRole('option', { name: `${host} Renderer Font`, exact: true }),
    ).toHaveCount(1)
    await page.keyboard.press('Escape')
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '查看快捷键', exact: true }).click()
    const help = page.getByRole('dialog', { name: '快捷键与操作说明', exact: true })
    await expect(help.getByText(host === 'macOS' ? '⌘+O' : 'Ctrl+O', { exact: true })).toBeVisible()
    await expect(page.locator('.app-shell')).not.toHaveClass(/platform-macos/)
    await page.keyboard.press('Escape')
    await page.getByRole('menuitem', { name: '帮助 Help', exact: true }).click()
    await page.getByRole('menuitem', { name: /^关于 GitCode/ }).click()
    const about = page.getByRole('dialog', { name: '关于 GitCode', exact: true })
    await expect(about.getByText('WSL / linux', { exact: true })).toBeVisible()
    await about.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    await expect(
      page.getByRole('main', { name: '新标签页', exact: true }).locator('kbd').first(),
    ).toHaveText(host === 'macOS' ? '⌘+O' : 'Ctrl+O')
  })
}

test('原生窗口平台优先于浏览器标识和 Git 平台，避免出现重复窗口按钮', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    window.gitcodeWindow = {
      platform: 'darwin',
      nativeControls: false,
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      isFullscreen: async () => false,
      isFocused: async () => true,
      onResized: async () => () => {},
      onFocusChanged: async () => () => {},
    }
  })
  await openFixtureRepository(page)
  await expect(page.locator('.app-shell')).toHaveClass(/platform-macos/)
  await expect(page.locator('[aria-label="窗口控制"]')).toHaveCount(0)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await expect(
    page.getByRole('main', { name: '新标签页', exact: true }).locator('kbd').first(),
  ).toHaveText('⌘+O')
})
