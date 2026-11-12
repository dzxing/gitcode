import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('Git runtime settings show source, validate custom Git and save for the next launch', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    const runtime = {
      platform: 'windows',
      gitAvailable: true,
      gitVersion: 'git version 2.56.0.windows.4',
      gitPath: 'C:\\GitCode\\resources\\git\\cmd\\git.exe',
      gitSource: 'bundled',
      gitError: '',
    }
    window.gitk!.gitSettings = async (selection) => {
      if (selection?.mode === 'custom' && selection.path === 'invalid')
        throw new Error('请选择 Git 可执行文件的绝对路径。')
      return { runtime, selection: selection || { mode: 'auto' }, restartRequired: !!selection }
    }
    window.gitk!.chooseGit = async () => 'C:\\Tools\\Git\\cmd\\git.exe'
  })
  await page.reload()
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: /^设置…/ }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).focus()
  await page.keyboard.press('End')
  await expect(settings.getByRole('tab', { name: 'Git', exact: true })).toBeFocused()
  const dialog = settings.getByRole('region', { name: 'Git 运行环境', exact: true })
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(dialog).toContainText('应用内置')
  await expect(dialog).toContainText('git version 2.56.0.windows.4')
  await dialog.getByRole('radio', { name: '自定义 Git', exact: true }).check()
  await dialog.getByRole('textbox', { name: 'Git 可执行文件路径' }).fill('invalid')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('绝对路径')
  await dialog.getByRole('button', { name: '浏览…' }).click()
  await expect(dialog.getByRole('textbox', { name: 'Git 可执行文件路径' })).toHaveValue(
    'C:\\Tools\\Git\\cmd\\git.exe',
  )
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('重新打开 GitCode')
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
})

test('启动缺少 Git 时错误页可以直接打开 Git 设置', async ({ page }) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    const original = window.gitk!.runtime
    window.gitk!.runtime = async () => ({
      ...(await original()),
      gitAvailable: false,
      gitError: '未找到可用 Git',
    })
    window.gitk!.gitSettings = async () => ({
      runtime: await window.gitk!.runtime(),
      selection: { mode: 'auto' },
      restartRequired: false,
    })
  })
  await page.reload()
  const startup = page.getByRole('region', { name: '应用启动状态', exact: true })
  await expect(startup).toContainText('未找到可用 Git')
  await startup.getByRole('button', { name: '配置 Git', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('tab', { name: 'Git', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(settings.getByRole('alert')).toHaveText('未找到可用 Git')
  await expect(settings.getByRole('region', { name: 'Git 运行环境', exact: true })).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
})
