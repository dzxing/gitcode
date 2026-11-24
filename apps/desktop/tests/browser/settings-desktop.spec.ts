import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import type { GitRuntimeSettings } from '../../src/types'
import { createRequire } from 'node:module'

const themePresets = createRequire(import.meta.url)('../../electron/theme-presets.json')

for (const theme of Object.keys(themePresets))
  for (const size of [13, 16])
    test(`${theme} UI ${size}: 设置控件比例、焦点与小窗布局`, async ({ page }) => {
      await page.setViewportSize({ width: size === 16 ? 760 : 1440, height: 720 })
      await page.addInitScript(
        ({ theme, size }) => {
          localStorage.setItem('gitcode.theme', theme)
          localStorage.setItem(
            'gitcode.fonts',
            JSON.stringify({
              ui: { enabled: true, family: 'Cascadia Mono', fallback: 'Noto Sans SC', size },
            }),
          )
        },
        { theme, size },
      )
      await openFixtureRepository(page)
      await page.evaluate(() => {
        window.gitcode!.gitSettings = async () => ({
          selection: { mode: 'auto' },
          runtime: {
            platform: 'windows',
            gitAvailable: true,
            gitVersion: 'git version 2.53.0',
            gitPath: 'fixture',
            gitError: '',
          },
        })
      })
      await page.keyboard.press('Control+,')
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await dialog.getByRole('tab', { name: '字体', exact: true }).click()
      const number = dialog.getByLabel('界面字号', { exact: true })
      const picker = dialog.getByRole('combobox', { name: '界面主字体', exact: true })
      const metrics = await dialog.evaluate((el) => {
        const header = el.querySelector('.preferences-header')!.getBoundingClientRect()
        const nav = el.querySelector('.preferences-tabs button')!.getBoundingClientRect()
        const number = el.querySelector('.font-group input[type=number]')!.getBoundingClientRect()
        const family = el.querySelector('.font-picker-control')!.getBoundingClientRect()
        const help = el.querySelector('.font-group .font-hint')!.getBoundingClientRect()
        const preview = el.querySelector('.font-preview')!.getBoundingClientRect()
        const footer = el.querySelector('footer')!.getBoundingClientRect()
        return {
          header: header.height,
          nav: nav.height,
          number: number.width,
          family: family.width,
          gap: preview.top - help.bottom,
          footer: footer.bottom,
          viewport: innerHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
      expect(metrics.header).toBeLessThanOrEqual(48)
      expect(metrics.nav).toBeLessThanOrEqual(34)
      expect(metrics.number).toBe(80)
      expect(metrics.family).toBeLessThanOrEqual(320)
      expect(metrics.gap).toBeLessThanOrEqual(36)
      expect(metrics.footer).toBeLessThanOrEqual(metrics.viewport)
      expect(metrics.overflow).toBe(false)
      await expect(number).toBeInViewport()
      await expect(picker).toBeInViewport()
      await dialog.getByRole('tab', { name: 'Git', exact: true }).click()
      const runtime = dialog.getByRole('region', { name: 'Git 运行环境', exact: true })
      await runtime.getByLabel('自定义 Git', { exact: true }).check()
      const path = runtime.getByLabel('Git 可执行文件路径', { exact: true })
      await path.focus()
      await expect(path).toHaveCSS('outline-style', 'solid')
      await expect(path).toHaveCSS('border-top-width', '1px')
      expect((await path.boundingBox())!.height).toBeGreaterThanOrEqual(28)
      await expect(page.locator('dialog[open]')).toHaveCount(1)
      await dialog.screenshot({ path: `.tmp/settings-desktop-${theme}-${size}.png` })
    })

test('默认确认键、输入法与字体列表按键隔离；取消恢复预览', async ({ page }) => {
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  const size = dialog.getByLabel('界面字号', { exact: true })
  await size.fill('14')
  await size.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(dialog).toBeVisible()
  await size.press('Enter')
  await expect(dialog).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!).ui.size),
  ).toBe(14)
  await page.keyboard.press('Control+,')
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await size.fill('16')
  await dialog.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
  const popup = dialog.getByRole('dialog', { name: '选择界面主字体', exact: true })
  await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).press('Enter')
  await expect(popup).toBeHidden()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    '14px',
  )
  await page.keyboard.press('Control+,')
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await size.fill('15')
  await size.press('Control+Enter')
  await expect(dialog).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!).ui.size),
  ).toBe(15)
})

test('Git 草稿可取消；部分保存失败明确报告，修正后从默认确认入口保存', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.gitSettings = async (selection) => {
      if (selection) {
        document.documentElement.dataset.gitWrite = JSON.stringify(selection)
        if (selection.path === 'invalid') throw new Error('请选择 Git 可执行文件的绝对路径。')
      }
      return {
        selection: selection || { mode: 'auto' },
        restartRequired: !!selection,
        runtime: {
          platform: 'windows',
          gitAvailable: true,
          gitVersion: 'git version 2.53.0',
          gitPath: 'fixture',
          gitError: '',
        },
      }
    }
  })
  const open = async () => {
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: 'Git', exact: true }).click()
    await settings.getByLabel('自定义 Git', { exact: true }).check()
    return settings
  }
  let settings = await open()
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).fill('discarded')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.locator('html').getAttribute('data-git-write')).toBeNull()
  settings = await open()
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).fill('invalid')
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByLabel('主题', { exact: true }).selectOption('idea-dark')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(settings.locator('.preferences-feedback')).toContainText(
    '已应用的外观和字体设置会保留',
  )
  await expect(settings.getByRole('tab', { name: 'Git', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(settings.getByLabel('Git 可执行文件路径', { exact: true })).toHaveValue('invalid')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.theme'))).toBe('idea-dark')
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).fill('/fixture/git')
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).press('Control+Enter')
  await expect(settings).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.gitWrite!))).toEqual(
    { mode: 'custom', path: '/fixture/git' },
  )
})

test('macOS 设置按钮按视觉顺序和 Tab 顺序排列', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { platform: 'macOS' },
    }),
  )
  await openFixtureRepository(page)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.locator('footer button')).toHaveText(['取消', '应用', '确定'])
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
  await settings.getByRole('button', { name: '取消', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(settings.getByRole('button', { name: '应用', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(settings.getByRole('button', { name: '确定', exact: true })).toBeFocused()
})

test('Git 保存期间阻止重复提交和退出，完成后关闭并保留重启配置', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.gitSettings = async (selection) => {
      const value = {
        selection: selection || { mode: 'auto' as const },
        restartRequired: !!selection,
        runtime: {
          platform: 'windows',
          gitAvailable: true,
          gitVersion: 'git version 2.53.0',
          gitPath: 'fixture',
          gitError: '',
        },
      }
      if (!selection) return value
      document.documentElement.dataset.gitSaveCalls = String(
        Number(document.documentElement.dataset.gitSaveCalls || 0) + 1,
      )
      return new Promise<GitRuntimeSettings>((resolve) =>
        window.addEventListener('finish-git-save', () => resolve(value), { once: true }),
      )
    }
  })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: 'Git', exact: true }).click()
  await settings.getByLabel('自定义 Git', { exact: true }).check()
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).fill('/fixture/git')
  await settings.getByLabel('Git 可执行文件路径', { exact: true }).press('Control+Enter')
  await expect(settings).toHaveAttribute('aria-busy', 'true')
  await expect(settings.getByRole('button', { name: '确定', exact: true })).toBeDisabled()
  await expect(settings.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Enter')
  await expect(settings).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-git-save-calls', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('finish-git-save')))
  await expect(settings).toHaveCount(0)
})

test('仓库操作表单的 Enter 不触发外层设置确认，隐藏滚动条仍提示下方内容', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 600 })
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.fetchSettingsRead = async (path) => ({
      path,
      shallow: true,
      signature: 'settings-read',
      remotes: [
        {
          name: 'origin',
          mode: 'all',
          branches: [],
          mappings: [],
          editable: true,
          skipped: false,
          reason: '',
        },
      ],
    })
  })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '当前仓库', exact: true }).click()
  await settings.getByLabel('分支获取范围', { exact: true }).selectOption('selected')
  const branches = settings.getByLabel('指定获取分支', { exact: true })
  await branches.fill('main')
  await branches.press('Enter')
  await expect(settings).toBeVisible()
  await expect(branches).toHaveValue('main\n')
  await branches.press('Control+Enter')
  await expect(settings).toBeVisible()
  await expect(settings.locator('.preferences-body')).toHaveClass(/has-more-below/)
  await settings
    .locator('#settings-repository-panel')
    .evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(settings.locator('.preferences-body')).not.toHaveClass(/has-more-below/)
})
