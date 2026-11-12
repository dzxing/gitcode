import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

async function prepare(page: Page, interval = 0) {
  await openFixtureRepository(page)
  await page.addInitScript(
    ({ snapshot, interval }) => {
      const source = '/test-fixtures/repository'
      let settings = { autoFetchInterval: interval, extended: false }
      const remoteStatus = { lastAttempt: 0, lastSuccess: 0, error: '', remotes: {} }
      const controls = window as unknown as {
        autoCalls: string[]
        resolveAuto?: () => void
        delayAuto: boolean
      }
      controls.autoCalls = []
      controls.delayAuto = false
      const records = [
        {
          id: 'failed-push',
          operation: 'push',
          repo: source,
          target: 'feature/qa',
          background: false,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          duration: 123,
          state: 'failed' as const,
          message: '远端拒绝推送',
          output: 'Hook blocked QA test',
          commands: 'git push origin feature/qa',
          truncated: false,
        },
        {
          id: 'other-repo',
          operation: 'commit',
          repo: '/test-fixtures/other',
          target: '',
          background: false,
          startedAt: Date.now(),
          duration: 15,
          state: 'succeeded' as const,
          message: '',
          output: 'other-repository-secret',
          commands: '',
          truncated: false,
        },
        {
          id: 'app-setting',
          operation: 'activity-settings',
          repo: '',
          target: '',
          background: false,
          startedAt: Date.now(),
          duration: 1,
          state: 'succeeded' as const,
          message: '',
          output: '设置已保存',
          commands: '',
          truncated: false,
        },
      ]
      window.gitk!.activitySettings = async (value) => {
        if (value) settings = { ...value }
        return { ...settings }
      }
      window.gitk!.operationLog = async (query) => ({
        records: records
          .filter((r) => (query.scope === 'application' ? !r.repo : r.repo === query.repo))
          .map((r) => ({
            ...r,
            output: query.id === r.id ? r.output : '',
            commands: settings.extended && query.id === r.id ? r.commands : '',
          })),
        settings: { ...settings },
        storageError: '',
      })
      window.gitk!.clearOperationLog = async (query) => {
        for (let i = records.length - 1; i >= 0; i--)
          if (query.scope === 'application' ? !records[i].repo : records[i].repo === query.repo)
            records.splice(i, 1)
      }
      window.gitk!.fetchStatus = async () => ({ ...remoteStatus })
      window.gitk!.automaticFetch = async (repo) => {
        if (
          !settings.autoFetchInterval ||
          Date.now() - remoteStatus.lastAttempt < settings.autoFetchInterval * 60000
        )
          return { skipped: true }
        remoteStatus.lastAttempt = Date.now()
        controls.autoCalls.push(repo)
        if (controls.delayAuto)
          await new Promise<void>((resolve) => {
            controls.resolveAuto = resolve
          })
        remoteStatus.lastSuccess = Date.now()
        return {
          skipped: false,
          outcome: 'succeeded',
          status: { ...remoteStatus },
          snapshot: { ...structuredClone(snapshot), path: repo, total: 777 },
        }
      }
      window.gitk!.snapshot = async (repo) => ({
        ...structuredClone(snapshot),
        path: repo,
        name: repo.split('/').at(-1)!,
      })
    },
    { snapshot: repositoryFixture, interval },
  )
  await page.reload()
  await page
    .getByRole('button', { name: 'repository /test-fixtures/repository', exact: true })
    .click()
}

test('activity log opens from footer, isolates scope, and displays/copies diagnostic detail', async ({
  page,
}, testInfo) => {
  await prepare(page)
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: '当前仓库', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await panel.locator('.activity-log-row').click()
  await expect(panel.getByRole('region', { name: '操作详情' })).toContainText(
    'Hook blocked QA test',
  )
  await expect(panel).not.toContainText('other-repository-secret')
  await expect(panel).not.toContainText('git push origin')
  await panel.getByRole('button', { name: '自动获取与日志设置' }).click()
  await panel.getByRole('checkbox', { name: '扩展日志（包含自动获取与内部命令）' }).check()
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(panel.getByRole('region', { name: '操作详情' })).toContainText('git push origin')
  await page.screenshot({ path: testInfo.outputPath('activity-log.png') })
  await panel.getByRole('tab', { name: '应用', exact: true }).click()
  await expect(panel.locator('.activity-log-row')).toHaveCount(1)
  await expect(panel.locator('.activity-log-row')).toContainText('修改活动日志')
  await panel.getByRole('button', { name: '关闭活动日志' }).click()
  await expect(panel).not.toBeVisible()
})

test('activity log settings validate interval and clearing requires an explicit action', async ({
  page,
}) => {
  await prepare(page)
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await panel.getByRole('button', { name: '自动获取与日志设置' }).click()
  const input = panel.getByRole('spinbutton', { name: '自动获取间隔（分钟）' })
  await input.fill('61')
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(input).toBeVisible()
  await input.fill('0')
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(input).not.toBeVisible()
  await panel.getByRole('button', { name: '清空日志', exact: true }).click()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(panel.locator('.activity-log-row')).toHaveCount(1)
  await panel.getByRole('button', { name: '清空日志', exact: true }).click()
  await panel.getByRole('button', { name: '清空记录', exact: true }).click()
  await expect(panel).toContainText('暂无操作记录')
})

test('automatic fetch is silent and periodic, and zero disables it', async ({ page }) => {
  await page.clock.install()
  await prepare(page, 1)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { autoCalls: string[] }).autoCalls.length),
    )
    .toBe(1)
  await expect(page.locator('.toast')).not.toContainText(['已获取'])
  await expect(page.locator('.history-heading .pill')).toHaveText('777')
  await page.clock.fastForward(61000)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { autoCalls: string[] }).autoCalls.length),
    )
    .toBe(2)
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await panel.getByRole('button', { name: '自动获取与日志设置' }).click()
  await panel.getByRole('spinbutton', { name: '自动获取间隔（分钟）' }).fill('0')
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await panel.getByRole('button', { name: '关闭活动日志' }).click()
  await page.clock.fastForward(120000)
  expect(
    await page.evaluate(() => (window as unknown as { autoCalls: string[] }).autoCalls.length),
  ).toBe(2)
})

test('View menu opens the same activity log and Escape closes it', async ({ page }) => {
  await prepare(page)
  await page.getByRole('menuitem', { name: /^视图/ }).click()
  await page.getByRole('menuitem', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})

test('a delayed automatic fetch never changes the newly active repository and does not overlap', async ({
  page,
}) => {
  await page.clock.install()
  await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as { delayAuto: boolean }).delayAuto = true
  })
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await panel.getByRole('button', { name: '自动获取与日志设置' }).click()
  await panel.getByRole('spinbutton', { name: '自动获取间隔（分钟）' }).fill('1')
  await panel.getByRole('button', { name: '保存设置', exact: true }).click()
  await panel.getByRole('button', { name: '关闭活动日志' }).click()
  await page.clock.fastForward(15001)
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { autoCalls: string[] }).autoCalls.length),
    )
    .toBe(1)
  await page.clock.fastForward(120000)
  expect(
    await page.evaluate(() => (window as unknown as { autoCalls: string[] }).autoCalls.length),
  ).toBe(1)
  await page.evaluate(() => {
    window.gitk!.chooseDirectory = async () => '/test-fixtures/other'
  })
  await page.keyboard.press('Control+o')
  await expect(page.locator('.tab-select[title="/test-fixtures/other"]')).toBeVisible()
  await page.evaluate(() => (window as unknown as { resolveAuto: () => void }).resolveAuto())
  await expect(page.locator('.fetch-status-button')).not.toContainText('后台获取中')
  await expect(page.locator('.status-path')).toHaveAttribute(
    'title',
    /^\/test-fixtures\/other(?:；|$)/,
  )
  await expect(page.locator('.history-heading .pill')).not.toHaveText('777')
  await page.locator('.tab-select[title="/test-fixtures/repository"]').click()
  await expect(page.locator('.history-heading .pill')).toHaveText('777')
})

test('a failed Fetch log provides an explicit manual retry', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const bridge = window.gitk!
    const original = bridge.operationLog!
    bridge.operationLog = async (query) => {
      const value = await original(query)
      return {
        ...value,
        records: value.records.map((record) => ({ ...record, operation: 'fetch', target: '' })),
      }
    }
    bridge.syncPlan = async () =>
      ({ id: 'retry-fetch' }) as Awaited<ReturnType<typeof bridge.syncPlan>>
    bridge.action = async (_repo, request) => {
      if (request.action !== 'fetch') throw new Error('unexpected action')
      ;(window as unknown as { manualRetry: boolean }).manualRetry = true
      return { outcome: 'succeeded', output: '', snapshot: null }
    }
  })
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await panel.locator('.activity-log-row').click()
  await panel.getByRole('button', { name: '手动获取', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { manualRetry: boolean }).manualRetry))
    .toBe(true)
})

async function prepareFetchFailure(page: Page, withFetch = true) {
  await page.clock.install()
  await prepare(page)
  await page.evaluate(
    ({ withFetch }) => {
      const bridge = window.gitk!
      const previous = bridge.operationLog!
      bridge.fetchStatus = async () => ({
        lastAttempt: Date.now(),
        lastSuccess: 0,
        error: 'QA backup unavailable',
        remotes: {},
      })
      bridge.operationLog = async (query) => {
        const value = await previous(query)
        if (query.scope === 'application' || !withFetch) return value
        const prototype = value.records[0]!
        const failure = 'fatal: QA backup does not appear to be a git repository'
        const records = [
          {
            ...prototype,
            id: 'newer-push-error',
            operation: 'push',
            state: 'failed' as const,
            message: '推送失败',
            startedAt: 10000,
            output: '',
          },
          {
            ...prototype,
            id: 'recent-grouped-fetch',
            operation: 'fetch',
            state: 'partial' as const,
            message: failure,
            output: failure,
            startedAt: 1000,
            lastSeenAt: 6000,
            repeatCount: 2,
            steps: [
              { remote: 'origin', ok: true },
              { remote: 'backup', ok: false, message: failure },
            ],
          },
          {
            ...prototype,
            id: 'successful-fetch',
            operation: 'fetch',
            state: 'succeeded' as const,
            message: '',
            startedAt: 5000,
            output: '',
          },
          {
            ...prototype,
            id: 'old-fetch-error',
            operation: 'fetch',
            state: 'failed' as const,
            message: 'QA old network failure',
            startedAt: 3000,
            output: '',
          },
        ]
        return {
          ...value,
          records: records.map((record) => ({
            ...record,
            detailLoaded: query.id === record.id,
            output: query.id === record.id ? record.output : '',
            steps: query.id === record.id && 'steps' in record ? record.steps : undefined,
          })),
        }
      }
    },
    { withFetch },
  )
  await page.clock.fastForward(15001)
  await expect(page.locator('.fetch-status-button')).toContainText('获取失败')
}

test('fetch error status directly opens the recent failure and each remote raw error is collapsed once', async ({
  page,
}, testInfo) => {
  await prepareFetchFailure(page)
  await page.locator('.fetch-status-button').click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await expect(panel.locator('.activity-log-row.selected')).toContainText('部分完成')
  await expect(panel.locator('.activity-log-row.selected')).toContainText('×2')
  const detail = panel.getByRole('region', { name: '操作详情' })
  await expect(detail).toContainText('1 个远端已获取，1 个远端未完成。')
  await expect(detail).toContainText('远端仓库不存在或无法访问，请检查地址与权限。')
  const raw = detail.getByText('fatal: QA backup does not appear to be a git repository', {
    exact: true,
  })
  await expect(raw).toHaveCount(1)
  await expect(raw).not.toBeVisible()
  await detail.getByText('backup 的原始输出', { exact: true }).click()
  await expect(raw).toBeVisible()
  await expect(detail).not.toContainText('QA old network failure')
  await page.screenshot({ path: testInfo.outputPath('fetch-error-detail.png') })
})

test('regular log entry preserves browsing and a missing fetch failure never selects an unrelated push error', async ({
  page,
}) => {
  await prepareFetchFailure(page, false)
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '活动日志', exact: true })
  await expect(panel.getByRole('region', { name: '操作详情' })).not.toBeVisible()
  await panel.getByRole('button', { name: '关闭活动日志' }).click()
  await page.locator('.fetch-status-button').click()
  await expect(panel).toContainText('最近的获取失败记录已被清理或不在保留范围内。')
  await expect(panel.getByRole('region', { name: '操作详情' })).not.toBeVisible()
  await expect(panel.getByRole('button', { name: '手动获取', exact: true })).toBeEnabled()
})
