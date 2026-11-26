import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import type { GitConsoleRequest } from '../../src/shared/contracts/gitConsole'

async function fixture(page: Page) {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const requests: GitConsoleRequest[] = []
    Object.assign(window, { consoleRequests: requests })
    window.gitcode!.gitConsole = async (repo, request) => {
      requests.push(request)
      const entries = [
        { sequence: 1, kind: 'start' as const, text: 'git fetch --progress origin' },
        { sequence: 2, kind: 'stderr' as const, text: 'Receiving objects: 50%', progress: true },
        { sequence: 3, kind: 'stderr' as const, text: 'Receiving objects: 100%', progress: false },
        {
          sequence: 4,
          kind: 'finish' as const,
          text: '',
          state: 'succeeded' as const,
          code: 0,
          elapsed: 24,
        },
      ].map((entry) => ({
        ...entry,
        repo,
        commandId: 'command-1',
        operationId: 'operation-1',
        at: Date.now(),
      }))
      return {
        epoch: 'epoch-1',
        cursor: 4,
        entries:
          request.action === 'tail'
            ? []
            : entries.filter((entry) => entry.sequence > (request.cursor || 0)),
        running: [],
        more: false,
        reset: false,
        dropped: false,
      }
    }
  })
}
async function requests(page: Page) {
  return page.evaluate(
    () => (window as unknown as { consoleRequests: GitConsoleRequest[] }).consoleRequests,
  )
}
test('console replays hidden records, merges progress and resumes by cursor without starting a Shell', async ({
  page,
}) => {
  await fixture(page)
  expect(await requests(page)).toHaveLength(0)
  await page.getByRole('button', { name: 'Git 控制台', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Git 控制台面板', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.git-console-line')).toHaveCount(3)
  await expect(panel.locator('.git-console-output')).not.toContainText('50%')
  await expect(panel.locator('.git-console-output')).toContainText('100%')
  expect(await page.evaluate(() => document.querySelectorAll('.terminal-screen').length)).toBe(0)
  await panel.getByRole('button', { name: '隐藏 Git 控制台', exact: true }).click()
  await expect(panel).not.toBeVisible()
  const count = (await requests(page)).length
  await page.waitForTimeout(450)
  expect(await requests(page)).toHaveLength(count)
  await page.getByRole('button', { name: 'Git 控制台', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.git-console-line')).toHaveCount(3)
  await expect.poll(async () => (await requests(page)).at(-1)?.cursor).toBe(4)
})
test('clearing only advances the presentation cursor and menu opens the same console', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: 'Git 控制台', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Git 控制台面板', exact: true })
  await expect(panel.locator('.git-console-line')).toHaveCount(3)
  await panel.getByRole('button', { name: '清空', exact: true }).click()
  await expect(panel.locator('.git-console-line')).toHaveCount(0)
  expect((await requests(page)).some((request) => request.action === 'tail')).toBe(true)
  await panel.getByRole('button', { name: '隐藏 Git 控制台', exact: true }).click()
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Git 控制台', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.git-console-line')).toHaveCount(0)
})
