import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import type { GitActivity, SyncPlan } from '../../src/shared/contracts'

test('Fetch allows cached tab browsing and never applies its result to another repository', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript((state) => {
    const source = '/test-fixtures/repository'
    const fixture = (repo: string) => ({
      ...structuredClone(state),
      path: repo,
      name: repo === source ? 'First' : 'Second',
    })
    let finish: () => void
    const controls = window as unknown as { finishFetch: () => void }
    controls.finishFetch = () => finish()
    window.gitcode!.snapshot = async (repo) => fixture(repo)
    window.gitcode!.chooseDirectory = async () => '/test-fixtures/second'
    window.gitcode!.syncPlan = async () => ({ id: 'fetch-plan' }) as SyncPlan
    window.gitcode!.activity = async () => ({
      id: 'fetch-job',
      operation: 'fetch',
      repo: source,
      phase: '获取远程引用',
      percent: null,
      state: 'running',
    })
    window.gitcode!.action = async (repo, request) => {
      if (request.action !== 'fetch') throw new Error('Unexpected write during fetch')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { outcome: 'succeeded', output: '', snapshot: { ...fixture(repo), total: 123 } }
    }
  }, repositoryFixture)
  await page.reload()
  await page
    .getByRole('button', { name: 'repository /test-fixtures/repository', exact: true })
    .click()
  await page.keyboard.press('Control+o')
  await expect(page.locator('.status-path')).toHaveText('/test-fixtures/second')
  await page.locator('.tab-select[data-repository-path="/test-fixtures/repository"]').click()
  await page.locator('.toolbar-actions').getByRole('button', { name: '获取', exact: true }).click()
  const task = page.getByRole('status', { name: 'Git 操作进度', exact: true })
  await expect(task).toContainText('获取远程引用')
  await expect(task.locator('progress')).not.toHaveAttribute('value', /.+/)
  await expect(
    page.locator('.toolbar-actions button').filter({ hasText: '获取' }).locator('.spin'),
  ).toHaveCount(1)
  const second = page.locator('.tab-select[data-repository-path="/test-fixtures/second"]')
  await expect(second).toBeEnabled()
  await second.click()
  await expect(page.locator('.status-path')).toHaveText('/test-fixtures/second')
  await page.evaluate(() => (window as unknown as { finishFetch: () => void }).finishFetch())
  await expect(task).not.toBeVisible()
  await expect(page.locator('.status-path')).toHaveText('/test-fixtures/second')
  await expect(page.locator('.history-heading .pill')).not.toHaveText('123')
  await page.locator('.tab-select[data-repository-path="/test-fixtures/repository"]').click()
  await expect(page.locator('.history-heading .pill')).toHaveText('123')
})

test('Fetch All shows successful and failed remote results together', async ({ page }) => {
  await openFixtureRepository(page)
  await page.addInitScript((snapshot) => {
    window.gitcode!.syncPlan = async () => ({ id: 'partial-fetch' }) as SyncPlan
    window.gitcode!.action = async () => ({
      outcome: 'partial',
      output: '',
      error: 'backup 连接失败',
      snapshot: { ...snapshot, total: 321 },
      steps: [
        { remote: 'origin', ok: true },
        { remote: 'backup', ok: false, message: '连接失败，引用未更新' },
      ],
    })
  }, repositoryFixture)
  await page.reload()
  await page
    .getByRole('button', { name: 'repository /test-fixtures/repository', exact: true })
    .click()
  await page.locator('.toolbar-actions').getByRole('button', { name: '获取', exact: true }).click()
  const notice = page.locator('.toast').filter({ hasText: 'backup 连接失败' })
  await expect(notice).toContainText('origin：已获取')
  await expect(notice).toContainText('backup：连接失败，引用未更新')
  await expect(page.locator('.history-heading .pill')).toHaveText('321')
  await expect(
    page.locator('.toolbar-actions').getByRole('button', { name: '获取', exact: true }),
  ).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('fetch-results.png') })
})

test('clone closes its parameter dialog, reports phase progress and waits after cancel request', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.addInitScript(() => {
    let finish: () => void
    const controls = window as unknown as { finishClone: () => void; cloneProgress: GitActivity }
    controls.cloneProgress = {
      id: 'clone-job',
      operation: 'clone',
      repo: '/clone-target',
      phase: '接收对象',
      percent: 37,
      state: 'running',
    }
    controls.finishClone = () => finish()
    window.gitcode!.activity = async () => controls.cloneProgress
    window.gitcode!.cancel = async () => {}
    window.gitcode!.create = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      throw new Error('克隆已取消，目标目录可能留有部分内容，请核对。')
    }
  })
  await page.reload()
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: '克隆仓库…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '克隆仓库', exact: true })
  await dialog.getByLabel('仓库地址', { exact: true }).fill('https://example.invalid/repo.git')
  await dialog.getByLabel('父目录', { exact: true }).fill('/')
  await dialog.getByLabel('仓库名称', { exact: true }).fill('clone-target')
  await dialog.getByRole('button', { name: '克隆并打开', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const task = page.getByRole('status', { name: 'Git 操作进度', exact: true })
  await expect(task).toContainText('接收对象 · 37%')
  await expect(task.locator('progress')).toHaveAttribute('value', '37')
  await page.evaluate(() => {
    ;(window as unknown as { cloneProgress: GitActivity }).cloneProgress = {
      id: 'clone-job',
      operation: 'clone',
      repo: '/clone-target',
      phase: '读取新仓库状态',
      percent: null,
      state: 'running',
    }
  })
  await expect(task).toContainText('读取新仓库状态')
  await expect(task.locator('progress')).not.toHaveAttribute('value', /.+/)
  await task.getByRole('button', { name: '取消操作', exact: true }).click()
  await expect(task).toContainText('正在取消并核对结果')
  await expect(page.getByRole('button', { name: '新建标签页', exact: true })).toBeDisabled()
  await page.evaluate(() => (window as unknown as { finishClone: () => void }).finishClone())
  await expect(task).not.toBeVisible()
  await expect(page.getByRole('button', { name: '新建标签页', exact: true })).toBeEnabled()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status').filter({ hasText: '克隆已取消' })).toBeVisible()
  await expect(dialog.getByLabel('仓库地址', { exact: true })).toHaveValue(
    'https://example.invalid/repo.git',
  )
  await expect(dialog.getByLabel('目标路径', { exact: true })).toHaveText('/clone-target')
})

test('branch creation uses the actual HEAD graph cell and cancels without a write', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.locator('.toolbar-actions').getByRole('button', { name: '分支', exact: true }).click()
  const form = page.getByRole('form', { name: '在此提交新建分支', exact: true })
  await expect(form).toBeVisible()
  await expect(page.getByRole('dialog', { name: '新建分支', exact: true })).not.toBeVisible()
  await form.getByRole('textbox', { name: '分支名称', exact: true }).fill('feature/inline-name')
  await expect(form.locator('..')).toHaveClass(/ref-cell/)
  await form.getByRole('button', { name: '取消新建分支', exact: true }).click()
  await expect(form).not.toBeVisible()
})

test('rename and delete confirmations dock beneath the titlebar without losing cancel', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const branch = page.locator(
    '[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main',
  )
  for (const action of ['重命名 develop', '删除 develop']) {
    await branch.click({ button: 'right' })
    await page.getByRole('menuitem', { name: action, exact: true }).click()
    const prompt = page.locator('dialog.context-operation[open]')
    await expect(prompt).toHaveClass(/prompt-bar/)
    const bounds = await prompt.boundingBox()
    expect(bounds!.x).toBe(0)
    expect(bounds!.y).toBe(38)
    expect(bounds!.width).toBe(1440)
    await prompt.getByRole('button', { name: '取消', exact: true }).click()
    await expect(prompt).not.toBeVisible()
  }
})

test('branch creation falls back to a top prompt when HEAD is filtered out of the graph', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.getByRole('textbox', { name: '搜索提交', exact: true }).fill('Merge branch')
  await page.locator('.toolbar-actions').getByRole('button', { name: '分支', exact: true }).click()
  const prompt = page.getByRole('dialog', { name: '从这里，开启新分支', exact: true })
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveClass(/prompt-bar/)
  await expect(page.getByRole('form', { name: '在此提交新建分支', exact: true })).not.toBeVisible()
  await prompt.getByRole('button', { name: '取消', exact: true }).click()
  await expect(prompt).not.toBeVisible()
})
