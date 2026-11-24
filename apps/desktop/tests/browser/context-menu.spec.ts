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
  await expect(
    menu.getByRole('menuitem', { name: '在修订版中显示仓库', exact: true }),
  ).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^切换到 / })).toHaveCount(0)
  await expect(selected).toHaveClass(/selected/)
  await menu.getByRole('menuitem', { name: '在修订版中显示仓库', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '在修订版中显示仓库', exact: true })).toBeVisible()
  await expect(selected).toHaveClass(/selected/)
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
    window.gitcode!.stashRead = async () => ({
      files: [],
      stagedPaths: [],
      base: 'a'.repeat(40),
      diff: null,
    })
    window.gitcode!.action = async () => {
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
      await label.hover()
      await expect(label).toHaveAttribute('title', `重命名 ${name}`)
    }
    await page.keyboard.press('Escape')
  }
})

test('commit menu keeps its complete order while HEAD and root restrictions are greyed', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const head = page.locator(`[data-commit-hash="${repositoryFixture.head}"]`)
  await head.click({ button: 'right' })
  const menu = page.getByRole('menu')
  const labels = await menu.getByRole('menuitem').allTextContents()
  expect(labels).toHaveLength(21)
  await expect(menu.getByRole('menuitem', { name: '与本地比较', exact: true })).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: '撤销提交…', exact: true })).toBeEnabled()
  await expect(
    menu.getByRole('menuitem', { name: '从这里进行交互式变基…', exact: true }),
  ).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: '转到子提交', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page
    .locator(`[data-commit-hash="${repositoryFixture.commits.at(-1)!.hash}"]`)
    .click({ button: 'right' })
  expect(await menu.getByRole('menuitem').allTextContents()).toEqual(labels)
  await expect(menu.getByRole('menuitem', { name: '转到父提交', exact: true })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '转到子提交', exact: true })).toBeEnabled()
  await page.screenshot({ path: 'design/commit-context-menu/root-menu.png' })
})

test('parent and child navigation preserve the right-click target and let users choose merge ancestry', async ({
  page,
}) => {
  await openFixtureRepository(page)
  const merge = repositoryFixture.commits[1]!
  await page.locator(`[data-commit-hash="${merge.hash}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '转到父提交', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: '选择父提交', exact: true })
  await expect(chooser).toBeVisible()
  await expect(chooser.locator('.commit-jump-choice')).toHaveCount(2)
  const target = merge.parents[1]!
  await chooser
    .locator('.commit-jump-choice')
    .filter({ hasText: target.slice(0, 8) })
    .click()
  await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', target)
  await expect(chooser).not.toBeVisible()
  await page.locator(`[data-commit-hash="${target}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '转到子提交', exact: true }).click()
  await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', merge.hash)
})

test('comparison and undo entries invoke existing preflight with the frozen commit, never another selected row', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  snapshot.branches = snapshot.branches.filter((b) => b.kind !== 'remote')
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    window.gitcode!.navigationRead = async (_repo, request) => {
      document.documentElement.dataset.commitCompare = JSON.stringify(request)
      return {
        fullRef: request.fullRef,
        referenceOid: request.expectedOid,
        oid: request.expectedOid,
        head: request.expectedHead,
        branch: request.expectedBranch,
        related: true,
        alreadyMerged: false,
        canFastForward: false,
        files: [],
        diff: null,
      }
    }
    window.gitcode!.commitOperationRead = async () => {
      throw new Error('Read-only fixture confirms preflight was requested')
    }
  })
  const target = repositoryFixture.commits[2]!
  await page.locator(`[data-commit-hash="${target.hash}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '与本地比较', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '与工作区比较', exact: true })).toBeVisible()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.commitCompare!),
  )
  expect(request.fullRef).toBe(target.hash)
  expect(request.expectedHead).toBe(repositoryFixture.head)
  await page.getByRole('button', { name: '关闭导航操作', exact: true }).click()
  await page.locator(`[data-commit-hash="${repositoryFixture.head}"]`).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '撤销提交…', exact: true })).toBeEnabled()
  await page.getByRole('menuitem', { name: '撤销提交…', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '撤销提交', exact: true })).toBeVisible()
  await expect(
    page.getByText('Read-only fixture confirms preflight was requested', { exact: true }),
  ).toBeVisible()
})

test('undo preview rejects a HEAD that moved after the commit menu was clicked', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  snapshot.branches = snapshot.branches.filter((branch) => branch.kind !== 'remote')
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    window.gitcode!.commitOperationRead = async () => ({
      id: 'stale-plan',
      head: 'f'.repeat(40),
      branch: 'main',
      commits: [],
    })
  })
  await page.locator(`[data-commit-hash="${snapshot.head}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '撤销提交…', exact: true }).click()
  await expect(
    page.getByText('提交操作计划与当前上下文不一致，请关闭后重新打开。', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '撤回最近提交', exact: true })).toHaveCount(0)
})

test('parent navigation loads an unloaded SHA and leaves the target clear of the sticky header', async ({
  page,
}) => {
  const snapshot = structuredClone(repositoryFixture)
  const parent = { ...snapshot.commits[1]!, parents: [] }
  snapshot.commits = [{ ...snapshot.commits[0]!, parents: [parent.hash] }]
  snapshot.total = 2
  const history = {
    token: 'menu-page',
    signature: 'menu-page',
    basis: '',
    focus: null,
    nextOffset: 1,
    total: 2,
  }
  snapshot.history = history
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(
    ({ parent, history }) => {
      window.gitcode!.historyRead = async (_repo, request) => {
        document.documentElement.dataset.menuLocatedSha = request.sha
        return { commits: [parent], history: { ...history, focus: parent.hash, nextOffset: null } }
      }
    },
    { parent, history },
  )
  await page.locator('.commit-row').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '转到父提交', exact: true }).click()
  await expect(page.locator('.commit-row.selected')).toHaveAttribute(
    'data-commit-hash',
    parent.hash,
  )
  expect(await page.evaluate(() => document.documentElement.dataset.menuLocatedSha)).toBe(
    parent.hash,
  )
  const target = await page.locator('.commit-row.selected').boundingBox()
  const header = await page.locator('.table-head').boundingBox()
  expect(target!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 0.5)
})
