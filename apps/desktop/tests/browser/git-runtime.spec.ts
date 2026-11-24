import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('browser Git settings use the real local core without an Electron bridge', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  expect(await page.evaluate(() => !!window.gitcode)).toBe(false)
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: /^设置…/ }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: 'Git', exact: true }).click()
  const region = dialog.getByRole('region', { name: 'Git 运行环境', exact: true })
  await expect(region.locator('.git-runtime-details')).toContainText('git version')
  await region.getByRole('radio', { name: '自定义 Git', exact: true }).check()
  await region
    .getByRole('textbox', { name: 'Git 可执行文件路径', exact: true })
    .fill('/tmp/gitcode-browser-test-missing-git')
  const validation = page.waitForResponse(
    (response) =>
      response.url().endsWith('/__gitcode/rpc') &&
      response.request().postDataJSON()?.method === 'git-settings' &&
      response.request().postDataJSON()?.args?.[0]?.mode === 'custom',
  )
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  expect((await validation).status()).toBe(400)
  await expect(region.getByRole('alert')).toContainText('未能检测到可运行的 Git')
  await region.getByRole('radio', { name: '自动查找 Git', exact: true }).check()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('#operation-status')).toContainText('git version')
})

test('Git runtime settings show installed source, validate custom Git and apply immediately', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    const runtime = {
      platform: 'windows',
      gitAvailable: true,
      gitVersion: 'git version 2.56.0.windows.4',
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      gitSource: 'system',
      gitError: '',
    }
    window.gitcode!.gitSettings = async (selection) => {
      if (selection?.mode === 'custom' && selection.path === 'invalid')
        throw new Error('请选择 Git 可执行文件的绝对路径。')
      if (selection?.mode === 'custom') {
        runtime.gitPath = selection.path!
        runtime.gitSource = 'custom'
      }
      return { runtime, selection: selection || { mode: 'auto' } }
    }
    window.gitcode!.chooseGit = async () => 'C:\\Tools\\Git\\cmd\\git.exe'
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
  await expect(dialog).toContainText('系统 Git')
  await expect(dialog.getByRole('radio')).toHaveCount(2)
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
  await expect(dialog.getByRole('status')).toHaveText('已应用并保存。')
  await expect(dialog).toContainText('C:\\Tools\\Git\\cmd\\git.exe')
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
})

test('启动缺少 Git 时错误页可以直接打开 Git 设置', async ({ page }) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    const original = window.gitcode!.runtime
    window.gitcode!.runtime = async () => ({
      ...(await original()),
      gitAvailable: false,
      gitError: '未找到可用 Git',
    })
    window.gitcode!.gitSettings = async () => ({
      runtime: await window.gitcode!.runtime(),
      selection: { mode: 'auto' },
      restartRequired: false,
    })
  })
  await page.reload()
  const startup = page.getByRole('region', { name: '应用启动状态', exact: true })
  await expect(startup).toContainText('未找到可用 Git')
  await startup.getByRole('button', { name: '选择已有 Git', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('tab', { name: 'Git', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(settings.getByRole('alert')).toHaveText('未找到可用 Git')
  await expect(settings.getByRole('region', { name: 'Git 运行环境', exact: true })).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
})

test('missing or outdated Git offers installation and re-detection resumes without restarting the app', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    const runtime = {
      platform: 'windows',
      gitAvailable: false,
      gitVersion: '',
      gitPath: '',
      gitSource: '',
      gitError: '未能检测到可运行的 Git。',
    }
    window.gitcode!.runtime = async () => ({ ...runtime })
    window.gitcode!.openResource = async (resource) => {
      document.documentElement.dataset.gitInstallResource = resource
    }
    window.gitcode!.refreshGitRuntime = async () => ({
      selection: { mode: 'auto' },
      runtime: {
        ...runtime,
        gitAvailable: true,
        gitVersion: 'git version 2.56.0',
        gitSource: 'system',
        gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
        gitError: '',
      },
    })
  })
  await page.reload()
  const startup = page.getByRole('region', { name: '应用启动状态', exact: true })
  await expect(startup).toContainText('需要安装或配置 Git')
  await expect(startup.getByRole('button', { name: '选择已有 Git', exact: true })).toBeVisible()
  await startup.getByRole('button', { name: '安装 Git', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-git-install-resource', 'git-install')
  await startup.getByRole('button', { name: '重新检测 Git', exact: true }).click()
  await expect(startup).not.toBeVisible()
  await expect(page.locator('#operation-status')).toContainText('git version 2.56.0')
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
})

test('startup file selection validates and saves a custom Git, then resumes in the same window', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    window.gitcode!.runtime = async () => ({
      platform: 'windows',
      gitAvailable: false,
      gitVersion: '',
      gitPath: '',
      gitError: '未找到 Git',
    })
    window.gitcode!.chooseGit = async () => 'C:\\Tools\\Git\\cmd\\git.exe'
    window.gitcode!.gitSettings = async (selection) => {
      if (!selection || selection.mode !== 'custom') throw Error('Expected custom Git')
      document.documentElement.dataset.selectedGit = selection.path
      return {
        selection,
        runtime: {
          platform: 'windows',
          gitAvailable: true,
          gitVersion: 'git version 2.54.0',
          gitPath: selection.path!,
          gitSource: 'custom',
          gitError: '',
        },
      }
    }
  })
  await page.reload()
  const startup = page.getByRole('region', { name: '应用启动状态', exact: true })
  await startup.getByRole('button', { name: '选择已有 Git', exact: true }).click()
  await expect(startup).not.toBeVisible()
  await expect(page.locator('html')).toHaveAttribute(
    'data-selected-git',
    'C:\\Tools\\Git\\cmd\\git.exe',
  )
  await expect(page.locator('#operation-status')).toContainText('git version 2.54.0')
})
