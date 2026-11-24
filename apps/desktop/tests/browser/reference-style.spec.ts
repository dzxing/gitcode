import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
const styles = [
  { id: 'current', name: 'GitCode 风格' },
  { id: 'gitkraken', name: 'GitKraken 风格' },
  { id: 'idea', name: 'IDEA 风格' },
]
async function openStyles(page: import('@playwright/test').Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitem', { name: '分支标签样式', exact: true }).click()
  return page.getByRole('menu', { name: '分支标签样式', exact: true })
}
async function choose(page: import('@playwright/test').Page, name: string) {
  const menu = await openStyles(page)
  await menu.getByRole('menuitemradio', { name, exact: true }).click()
}
test('首次打开默认标签靠右并采用 GitKraken 风格，已有选择继续保留', async ({ page }) => {
  await openFixtureRepository(page)
  const panel = page.locator('.history-panel')
  await expect(panel).toHaveClass(/labels-after-message/)
  await expect(panel).toHaveAttribute('data-label-style', 'gitkraken')
  const menu = await openStyles(page)
  await expect(
    menu.getByRole('menuitemradio', { name: 'GitKraken 风格', exact: true }),
  ).toBeChecked()
  await page.keyboard.press('Escape')
  await page.getByRole('menuitem', { name: '分支标签位置', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: '提交说明后', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await choose(page, 'GitCode 风格')
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitem', { name: '分支标签位置', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '关系图左侧', exact: true }).click()
  await openFixtureRepository(page)
  await expect(panel).not.toHaveClass(/labels-after-message/)
  await expect(panel).toHaveAttribute('data-label-style', 'current')
})
for (const right of [false, true])
  test(`三种标签样式独立于位置且保留操作 (${right ? 'right' : 'left'})`, async ({ page }) => {
    await page.addInitScript(
      (after) => localStorage.setItem('gitcode.graph-labels-after-message', String(after)),
      right,
    )
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const snapshot = structuredClone(repositoryFixture)
    snapshot.branches.push({
      name: 'dev',
      hash: snapshot.head,
      current: false,
      upstream: '',
      track: '',
      kind: 'local',
    })
    await openFixtureRepository(page, false, snapshot)
    for (const style of styles) {
      await choose(page, style.name)
      const panel = page.locator('.history-panel')
      await expect(panel).toHaveAttribute('data-label-style', style.id)
      expect((await panel.getAttribute('class'))!.includes('labels-after-message')).toBe(right)
      const row = page.locator(`[data-commit-hash="${snapshot.head}"]`)
      const badge = row.locator('.ref-labels-content .reference-badge')
      await expect(badge).toHaveClass(new RegExp(`label-style-${style.id}`))
      await expect(row).toHaveCSS('height', '30px')
      await row.locator('.ref-more').click()
      await expect(page.getByRole('dialog', { name: '提交引用', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await row.locator('.ref-labels-content .ref-primary').click({ button: 'right' })
      await expect(page.getByRole('menu')).toHaveAccessibleName('main 右键菜单')
      await page.keyboard.press('Escape')
      await page.mouse.move(1200, 90)
      await page.getByRole('textbox', { name: '搜索提交', exact: true }).focus()
      await page.screenshot({
        path: `design/reference-style-comparison/gitcode-${style.id}-${right ? 'right' : 'left'}.png`,
      })
      const menu = await openStyles(page)
      await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
      await expect(
        menu.getByRole('menuitemradio', { name: style.name, exact: true }),
      ).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
  })
test('样式刷新记忆、键盘子菜单范围和最近仓库菜单正常', async ({ page }) => {
  await openFixtureRepository(page)
  await choose(page, 'IDEA 风格')
  await openFixtureRepository(page)
  await expect(page.locator('.history-panel')).toHaveAttribute('data-label-style', 'idea')
  const menu = await openStyles(page)
  await expect(menu.getByRole('menuitemradio', { name: 'IDEA 风格', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitemradio', { name: 'GitCode 风格', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitemradio', { name: 'IDEA 风格', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('menuitem', { name: '分支标签样式', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('menubar').getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: '最近仓库', exact: true }).click()
  await expect(page.getByRole('menu', { name: '最近仓库', exact: true })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('menuitem', { name: '最近仓库', exact: true })).toBeFocused()
})
test('原生菜单命令更新同一渲染状态和持久化选择', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as {
      styleCommand: (id: string) => void
      styleMenuState: { labelStyle?: string }
    }
    window.gitcodeApp = {
      setMenuState: async (state) => {
        host.styleMenuState = state
      },
      edit: async () => {},
      requestQuit: async () => {},
      acknowledgeClose: async () => true,
      approveClose: async () => true,
      cancelClose: async () => {},
      info: async () => ({ name: 'GitCode', version: '1.0.1', electron: '45', platform: 'win32' }),
      onCommand: (handler) => {
        host.styleCommand = handler
        return () => {}
      },
      onCloseRequested: () => () => {},
    }
  })
  await openFixtureRepository(page)
  await page.evaluate(() => {
    ;(window as unknown as { styleCommand: (id: string) => void }).styleCommand(
      'view.labelStyle.gitkraken',
    )
  })
  await expect(page.locator('.history-panel')).toHaveAttribute('data-label-style', 'gitkraken')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { styleMenuState: { labelStyle?: string } }).styleMenuState
            ?.labelStyle,
      ),
    )
    .toBe('gitkraken')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.graph-label-style'))).toBe(
    'gitkraken',
  )
})
