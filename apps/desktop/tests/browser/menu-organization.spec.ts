import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

test('仓库菜单保持位置、文本编辑独立，当前仓库设置标明对象', async ({ page }) => {
  await openFixtureRepository(page)
  const bar = page.getByRole('menubar', { name: '应用菜单' })
  await expect(bar.getByRole('menuitem')).toHaveText(['文件', '编辑', '视图', '仓库', '帮助'])
  await page.keyboard.press('Alt+r')
  const menu = page.getByRole('menu', { name: '仓库', exact: true })
  await expect(menu.getByRole('menuitem')).toHaveText([
    '获取',
    '拉取',
    '推送',
    'Git 操作恢复…',
    '当前仓库设置…',
  ])
  await menu.getByRole('menuitem', { name: '当前仓库设置…', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('tabpanel')).toContainText('/test-fixtures/repository')
  await page.keyboard.press('Escape')
  await bar.getByRole('menuitem', { name: '编辑 Edit', exact: true }).click()
  await expect(
    page.getByRole('menu', { name: '编辑', exact: true }).getByRole('menuitem'),
  ).toHaveText([/撤销文本编辑/, /重做文本编辑/, /剪切/, /复制/, /粘贴/, /全选文本/])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.keyboard.press('Alt+r')
  for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeDisabled()
  await expect(bar.getByRole('menuitem')).toHaveCount(5)
})

for (const [name, kind] of [
  ['获取', 'fetch'],
  ['拉取', 'pull'],
  ['推送', 'push'],
] as const) {
  test(`仓库菜单${name}复用同步计划，前置检查失败不执行命令`, async ({ page }) => {
    await openFixtureRepository(page)
    await page.evaluate(() => {
      const calls: string[][] = []
      Object.assign(window, { menuSyncCalls: calls, menuWriteCalls: 0 })
      window.gitcode!.syncPlan = async (repo, kind) => {
        calls.push([repo, kind])
        throw new Error('菜单验证：前置检查未通过')
      }
      window.gitcode!.action = async () => {
        Object.assign(window, { menuWriteCalls: 1 })
        throw new Error('不应执行')
      }
    })
    await page.keyboard.press('Alt+r')
    await page
      .getByRole('menu', { name: '仓库', exact: true })
      .getByRole('menuitem', { name, exact: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { menuSyncCalls: string[][] }).menuSyncCalls),
      )
      .toEqual([['/test-fixtures/repository', kind]])
    await expect(page.getByText(/菜单验证：前置检查未通过/).first()).toBeVisible()
    expect(
      await page.evaluate(() => (window as unknown as { menuWriteCalls: number }).menuWriteCalls),
    ).toBe(0)
  })
}

test('读取仓库状态时允许修改显示设置，仓库操作仍拦截', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const original = window.gitcode!.snapshot
    window.gitcode!.snapshot = async (...args) => {
      await new Promise<void>((resolve) => Object.assign(window, { finishMenuRefresh: resolve }))
      return original(...args)
    }
  })
  await page.keyboard.press('Control+r')
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { finishMenuRefresh?: () => void }).finishMenuRefresh,
      ),
    )
    .toBe('function')
  await page.keyboard.press('Alt+r')
  await expect(
    page
      .getByRole('menu', { name: '仓库', exact: true })
      .getByRole('menuitem', { name: '推送', exact: true }),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Alt+v')
  await page.getByRole('menuitemcheckbox', { name: '显示提交 SHA', exact: true }).click()
  await expect(page.locator('.history-panel')).toHaveClass(/show-sha/)
  await page.evaluate(() =>
    (window as unknown as { finishMenuRefresh: () => void }).finishMenuRefresh(),
  )
  await page.keyboard.press('Alt+r')
  await expect(
    page
      .getByRole('menu', { name: '仓库', exact: true })
      .getByRole('menuitem', { name: '推送', exact: true }),
  ).toBeEnabled()
  await page.screenshot({ path: 'design/menu-organization/repository-menu.png' })
})
