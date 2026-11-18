import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import type { TerminalRequest } from '../../src/terminalTypes'

async function fixture(page: Page) {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const sessions = new Map<string, { output: string; repo: string }>()
    let next = 0
    const events: TerminalRequest[] = []
    Object.assign(window, { terminalEvents: events })
    window.gitk!.gitConsole = async () => ({
      epoch: 'test-console',
      cursor: 0,
      entries: [],
      running: [],
      more: false,
      reset: false,
      dropped: false,
    })
    window.gitk!.terminal = async (repo, request) => {
      events.push(request)
      if (request.action === 'shells') return { shells: [{ id: 'default', label: 'Bash' }] }
      if (request.action === 'create') {
        const id = `terminal-${++next}`
        sessions.set(id, { output: `Session ${next}\r\n$ `, repo })
        return { id, shell: 'Bash' }
      }
      const session = sessions.get(request.id)
      if (!session || session.repo !== repo) throw Error('Unexpected terminal owner')
      if (request.action === 'close') {
        sessions.delete(request.id)
        return
      }
      if (request.action === 'read')
        return {
          data: session.output.slice(request.cursor),
          cursor: session.output.length,
          state: 'running',
          more: false,
        }
      if (request.action === 'write') session.output += request.data
      return undefined
    }
  })
}
async function events(page: Page, action: string) {
  return page.evaluate(
    (action) =>
      (window as unknown as { terminalEvents: TerminalRequest[] }).terminalEvents.filter(
        (event) => event.action === action,
      ),
    action,
  )
}

test('terminal hides without killing, reuses sessions and preserves Shell shortcut input', async ({
  page,
}) => {
  await fixture(page)
  const panel = page.getByRole('region', { name: '终端面板', exact: true })
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await page.locator('.terminal-screen textarea').press('Control+r')
  await expect.poll(async () => (await events(page, 'write')).length).toBeGreaterThan(0)
  expect(await events(page, 'create')).toHaveLength(1)
  await page.keyboard.press('Control+Backquote')
  await expect(panel).not.toBeVisible()
  expect(await events(page, 'close')).toHaveLength(0)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(panel).toBeVisible()
  expect(await events(page, 'create')).toHaveLength(1)
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(3)
  await panel.getByRole('button', { name: '关闭终端 2', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  expect(await events(page, 'close')).toHaveLength(1)
})

test('bulk terminal close asks once and cancellation keeps all sessions', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.getByRole('region', { name: '终端面板', exact: true })
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(3)
  await panel.getByRole('button', { name: '关闭当前仓库的所有终端', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '关闭终端', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(await events(page, 'close')).toHaveLength(0)
  await panel.getByRole('button', { name: '关闭当前仓库的所有终端', exact: true }).click()
  await dialog.getByRole('button', { name: '关闭终端', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Git 控制台面板', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Git 控制台', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await events(page, 'close')).toHaveLength(2)
})

test('closing a repository tab ends its terminal sessions', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(page.getByRole('region', { name: '终端面板', exact: true })).toBeVisible()
  await page.locator('.tab-close').click()
  await expect.poll(async () => (await events(page, 'close')).length).toBe(1)
  await expect(page.getByRole('region', { name: '终端面板', exact: true })).not.toBeVisible()
})

test('console and numbered terminals remain peers; switching never closes or recreates shells', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  const consoleTab = panel.getByRole('tab', { name: 'Git 控制台', exact: true })
  const first = panel.getByRole('tab', { name: /终端 1/ })
  await expect(consoleTab).toBeVisible()
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await consoleTab.click()
  await expect(first).toBeVisible()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('.terminal-screen')).not.toBeVisible()
  await first.click()
  await expect(panel.locator('.terminal-screen')).toBeVisible()
  expect(await events(page, 'create')).toHaveLength(1)
  expect(await events(page, 'close')).toHaveLength(0)
  await consoleTab.click()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(4)
  await expect(panel.getByRole('tab', { name: /终端 3/ })).toHaveAttribute('aria-selected', 'true')
  await consoleTab.click()
  await panel.getByRole('button', { name: '关闭终端 2', exact: true }).click()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: /终端 3/ })).toBeVisible()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  const fourth = panel.getByRole('tab', { name: /终端 4/ })
  await expect(fourth).toHaveAttribute('aria-selected', 'true')
  await fourth.press('Home')
  await expect(consoleTab).toBeFocused()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await consoleTab.press('End')
  await expect(fourth).toHaveAttribute('aria-selected', 'true')
  await expect(fourth).toBeFocused()
  expect(await events(page, 'create')).toHaveLength(4)
  expect(await events(page, 'close')).toHaveLength(1)
})

test('whole tab surface selects and hovers; close remains an independent target', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  const consoleTab = panel.getByRole('tab', { name: 'Git 控制台', exact: true })
  const first = panel.getByRole('tab', { name: /终端 1/ })
  const firstBox = await first.locator('..').boundingBox()
  if (!firstBox) throw Error('Terminal tab missing')
  for (const [x, y] of [
    [firstBox.x + firstBox.width / 2, firstBox.y + 1],
    [firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height - 1],
    [firstBox.x + 1, firstBox.y + firstBox.height / 2],
    [firstBox.x + firstBox.width - 1, firstBox.y + firstBox.height / 2],
  ]) {
    await consoleTab.click()
    await page.mouse.click(x, y)
    await expect(first).toHaveAttribute('aria-selected', 'true')
  }
  await consoleTab.click()
  await page.mouse.move(firstBox.x + firstBox.width - 1, firstBox.y + firstBox.height / 2)
  await expect.poll(() => first.evaluate((button) => button.matches(':hover'))).toBe(true)
  const consoleBox = await consoleTab.locator('..').boundingBox()
  if (!consoleBox) throw Error('Console tab missing')
  await first.click()
  await page.mouse.click(consoleBox.x + consoleBox.width / 2, consoleBox.y + consoleBox.height - 1)
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  expect(await events(page, 'close')).toHaveLength(0)
  await panel.getByRole('button', { name: '关闭终端 1', exact: true }).click()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: /终端 2/ })).toBeVisible()
  expect(await events(page, 'close')).toHaveLength(1)
  const height = await panel.evaluate((node) => node.getBoundingClientRect().height)
  const handle = await panel.getByRole('separator', { name: '调整工具窗口高度' }).boundingBox()
  if (!handle) throw Error('Resize handle missing')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 30)
  await page.mouse.up()
  await expect
    .poll(() => panel.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(height + 20)
})
