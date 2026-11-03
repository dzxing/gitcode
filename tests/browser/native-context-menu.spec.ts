import { expect, test, type Page } from '@playwright/test'
import type { NativeMenuItem } from '../../src/services/contextMenu'
import { openFixtureRepository } from './repository-fixture'

type NativeTestWindow = Window & {
  nativeRequests: { requestId: number; items: NativeMenuItem[] }[]
  nativeResolves: Record<number, (value: string | null) => void>
  nativeClosed: number[]
}
async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeRequests = []
    host.nativeResolves = {}
    host.nativeClosed = []
    window.gitkContextMenu = {
      popup: (request) => {
        host.nativeRequests.push(request)
        return new Promise((resolve) => {
          host.nativeResolves[request.requestId] = resolve
        })
      },
      close: async (id) => {
        host.nativeClosed.push(id)
      },
    }
  })
}
const develop = (page: Page) =>
  page.locator('[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main')

test('desktop uses one native menu with ordered groups and dispatches the chosen object', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await expect(page.getByRole('menu')).toHaveCount(0)
  const items = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[0]!.items,
  )
  const ids = items.flatMap((item) => ('id' in item ? [item.id] : []))
  expect(ids.slice(0, 3)).toEqual(['branch-pull', 'branch-push', 'set-upstream'])
  expect(ids).not.toContain('locate')
  expect(ids).not.toContain('history')
  expect(ids.indexOf('delete-branch')).toBeLessThan(ids.indexOf('copy-name'))
  expect(items[0]).not.toHaveProperty('type', 'separator')
  await expect(page.locator('.wip-row')).toHaveClass(/selected/)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('rename-branch')
  })
  const dialog = page.getByRole('dialog', { name: '重命名分支', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('新分支名称', { exact: true })).toHaveValue('develop')
})

test('dismissing native menus restores focus without creating a web menu', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await expect(develop(page)).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a stale native selection cannot execute after opening another menu', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page
    .locator('[data-sidebar-section="local"] [data-branch-name="main"] .branch-main')
    .click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(2)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('delete-branch')
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const closed = await page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed)
  expect(closed).toContain(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[1]!.requestId]!(null)
  })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('unavailable native menus fall back to the browser menu', async ({ page }) => {
  await page.addInitScript(() => {
    window.gitkContextMenu = {
      popup: async () => {
        throw new Error('unavailable')
      },
      close: async () => {},
    }
  })
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '切换到 develop', exact: true })).toBeEnabled()
})

test('a native selection cannot execute after leaving its repository tab', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed.length))
    .toBe(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('delete-branch')
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('native checkout directly attempts the named branch with frozen reference guards', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.action = async (_repo, request) => {
      document.documentElement.dataset.nativeCheckout = JSON.stringify(request)
      throw new Error('Read-only fixture rejects the attempt')
    }
  })
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  const labels = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[0]!.items.flatMap((item) =>
      'label' in item ? [item.label] : [],
    ),
  )
  expect(labels).toContain('切换到 develop')
  expect(labels).toContain('重命名 develop')
  expect(labels).toContain('删除 develop')
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('checkout')
  })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.nativeCheckout))
    .toBeTruthy()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.nativeCheckout!),
  )
  expect(request.action).toBe('checkout')
  expect(request.name).toBe('develop')
  expect(request.expectedBranch).toBe('main')
  expect(request.expectedOid).toMatch(/^[a-f0-9]{40}$/)
  await expect(page.getByRole('dialog', { name: '切换分支', exact: true })).toHaveCount(0)
  await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
})
