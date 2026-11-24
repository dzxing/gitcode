import { expect, test, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  await page
    .locator('.gitflow-panel')
    .getByRole('button', { name: 'GitFlow 设置', exact: true })
    .click()
}

test('GitFlow entry remains discoverable when collapsed and settings drafts survive reopening', async ({
  page,
}) => {
  await openFixtureRepository(page, true)
  await page.getByRole('button', { name: '展开或折叠 GitFlow 分类', exact: true }).click()
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  const panel = page.locator('.gitflow-panel')
  await expect(panel.getByRole('button', { name: '开始新分支…', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '完成分支…', exact: true })).toBeDisabled()
  await expect(panel.locator('#flow-start-entry-reason')).toContainText(
    '请先配置并保存 GitFlow 规则',
  )
  await expect(panel.getByRole('button', { name: '配置 GitFlow', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'GitFlow 设置', exact: true }).click()
  await panel.getByLabel('Feature 前缀', { exact: true }).fill('work/')
  await expect(panel.getByRole('button', { name: '保存规则', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
  await openSettings(page)
  await expect(panel.getByLabel('Feature 前缀', { exact: true })).toHaveValue('work/')
  await expect(panel.getByText('已恢复未完成的输入。')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})

test('GitFlow Start uses the desktop bridge once and reports local-only success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const sha = 'a'.repeat(40)
    const config = {
      production: 'main',
      develop: 'develop',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    }
    const state = {
      path: '/mock/project',
      name: 'project',
      branch: 'main',
      head: sha,
      commits: [
        {
          hash: sha,
          parents: [],
          subject: 'initial',
          author: 'Test',
          email: 'test@example.com',
          date: '2026-10-27T10:00:00Z',
          refs: ['HEAD -> main', 'develop'],
        },
      ],
      branches: ['main', 'develop'].map((name) => ({
        name,
        fullRef: `refs/heads/${name}`,
        hash: sha,
        commitHash: sha,
        current: name === 'main',
        upstream: '',
        track: '',
        kind: 'local' as const,
      })),
      staged: [],
      unstaged: [],
      total: 1,
      gitflow: {
        config,
        signature: 'config-1',
        configured: true,
        ready: true,
        missing: [],
        error: '',
        writeError: '',
      },
    }
    window.gitcode = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'git version 2.53.0',
        gitPath: 'git',
        gitError: '',
      }),
      repositoryTrust: async (path: string) => ({
        path,
        gitDir: path + '/.git',
        trusted: true,
        token: '',
      }),
      snapshot: async () => structuredClone(state),
      action: async (_repo, request) => {
        if (request.action !== 'gitflow-start') throw new Error('Unexpected action')
        if (
          request.name !== 'login' ||
          request.sourceOid !== sha ||
          request.signature !== 'config-1'
        )
          throw new Error('Wrong source')
        state.branch = 'feature/login'
        state.branches.forEach((branch) => {
          branch.current = false
        })
        state.branches.push({
          name: 'feature/login',
          fullRef: 'refs/heads/feature/login',
          hash: sha,
          commitHash: sha,
          current: true,
          upstream: '',
          track: '',
          kind: 'local',
        })
        return {
          outcome: 'succeeded',
          output: '已创建 feature/login 并切换；仅保存在本地，尚未推送。',
          snapshot: structuredClone(state),
        }
      },
      chooseDirectory: async () => '/mock/project',
      cancel: async () => {},
      openResource: async () => {},
      commit: async () => ({ files: [], body: 'initial' }),
      diff: async () => ({ diff: '', truncated: false }),
      create: async () => {
        throw new Error('Unexpected create')
      },
      listDirectory: async () => {
        throw new Error('Unexpected directory')
      },
      syncPlan: async () => {
        throw new Error('Unexpected sync')
      },
      gitflowPlan: async () => {
        throw new Error('Unexpected initialize')
      },
    }
  })
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await expect(page.locator('.history-panel')).toBeVisible()
  await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
  const panel = page.locator('.gitflow-panel')
  await panel.getByRole('button', { name: '开始新分支…', exact: true }).click()
  await panel.getByLabel('分支名称', { exact: true }).fill('login')
  await expect(panel.getByText('feature/login', { exact: true })).toBeVisible()
  await panel.getByLabel('分支名称', { exact: true }).press('Enter')
  await expect(panel.getByText('本地操作已完成', { exact: true })).toBeVisible()
  await expect(
    panel.getByText('已创建 feature/login 并切换；仅保存在本地，尚未推送。', { exact: true }),
  ).toBeVisible()
})

test('GitFlow settings align notices and form, with compact controls and keyboard help', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFixtureRepository(page, true)
  await openSettings(page)
  const panel = page.locator('.gitflow-settings')
  const form = await panel.locator('.gitflow-settings-form').boundingBox()
  expect(form!.width).toBeLessThanOrEqual(640)
  const production = panel.getByLabel('生产分支', { exact: true })
  const develop = panel.getByLabel('开发分支', { exact: true })
  const first = await production.boundingBox(),
    second = await develop.boundingBox()
  expect(first!.height).toBe(34)
  expect(first!.width).toBe(360)
  expect(Math.abs(first!.x - second!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(second!.y - first!.y - 50)).toBeLessThanOrEqual(1)
  await expect(production).toHaveCSS('font-size', '13px')
  const save = await panel.getByRole('button', { name: '保存规则', exact: true }).boundingBox()
  expect(Math.abs(save!.x - first!.x)).toBeLessThanOrEqual(1)
  for (const field of [
    '生产分支',
    '开发分支',
    'Feature 前缀',
    'Release 前缀',
    'Hotfix 前缀',
    '版本标签前缀',
  ]) {
    const input = panel.getByLabel(field, { exact: true })
    const hasDescriptions = await input.evaluate((element) =>
      element
        .getAttribute('aria-describedby')!
        .split(/\s+/)
        .every((id) => !!document.getElementById(id)),
    )
    expect(hasDescriptions).toBe(true)
  }
  const help = panel.locator('.gitflow-field-help')
  await help.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(help).toHaveAttribute('open', '')
  await expect(
    help.getByText('例如 v，也可留空；保存时不会创建标签', { exact: true }),
  ).toBeVisible()
})

test('GitFlow settings adapt to available width without clipping long input or initialization controls', async ({
  page,
}) => {
  await openFixtureRepository(page, true)
  await openSettings(page)
  const panel = page.locator('.gitflow-settings')
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(panel.locator('.gitflow-panel-layout')).toHaveCSS('flex-direction', 'column')
  // Exercise a narrow content region inside a supported app viewport as well.
  await panel.locator('.gitflow-content').evaluate((element) => {
    element.style.maxWidth = '400px'
  })
  await panel.locator('.gitflow-panel-body').evaluate((element) => {
    element.style.width = '440px'
    element.style.flex = '0 1 auto'
  })
  const input = panel.getByLabel('生产分支', { exact: true })
  await input.fill('团队/很长的生产分支名称/'.repeat(5))
  const label = await panel.locator('label[for="flow-production"]').boundingBox()
  const field = await input.boundingBox()
  expect(label!.y + label!.height).toBeLessThanOrEqual(field!.y)
  expect(Math.abs(label!.x - field!.x)).toBeLessThanOrEqual(1)
  const save = await panel.getByRole('button', { name: '保存规则', exact: true }).boundingBox()
  expect(Math.abs(save!.x - field!.x)).toBeLessThanOrEqual(1)
  const withinViewport = await panel
    .locator('.gitflow-panel-body')
    .evaluate((element) => element.scrollWidth <= element.clientWidth)
  expect(withinViewport).toBe(true)
  const preview = panel.getByRole('button', { name: '预览初始化', exact: true })
  await preview.scrollIntoViewIfNeeded()
  await expect(preview).toBeVisible()
})
