import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

test('分支选择器支持筛选、方向键与 Esc，只有确认后才执行受保护检出', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate((initial) => {
    Object.assign(window, { pickerActions: [] })
    window.gitk!.action = async (_repo, request) => {
      if (request.action !== 'checkout') throw new Error('unexpected action')
      ;(window as unknown as { pickerActions: string[] }).pickerActions.push(request.name!)
      const snapshot = structuredClone(initial)
      snapshot.path = '/test-fixtures/repository'
      snapshot.branch = request.name!
      snapshot.head = snapshot.branches.find((branch) => branch.name === request.name)!.hash
      snapshot.branches.forEach((branch) => {
        branch.current = branch.kind === 'local' && branch.name === request.name
      })
      return { outcome: 'succeeded', output: '', snapshot }
    }
  }, repositoryFixture)
  await page.getByRole('button', { name: '切换当前分支，当前 main', exact: true }).click()
  const input = page.getByRole('searchbox', { name: '筛选本地分支', exact: true })
  await expect(input).toBeFocused()
  await input.fill('DEVEL')
  await input.press('ArrowDown')
  const choice = page
    .getByRole('dialog', { name: '切换本地分支', exact: true })
    .getByRole('button', { name: 'develop', exact: true })
  await expect(choice).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: '切换当前分支，当前 main', exact: true }),
  ).toBeFocused()
  expect(
    await page.evaluate(() => (window as unknown as { pickerActions: string[] }).pickerActions),
  ).toEqual([])
  await page.locator('.branch-selector summary').click()
  await input.fill('no-such-branch')
  await expect(page.getByText('没有匹配的本地分支', { exact: true })).toBeVisible()
  await input.fill('develop')
  await input.press('Enter')
  await expect(
    page.getByRole('button', { name: '切换当前分支，当前 develop', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { pickerActions: string[] }).pickerActions),
  ).toEqual(['develop'])
})

test('中键与 Ctrl+F4 关闭标签仍保护草稿，Ctrl+Tab 切换保留输入', async ({ page }) => {
  await openFixtureRepository(page)
  await page.getByLabel('提交说明', { exact: true }).fill('preserve draft')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.keyboard.press('Control+Tab')
  await expect(page.getByLabel('提交说明', { exact: true })).toHaveValue('preserve draft')
  await page.locator('.repo-tab.active').click({ button: 'middle' })
  const confirm = page.getByRole('dialog', { name: '关闭这个仓库标签？', exact: true })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '保留标签', exact: true }).click()
  await page.keyboard.press('Control+F4')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '保留标签', exact: true }).click()
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
})

test('右键关闭其他标签统一确认，取消不改变活动标签，确认保留目标标签', async ({ page }) => {
  await openFixtureRepository(page)
  await page.getByLabel('提交说明', { exact: true }).fill('close others draft')
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  const tabs = page.locator('.repo-tab')
  await tabs.nth(1).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '标签页操作', exact: true })
  await menu.getByRole('menuitem', { name: '关闭其他标签', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '关闭这 2 个标签？', exact: true })
  await expect(confirm).toBeVisible()
  await expect(tabs).toHaveCount(3)
  await confirm.getByRole('button', { name: '保留标签', exact: true }).click()
  await expect(tabs.nth(2)).toHaveClass(/active/)
  await tabs.nth(1).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '关闭其他标签', exact: true }).click()
  await confirm.getByRole('button', { name: '丢弃草稿并关闭', exact: true }).click()
  await expect(tabs).toHaveCount(1)
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
})

test('分隔条双击只恢复对应面板，另一个面板宽度继续保存', async ({ page }) => {
  await openFixtureRepository(page)
  const left = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  const right = page.getByRole('separator', { name: '调整详情面板宽度', exact: true })
  await left.focus()
  await page.keyboard.press('ArrowRight')
  await right.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.sidebar')).toHaveCSS('width', '260px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '340px')
  await left.dblclick()
  await expect(page.locator('.sidebar')).toHaveCSS('width', '250px')
  await expect(page.locator('.inspector')).toHaveCSS('width', '340px')
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.panel-widths')!)),
  ).toEqual({ inspector: 340 })
  await right.dblclick()
  await expect(page.locator('.inspector')).toHaveCSS('width', '330px')
})

test('浏览器中可复制路径，文件管理器入口明确禁用；菜单支持键盘与边界定位', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => Object.assign(window, { copiedLocation: text }) },
    }),
  )
  const path = page.getByRole('button', { name: '复制仓库路径', exact: true })
  await path.click()
  expect(
    await page.evaluate(() => (window as unknown as { copiedLocation: string }).copiedLocation),
  ).toBe('/test-fixtures/repository')
  await path.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: '仓库位置操作', exact: true })
  await expect(
    menu.getByRole('menuitem', { name: '在文件管理器中显示', exact: true }),
  ).toBeDisabled()
  const bounds = await menu.boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000)
  await page.locator('.sidebar').dispatchEvent('scroll')
  await expect(menu).toBeHidden()
  await path.focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(path).toBeFocused()
})

test('桌面位置入口传递当前仓库与限定动作', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[][] = []
    Object.assign(window, { locationCalls: calls })
    window.gitkApp = {
      repositoryLocation: async (repo, action) => {
        calls.push([repo, action])
      },
      setMenuState: async () => {},
      edit: async () => {},
      requestQuit: async () => {},
      acknowledgeClose: async () => true,
      approveClose: async () => true,
      cancelClose: async () => {},
      info: async () => ({ name: 'GitCode', version: '1.0.1', electron: '45', platform: 'win32' }),
      onCommand: () => () => {},
      onCloseRequested: () => () => {},
    }
  })
  await openFixtureRepository(page)
  const path = page.getByRole('button', { name: '复制仓库路径', exact: true })
  await path.click()
  await path.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在文件管理器中显示', exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as { locationCalls: string[][] }).locationCalls),
  ).toEqual([
    ['/test-fixtures/repository', 'copy-path'],
    ['/test-fixtures/repository', 'show-folder'],
  ])
})
