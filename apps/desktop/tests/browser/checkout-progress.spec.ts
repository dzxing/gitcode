import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

for (const outcome of ['succeeded', 'failed', 'cancelled', 'protected'] as const) {
  test(`checkout navigation remains blocked until ${outcome} is settled`, async ({ page }) => {
    await openFixtureRepository(page)
    await page.addInitScript(
      ({ state, outcome }) => {
        let finish: () => void
        const controls = window as unknown as { finishCheckout: () => void; checkoutCalls: number }
        controls.checkoutCalls = 0
        controls.finishCheckout = () => finish()
        window.gitk!.cancel = async () => {}
        window.gitk!.action = async (_repo, request) => {
          if (request.action !== 'checkout') throw new Error('Unexpected action')
          controls.checkoutCalls++
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          if (outcome === 'failed') throw new Error('Checkout hook failed')
          const snapshot = structuredClone(state)
          snapshot.path = '/test-fixtures/repository'
          if (outcome === 'succeeded') {
            snapshot.branch = 'develop'
            snapshot.head = snapshot.branches.find((b) => b.name === 'develop')!.hash
            snapshot.branches.forEach((b) => {
              b.current = b.kind === 'local' && b.name === 'develop'
            })
          }
          return {
            snapshot,
            output: '',
            outcome: outcome === 'protected' ? 'failed' : outcome,
            ...(outcome === 'protected'
              ? {
                  checkoutProtection: {
                    id: 'protected-checkout',
                    branch: 'develop',
                    paths: ['README.md'],
                  },
                  error: '本地修改会被覆盖，已阻止切换；修改保持不变。',
                }
              : {}),
          }
        }
      },
      { state: repositoryFixture, outcome },
    )
    await page.reload()
    await page
      .getByRole('button', { name: 'repository /test-fixtures/repository', exact: true })
      .click()
    const branch = page
      .locator('[data-sidebar-section="local"] .branch-row')
      .filter({ hasText: 'develop' })
      .first()
    await branch.dblclick()
    const progress = page.locator('.sidebar-checkout-progress')
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('develop')
    await expect(page.getByText('已切换分支', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sidebar')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.sidebar-content')).toHaveAttribute('inert', '')
    await expect(page.getByRole('button', { name: '新建标签页', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'GitCode 首页', exact: true })).toBeDisabled()
    await expect(page.locator('.tab-select').first()).toBeDisabled()
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeDisabled()
    await branch.dispatchEvent('dblclick')
    expect(
      await page.evaluate(() => (window as unknown as { checkoutCalls: number }).checkoutCalls),
    ).toBe(1)
    if (outcome === 'cancelled') {
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(progress).toContainText('正在取消并核对结果')
      await expect(page.locator('.tab-select').first()).toBeDisabled()
    }
    await page.evaluate(() =>
      (window as unknown as { finishCheckout: () => void }).finishCheckout(),
    )
    await expect(progress).not.toBeVisible()
    await expect(page.locator('.sidebar')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.sidebar-content')).not.toHaveAttribute('inert', '')
    if (outcome === 'protected') {
      await expect(page.getByRole('dialog', { name: /切换.*分支|本地修改/ })).toBeVisible()
    } else {
      await expect(page.locator('.tab-select').first()).toBeEnabled()
      if (outcome === 'succeeded') {
        await expect(page.locator('[aria-label="选择本地分支，当前 develop"]')).toBeVisible()
        await expect(page.getByText('已切换分支', { exact: true })).toBeVisible()
      } else await expect(page.getByText('已切换分支', { exact: true })).toHaveCount(0)
    }
  })
}

// Exercise the actual local-core RPC and a real post-checkout hook as well.
test('checkout waits for the real Git hook and refreshed repository before unblocking', async ({
  page,
  baseURL,
}) => {
  const { verifyCheckoutProgress } = await import('../../scripts/verify-checkout-progress-ui.mjs')
  await verifyCheckoutProgress(page, { url: baseURL })
})
