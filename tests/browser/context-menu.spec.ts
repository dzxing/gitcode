import { repositoryFixture } from '../fixtures/repository'
import { openFixtureRepository } from './repository-fixture'
import { expect, test } from '@playwright/test'

test('branch and commit menus target the right-clicked object without changing selection', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const selected = page.locator('.wip-row')
  await expect(selected).toHaveClass(/selected/)
  await page
    .locator('.branch-main')
    .filter({ hasText: 'develop' })
    .first()
    .click({ button: 'right' })
  let menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAccessibleName('develop 右键菜单')
  await expect(menu.locator('.context-menu-heading, .context-menu-context')).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /创建分支/ })).toBeEnabled()
  await expect(selected).toHaveClass(/selected/)
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(page.locator('.branch-main').filter({ hasText: 'develop' }).first()).toBeFocused()

  const row = page.locator('.commit-row').nth(2)
  await row.locator('.commit-select').click({ button: 'right' })
  menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: '查看提交详情', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^切换到 / })).toHaveCount(0)
  await expect(selected).toHaveClass(/selected/)
  await menu.getByRole('menuitem', { name: '查看提交详情', exact: true }).click()
  await expect(row).toHaveClass(/selected/)
})

test('reference labels, keyboard invocation, columns and menu edges work', async ({ page }) => {
  await openFixtureRepository(page)
  await page.locator('.ref-tag').first().click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: '复制分支名', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  const header = page.getByLabel('历史列表显示列', { exact: true })
  await header.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemcheckbox', { name: 'SHA', exact: true }).click()
  await expect(page.locator('.history-panel')).toHaveClass(/show-sha/)
  await page.locator('.history-scroll').click({ button: 'right', position: { x: 800, y: 700 } })
  const bounds = await page.getByRole('menu').boundingBox()
  const viewport = page.viewportSize()!
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).not.toBeVisible()
})

test('current branch hides checkout/delete while another branch keeps both', async ({ page }) => {
  await openFixtureRepository(page)
  const local = page.locator('[data-sidebar-section="local"]')
  await local.locator('[data-branch-name="main"] .branch-main').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /^切换到 / })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /^删除 / })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: '推送', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await local.locator('[data-branch-name="develop"] .branch-main').click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: /^切换到 / })).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: /^删除 / })).toBeEnabled()
})

test('pull without upstream opens a target chooser instead of a dead-end error', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page
    .locator(
      '[data-sidebar-section="local"] [data-branch-name="feature/commit-graph"] .branch-main',
    )
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '拉取', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置上游分支', exact: true })
  await expect(dialog).toBeVisible()
  const select = dialog.getByLabel('远程上游分支', { exact: true })
  await expect(select).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
  await select.selectOption('refs/remotes/origin/develop')
  await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

test('no remote hides sync entries and an occupied branch offers its worktree', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  snapshot.remotes = []
  snapshot.branches.find((b) => b.name === 'develop' && b.kind === 'local')!.worktreePath =
    '/test-fixtures/linked'
  await openFixtureRepository(page, false, snapshot)
  await page
    .locator('[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main')
    .click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('menuitem', { name: '打开 develop 所在工作区', exact: true }),
  ).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: /^切换到 / })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /^删除 / })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /推送|拉取|设置上游/ })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: '复制分支名', exact: true })).toBeEnabled()
})

test('stash pop with unstaged changes asks for consent inline and cancel performs no write', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  snapshot.staged = []
  snapshot.unstaged = [{ path: 'local.txt', status: '?' }]
  snapshot.stashSignature = 'fixture-stash'
  snapshot.stashes = [
    {
      ref: 'stash@{0}',
      oid: 'b'.repeat(40),
      message: 'On main: menu test',
      date: '2026-11-02T00:00:00Z',
      branch: 'main',
      base: snapshot.head,
    },
  ]
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    window.gitk!.stashRead = async () => ({
      files: [],
      stagedPaths: [],
      base: 'a'.repeat(40),
      diff: null,
    })
    window.gitk!.action = async () => {
      document.documentElement.dataset.unexpectedStashWrite = 'true'
      throw new Error('Unexpected write')
    }
  })
  await page.locator('.stash-sidebar-entry').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '弹出贮藏', exact: true })).toBeEnabled()
  await page.getByRole('menuitem', { name: '弹出贮藏', exact: true }).click()
  const confirm = page.getByRole('region', { name: '确认恢复到有修改的工作区' })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('贮藏记录会保留')
  await expect(
    confirm.getByRole('button', { name: '继续恢复，成功后移除', exact: true }),
  ).toBeEnabled()
  await confirm.getByRole('button', { name: '取消恢复', exact: true }).click()
  await expect(confirm).not.toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.dataset.unexpectedStashWrite),
  ).toBeUndefined()
})

test('long branch menu labels stay on one line, grow naturally and fit the viewport', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  const moderate = 'feature/graph-1029-014615-notify'
  const extreme = 'feature/' + 'very-long-branch-name-'.repeat(18)
  const source = snapshot.branches.find((branch) => branch.kind === 'local' && !branch.current)!
  snapshot.branches.push(
    { ...source, name: moderate, fullRef: `refs/heads/${moderate}` },
    { ...source, name: extreme, fullRef: `refs/heads/${extreme}` },
  )
  await openFixtureRepository(page, false, snapshot)
  for (const name of [moderate, extreme]) {
    await page
      .locator(`[data-sidebar-section="local"] [data-branch-name="${name}"] .branch-main`)
      .click({ button: 'right' })
    const menu = page.getByRole('menu')
    const label = menu
      .getByRole('menuitem', { name: `重命名 ${name}`, exact: true })
      .locator('.context-menu-label')
    await expect(label).toHaveCSS('white-space', 'nowrap')
    const geometry = await label.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(element)
      // Mixed fonts and the ellipsis can create several rectangles on one line.
      const lineTops: number[] = []
      for (const fragment of range.getClientRects()) {
        if (!lineTops.some((top) => Math.abs(top - fragment.top) < 4)) lineTops.push(fragment.top)
      }
      return {
        height: rect.height,
        lines: lineTops.length,
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }
    })
    expect(geometry.lines).toBe(1)
    const bounds = (await menu.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(8)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width - 7)
    if (name === moderate) {
      expect(bounds.width).toBeGreaterThan(264)
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1)
    } else {
      expect(geometry.scroll).toBeGreaterThan(geometry.client)
      await expect(label).toHaveCSS('text-overflow', 'ellipsis')
      await expect(label.locator('..')).toHaveAttribute('title', `重命名 ${name}`)
    }
    await page.keyboard.press('Escape')
  }
})
