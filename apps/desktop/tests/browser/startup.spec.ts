import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

type Controls = Window & {
  restoreCalls: string[]
  finishRestore: () => void
  restoreFailure: boolean
}
async function setup(page: import('@playwright/test').Page, mode: 'fast' | 'slow' | 'failed') {
  await openFixtureRepository(page, false, repositoryFixture, true)
  await page.addInitScript(
    ({ snapshot, mode }) => {
      const host = window as unknown as Controls
      host.restoreCalls = []
      host.restoreFailure = mode === 'failed'
      localStorage.setItem(
        'gitcode.workspaceSession.v1',
        JSON.stringify({
          version: 1,
          active: 0,
          tabs: [
            { kind: 'repository', path: '/test-fixtures/one', name: 'one' },
            { kind: 'repository', path: '/test-fixtures/two', name: 'two' },
          ],
        }),
      )
      window.gitcode!.snapshot = async (path) => {
        host.restoreCalls.push(path)
        if (host.restoreFailure) throw new Error('仓库目录暂时无法访问')
        if (mode === 'slow' && host.restoreCalls.length === 1)
          await new Promise<void>((resolve) => {
            host.finishRestore = resolve
          })
        return { ...structuredClone(snapshot), path, name: path.split('/').at(-1)! }
      }
    },
    { snapshot: repositoryFixture, mode },
  )
  await page.reload()
}

test('fast launch restores the active tab without a forced animation or scanning inactive repositories', async ({
  page,
}) => {
  await setup(page, 'fast')
  await expect(page.locator('.repo-selector')).toHaveAttribute(
    'data-repository-path',
    '/test-fixtures/one',
  )
  await expect(page.getByRole('region', { name: '应用启动状态' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as Controls).restoreCalls)).toEqual([
    '/test-fixtures/one',
  ])
  await page.locator('.tab-select[data-repository-path="/test-fixtures/two"]').click()
  await expect(page.locator('.repo-selector')).toHaveAttribute(
    'data-repository-path',
    '/test-fixtures/two',
  )
  expect(await page.evaluate(() => (window as unknown as Controls).restoreCalls)).toEqual([
    '/test-fixtures/one',
    '/test-fixtures/two',
  ])
})

test('slow restore displays its actual phase and respects reduced motion until the real read finishes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setup(page, 'slow')
  const screen = page.getByRole('region', { name: '应用启动状态' })
  await expect(screen).toBeVisible()
  await expect(screen).toContainText('正在恢复仓库工作区')
  expect(
    await screen.locator('.startup-card').evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('none')
  await expect(screen.getByRole('progressbar')).not.toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(screen.getByRole('progressbar')).toBeVisible()
  await expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
  await page.evaluate(() => (window as unknown as Controls).finishRestore())
  await expect(screen).toHaveCount(0)
  await expect(page.locator('.repo-selector')).toHaveAttribute(
    'data-repository-path',
    '/test-fixtures/one',
  )
})

test('a missing startup repository can be retried after it becomes available', async ({ page }) => {
  await setup(page, 'failed')
  const screen = page.getByRole('region', { name: '应用启动状态' })
  await expect(screen).toContainText('仓库目录暂时无法访问')
  await expect(screen.getByRole('progressbar')).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as unknown as Controls).restoreFailure = false
  })
  await screen.getByRole('button', { name: '重试', exact: true }).click()
  await expect(screen).toHaveCount(0)
  await expect(page.locator('.repo-selector')).toHaveAttribute(
    'data-repository-path',
    '/test-fixtures/one',
  )
})

test('skipping failed recovery opens a new tab while retaining the inaccessible repository entry', async ({
  page,
}) => {
  await setup(page, 'failed')
  await page
    .getByRole('region', { name: '应用启动状态' })
    .getByRole('button', { name: '进入新标签页', exact: true })
    .click()
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  await expect(page.locator('.tab-select[data-repository-path="/test-fixtures/one"]')).toBeVisible()
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('gitcode.workspaceSession.v1')!),
  )
  expect(saved.tabs[saved.active].kind).toBe('new')
})
