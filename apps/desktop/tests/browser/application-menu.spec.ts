import { openFixtureRepository } from './repository-fixture'
import { expect, test } from '@playwright/test'

async function mockApplication(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = []
    ;(window as any).appCalls = calls
    window.gitcodeApp = {
      setMenuState: async () => {},
      edit: async (command) => {
        calls.push(['edit', command])
        document.execCommand(command)
      },
      requestQuit: async () => {
        ;(window as any).closeRequested?.(7)
      },
      acknowledgeClose: async (id) => {
        calls.push(['ack', id])
        return true
      },
      approveClose: async (id) => {
        calls.push(['approve', id])
        return true
      },
      cancelClose: async (id) => {
        calls.push(['cancel', id])
      },
      info: async () => ({ name: 'GitCode', version: '0.1.0', electron: '45', platform: 'linux' }),
      onCommand: (handler) => {
        ;(window as any).appCommand = handler
        return () => {}
      },
      onCloseRequested: (handler) => {
        ;(window as any).closeRequested = handler
        return () => {}
      },
    }
  })
}

test('application menus invoke existing actions and keep tab draft protection', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const menubar = page.getByRole('menubar', { name: '应用菜单' })
  await expect(menubar.getByRole('menuitem')).toHaveCount(5)
  await page.getByLabel('提交说明', { exact: true }).fill('keep my draft')
  await menubar.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page
    .getByRole('menu', { name: '文件', exact: true })
    .getByRole('menuitem', { name: /关闭当前标签/ })
    .click()
  await expect(page.getByRole('dialog', { name: '关闭这个仓库标签？' })).toBeVisible()
  await page.getByRole('button', { name: '保留标签', exact: true }).click()
  await page.getByLabel('提交说明', { exact: true }).focus()
  await page.keyboard.press('Alt+v')
  await page.getByRole('menuitemcheckbox', { name: '显示提交 SHA', exact: true }).click()
  await expect(page.locator('.history-panel')).toHaveClass(/show-sha/)
  await page.keyboard.press('Control+w')
  await expect(page.getByRole('dialog', { name: '关闭这个仓库标签？' })).toBeVisible()
})

test('Edit restores the original text field and selection before native editing', async ({
  page,
}) => {
  await mockApplication(page)
  await openFixtureRepository(page)
  const input = page.getByLabel('提交说明', { exact: true })
  await input.fill('some commit draft')
  await input.evaluate((node: HTMLInputElement) => {
    node.focus()
    node.setSelectionRange(2, 7)
  })
  await page.getByRole('menuitem', { name: '编辑 Edit', exact: true }).click()
  await page
    .getByRole('menu', { name: '编辑', exact: true })
    .getByRole('menuitem', { name: /全选文本/ })
    .click()
  await expect(input).toBeFocused()
  expect(
    await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd]),
  ).toEqual([0, 'some commit draft'.length])
  expect(await page.evaluate(() => (window as any).appCalls)).toContainEqual(['edit', 'selectAll'])
})

test('window close guards inactive tab drafts and requires explicit discard approval', async ({
  page,
}) => {
  await mockApplication(page)
  await openFixtureRepository(page)
  await page.getByLabel('提交说明', { exact: true }).fill('inactive draft')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.evaluate(() => (window as any).closeRequested(17))
  const dialog = page.getByRole('dialog', { name: '退出 GitCode？', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '退出 GitCode', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '留在应用', exact: true }).click()
  expect(await page.evaluate(() => (window as any).appCalls)).toContainEqual(['cancel', 17])
  await page.evaluate(() => (window as any).closeRequested(18))
  await dialog.getByRole('checkbox', { name: '确认丢弃这些说明草稿' }).check()
  await dialog.getByRole('button', { name: '退出 GitCode', exact: true }).click()
  expect(await page.evaluate(() => (window as any).appCalls)).toContainEqual(['approve', 18])
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gitcode.commitDraft.v1:/test-fixtures/repository')!),
    ),
  ).toEqual({ message: '', description: '' })
})

test('commit description and title recover on reload without sharing text with a new tab', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.getByLabel('提交说明', { exact: true }).fill('recover this title')
  await page.getByRole('button', { name: /详细说明/ }).click()
  await page.getByLabel('提交详细说明', { exact: true }).fill('recover this body')
  await page.reload()
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  await expect(page.getByLabel('提交说明', { exact: true })).toHaveValue('recover this title')
  await expect(page.getByLabel('提交详细说明', { exact: true })).toHaveValue('recover this body')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
})

test('native View reset command reaches the same panel layout handler', async ({ page }) => {
  await mockApplication(page)
  await openFixtureRepository(page)
  const divider = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.sidebar')).toHaveCSS('width', '260px')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.panel-widths'))).not.toBeNull()
  await page.evaluate(() => {
    ;(window as unknown as { appCommand: (id: string) => void }).appCommand('view.resetLayout')
  })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '250px')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.panel-widths'))).toBeNull()
})
