import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

async function wslFixture(page: Page) {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const root = '\\\\wsl.localhost\\'
    const distro = root + 'Ubuntu-26.04\\'
    const repo = distro + 'home\\用户\\项目'
    const runtime = window.gitk!.runtime
    window.gitk!.runtime = async () => ({ ...(await runtime()), platform: 'windows' })
    window.gitk!.listDirectory = async (path = root) => ({
      path,
      parent: path === root ? null : root,
      home: 'C:\\Users\\Tester',
      root,
      folders:
        path === root
          ? [{ name: 'Ubuntu-26.04', path: distro, isGit: false, hidden: false, symlink: false }]
          : [{ name: '项目', path: repo, isGit: true, hidden: false, symlink: false }],
      truncated: false,
      locations: [{ name: 'Linux (WSL)', path: root }],
    })
    const original = window.gitk!.snapshot
    window.gitk!.snapshot = async (path) => ({
      ...(await original(path)),
      path,
      name: '项目',
      execution: {
        kind: 'wsl',
        distribution: 'Ubuntu-26.04',
        gitPath: '/usr/bin/git',
        gitVersion: 'git version 2.53.0',
      },
    })
  })
}

for (const theme of ['dark', 'light', 'islands-dark', 'islands-light']) {
  test(`${theme}: WSL entry browses distributions and opens the selected repository`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await wslFixture(page)
    await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开 WSL 仓库…', exact: true }).click()
    const browser = page.getByRole('dialog', { name: '选择 Git 仓库', exact: true })
    await expect(browser).toBeVisible()
    await expect(browser.getByRole('button', { name: '选择仓库目录', exact: true })).toBeDisabled()
    await expect(
      browser.getByRole('button', { name: '进入目录 Ubuntu-26.04', exact: true }),
    ).toBeVisible()
    await browser.getByRole('button', { name: '进入目录 Ubuntu-26.04', exact: true }).click()
    await browser.locator('.directory-folder').filter({ hasText: '项目' }).click()
    await browser.getByRole('button', { name: '选择仓库目录', exact: true }).click()
    const entry = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await expect(entry.getByLabel('仓库路径', { exact: true })).toHaveValue(
      '\\\\wsl.localhost\\Ubuntu-26.04\\home\\用户\\项目',
    )
    const metrics = await entry.evaluate((dialog) => ({
      width: dialog.getBoundingClientRect().width,
      scrollWidth: dialog.scrollWidth,
      clientWidth: dialog.clientWidth,
    }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
    await page.screenshot({ path: `.tmp/wsl-entry-${theme}.png` })
    await entry.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(entry).not.toBeVisible()
    await expect(page.locator('#operation-status')).toContainText('WSL Ubuntu-26.04 Git 服务')
    await expect(page.locator('#operation-status')).toContainText('git version 2.53.0')
  })
}

test('Linux core does not advertise Windows-to-WSL entry, including in a Windows browser', async ({
  page,
}) => {
  await openFixtureRepository(page, false, repositoryFixture, false, {
    platform: 'linux',
    gitAvailable: true,
    gitVersion: 'git version 2.53.0',
    gitPath: '/usr/bin/git',
    gitError: '',
    transport: 'local',
    environment: 'wsl',
  })
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '打开 WSL 仓库…', exact: true })).toHaveCount(0)
})

test('WSL discovery failure remains visible and allows cancellation without selecting an invalid path', async ({
  page,
}) => {
  await wslFixture(page)
  await page.evaluate(() => {
    window.gitk!.listDirectory = async () => {
      throw Error('无法读取 WSL 发行版')
    }
  })
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开 WSL 仓库…', exact: true }).click()
  const browser = page.getByRole('dialog', { name: '选择 Git 仓库', exact: true })
  await expect(browser.getByRole('alert')).toContainText('无法读取 WSL 发行版')
  await expect(browser.getByRole('button', { name: '选择仓库目录', exact: true })).toBeDisabled()
  await browser.getByRole('button', { name: '取消', exact: true }).click()
  await expect(browser).not.toBeVisible()
})

test('saved WSL repository restores and GitFlow remains usable without Windows Git', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript((fixture) => {
    const path = '\\\\wsl.localhost\\Ubuntu-26.04\\home\\用户\\项目'
    localStorage.setItem(
      'gitcode.workspaceSession.v1',
      JSON.stringify({ version: 1, active: 0, tabs: [{ kind: 'repository', path, name: '项目' }] }),
    )
    window.gitk!.runtime = async () => ({
      platform: 'windows',
      gitAvailable: false,
      gitVersion: '',
      gitPath: '',
      gitError: '未找到 Windows Git',
    })
    window.gitk!.snapshot = async () => ({
      ...fixture,
      path,
      name: '项目',
      execution: {
        kind: 'wsl',
        distribution: 'Ubuntu-26.04',
        gitPath: '/usr/bin/git',
        gitVersion: 'git version 2.53.0',
      },
      gitflow: {
        config: {
          production: 'main',
          develop: 'develop',
          feature: 'feature/',
          release: 'release/',
          hotfix: 'hotfix/',
          versionTag: '',
        },
        signature: 'wsl-config',
        configured: true,
        ready: true,
        missing: [],
        error: '',
        writeError: '',
      },
    })
  }, repositoryFixture)
  await page.reload()
  await expect(page.locator('#operation-status')).toContainText('WSL Ubuntu-26.04 Git 服务已连接')
  await expect(page.getByRole('region', { name: '应用启动状态', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  await expect(
    page
      .locator('#gitflow-panel')
      .getByRole('button', { name: '开始新分支…', exact: true })
      .first(),
  ).toBeEnabled()
})
