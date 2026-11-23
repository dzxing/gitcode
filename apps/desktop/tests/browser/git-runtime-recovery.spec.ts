import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('macOS Git 检测失败显示准确说明与折叠详情，允许选择自定义 Git 并保留失败后的输入', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.gitSettings = async (value) => {
      if (value)
        throw new Error(
          "Error invoking remote method 'gitk:git-settings': Error: Git 检测失败。\n/usr/bin/git: xcrun: invalid active developer path",
        )
      return {
        selection: { mode: 'auto' },
        runtime: {
          platform: 'macos',
          gitAvailable: false,
          gitVersion: '',
          gitPath: '',
          gitError: '未能检测到可运行的 Git。\n/usr/bin/git: xcrun: invalid active developer path',
        },
      }
    }
  })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: 'Git', exact: true }).click()
  const dialog = settings.getByRole('region', { name: 'Git 运行环境', exact: true })
  await expect(dialog.getByText('自动查找 Git', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/自动检查 Homebrew、MacPorts/)).toBeVisible()
  await expect(dialog.getByText(/Windows 安装包自带完整 Git/)).toHaveCount(0)
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '')
  await dialog.getByLabel('自定义 Git', { exact: true }).check()
  const path = dialog.getByLabel('Git 可执行文件路径', { exact: true })
  await path.fill('/Library/Developer/CommandLineTools/usr/bin/git')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Git 检测失败。')
  await expect(path).toHaveValue('/Library/Developer/CommandLineTools/usr/bin/git')
  await dialog.getByText('查看检测详情', { exact: true }).click()
  await expect(dialog.locator('details pre')).toContainText('xcrun: invalid active developer path')
})

test('Git 安装后可以重新检测，成功结果同步至应用并保留未保存的自定义路径', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.gitSettings = async () => ({
      selection: { mode: 'auto' },
      runtime: {
        platform: 'macos',
        gitAvailable: false,
        gitVersion: '',
        gitPath: '',
        gitError: 'Git 未找到。\n/usr/bin/git: xcrun: tools unavailable',
      },
    })
    window.gitk!.refreshGitRuntime = async () => ({
      selection: { mode: 'auto' },
      runtime: {
        platform: 'macos',
        gitAvailable: true,
        gitVersion: 'git version 2.54.0 (Apple Git-157)',
        gitPath: '/Library/Developer/CommandLineTools/usr/bin/git',
        gitSource: 'system',
        gitError: '',
      },
    })
  })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: 'Git', exact: true }).click()
  const dialog = settings.getByRole('region', { name: 'Git 运行环境', exact: true })
  await dialog.getByLabel('自定义 Git', { exact: true }).check()
  await dialog.getByLabel('Git 可执行文件路径', { exact: true }).fill('/opt/custom/git')
  await dialog.getByRole('button', { name: '重新检测 Git', exact: true }).click()
  await expect(
    dialog.getByText('git version 2.54.0 (Apple Git-157)', { exact: true }),
  ).toBeVisible()
  await expect(dialog.getByLabel('Git 可执行文件路径', { exact: true })).toHaveValue(
    '/opt/custom/git',
  )
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '重新检测 Git', exact: true })).toHaveCount(0)
})
