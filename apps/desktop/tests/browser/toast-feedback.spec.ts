import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

const raw =
  "Error invoking remote method 'gitcode:snapshot': Error: 读取仓库失败。\n    at GitService.snapshot (C:\\GitCode\\app.asar\\electron\\git.cjs:42:7)\n    at async invoke (node:internal/process/task_queues:95:5)"

test('operation toast summarizes the IPC error and preserves expandable, selectable details while reading', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate((message) => {
    window.gitcode!.snapshot = async () => {
      throw new Error(message)
    }
  }, raw)
  await page.clock.install()
  await page.locator('.toolbar-actions').getByRole('button', { name: '刷新', exact: true }).click()
  const toast = page.locator('.toast.error').filter({ hasText: '读取仓库失败。' })
  await expect(toast).toBeVisible()
  await expect(toast.locator('pre')).not.toBeVisible()
  await expect(toast.locator('.toast-content')).toContainText('读取仓库失败。')
  await toast.locator('summary').click()
  await expect(toast.locator('pre')).toHaveText(raw)
  await expect(toast.locator('pre')).toBeVisible()
  await page.clock.fastForward(10_000)
  await expect(toast).toBeVisible()
  expect(await toast.locator('pre').evaluate((node) => getComputedStyle(node).userSelect)).toBe(
    'text',
  )
  await toast.locator('summary').click()
  await page.clock.fastForward(10_000)
  await expect(toast).toHaveCount(0)
})

test('operation errors with a journal entry retain the log link and their failure appearance', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(async (message) => {
    const snapshot = await window.gitcode!.snapshot('/test-fixtures/repository')
    window.gitcode!.action = async () => ({
      outcome: 'failed',
      output: '',
      error: message,
      logId: 'toast-native-log',
      snapshot,
    })
  }, raw)
  await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('QA failed operation')
  await page.getByRole('button', { name: /提交 \d+ 个文件/ }).click()
  const toast = page.locator('.toast.error').filter({ hasText: '读取仓库失败。' })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: '查看日志', exact: true })).toBeVisible()
  await expect(toast.locator('pre')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
    'QA failed operation',
  )
})
