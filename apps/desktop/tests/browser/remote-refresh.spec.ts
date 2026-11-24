import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('本地刷新不访问远端，获取后更新远程列表且保留本地分支', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const bridge = window.gitcode!
    const snapshot = bridge.snapshot
    let fetched: Awaited<ReturnType<typeof snapshot>> | null = null
    const calls = { snapshots: 0, plans: 0, fetches: 0 }
    Object.assign(window, { refreshCalls: calls })
    bridge.snapshot = async (...args) => {
      calls.snapshots++
      return fetched || snapshot(...args)
    }
    bridge.syncPlan = async () => {
      calls.plans++
      return { id: 'remote-refresh-plan' } as never
    }
    bridge.action = async () => {
      calls.fetches++
      fetched = await snapshot('/test-fixtures/repository')
      fetched.branches = fetched.branches.filter((branch) => branch.name !== 'origin/develop')
      fetched.branches.push({
        name: 'origin/new-on-server',
        kind: 'remote',
        hash: fetched.head,
        current: false,
        upstream: '',
        track: '',
      })
      return {
        outcome: 'succeeded',
        output: '',
        snapshot: fetched,
        steps: [{ remote: 'origin', ok: true }],
      }
    }
  })
  const remote = page.locator('.sidebar [data-branch-name="origin/develop"]')
  await expect(remote).toBeVisible()
  const refresh = page.getByRole('button', { name: '刷新', exact: true })
  await expect(refresh).toHaveAttribute('title', /刷新本地状态.*更新远程分支请点击获取/)
  await refresh.click()
  await expect(remote).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { refreshCalls: unknown }).refreshCalls),
  ).toEqual({ snapshots: 1, plans: 0, fetches: 0 })
  await page.getByRole('button', { name: '获取', exact: true }).click()
  await expect(remote).toHaveCount(0)
  await expect(page.locator('.sidebar [data-branch-name="origin/new-on-server"]')).toBeVisible()
  await expect(
    page.locator('.sidebar [data-branch-kind="local"][data-branch-name="develop"]'),
  ).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { refreshCalls: unknown }).refreshCalls),
  ).toEqual({ snapshots: 1, plans: 1, fetches: 1 })
})

test('获取失败保留已有远程列表并显示失败结果', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.syncPlan = async () => ({ id: 'offline-plan' }) as never
    window.gitcode!.action = async () => ({
      outcome: 'failed',
      output: '',
      error: '远端连接失败，远程状态未更新',
      snapshot: null,
    })
  })
  await page.getByRole('button', { name: '获取', exact: true }).click()
  await expect(page.locator('.sidebar [data-branch-name="origin/develop"]')).toBeVisible()
  await expect(
    page.locator('.toast').filter({ hasText: '远端连接失败，远程状态未更新' }),
  ).toBeVisible()
})
