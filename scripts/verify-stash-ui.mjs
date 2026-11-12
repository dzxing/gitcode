import { confirmFixtureTrust } from './confirm-fixture-trust.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

export async function verifyStash(page, { url, screenshotDirectory } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-stash-browser-')),
    git = new GitService()
  const write = (file, text) => writeFile(path.join(repo, file), text)
  const panel = () => page.getByRole('region', { name: '贮藏详情', exact: true })
  const diff = () => page.getByRole('region', { name: '文件差异', exact: true })
  const noDialog = () => expect(page.locator('dialog[open]')).toHaveCount(0)
  const close = async () => {
    await panel().getByRole('button', { name: '返回工作区', exact: true }).click()
    await expect(panel()).toHaveCount(0)
  }
  const refresh = async () => {
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(
      page.locator('.toolbar-actions').getByRole('button', { name: '刷新', exact: true }),
    ).toBeEnabled()
  }
  const action = async (click) => {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const payload = await (await pending).json()
    assert.equal(payload.error, undefined, JSON.stringify(payload))
    return payload.result
  }
  const create = async (name, toolbar = true) => {
    await page.getByRole('tab', { name: '贮藏', exact: true }).click()
    await noDialog()
    const form = page.getByRole('form', { name: '贮藏当前修改', exact: true })
    await form.getByRole('textbox', { name: /贮藏名称/ }).fill(name)
    const result = await action(() =>
      toolbar === 'shortcut'
        ? page.keyboard.press('Control+Enter')
        : toolbar
          ? page.getByRole('button', { name: '贮藏当前修改', exact: true }).click()
          : form.getByRole('button', { name: /贮藏/ }).click(),
    )
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    await noDialog()
    await page.getByRole('tab', { name: '提交', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Draft survives stash',
    )
    return result
  }
  const openEntry = async (index) => {
    await page.locator('.stash-row').nth(index).click()
    await expect(panel()).toBeVisible()
    await expect(
      panel().getByRole('button', { name: '查看贮藏文件差异 A.txt', exact: true }),
    ).toBeVisible()
    await noDialog()
  }
  const preview = async (file) => {
    await panel()
      .getByRole('button', { name: `查看贮藏文件差异 ${file}`, exact: true })
      .click()
    await expect(diff()).toBeVisible()
  }
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      if (!(await page.locator('dialog[open]').count())) {
        const notices = page
          .locator('.toast')
          .getByRole('button', { name: '关闭提示', exact: true })
        while (await notices.count()) await notices.first().click()
      }
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Stash UI'],
      ['user.email', 'stash-ui@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    for (const [file, text] of [
      ['A.txt', 'base A\n'],
      ['B.txt', 'base B\n'],
      ['.gitignore', '*.ignored\n'],
    ])
      await write(file, text)
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'Base'])
    const originalHead = await git.head(repo)
    await write('A.txt', 'index A\n')
    await git.git(repo, ['add', 'A.txt'])
    await write('A.txt', 'working A\n')
    await write('B.txt', 'working B\n')
    await write('新增 文件[1].txt', 'untracked new\n')
    await write('keep.ignored', 'ignored remains\n')
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('Git 服务已连接')
    await page.keyboard.press('Control+o')
    await page.getByLabel('仓库路径', { exact: true }).fill(repo)
    await page
      .getByRole('dialog', { name: '打开本地仓库', exact: true })
      .getByRole('button', { name: '打开仓库', exact: true })
      .click()
    await confirmFixtureTrust(page)
    await expect(page.getByRole('dialog', { name: '打开本地仓库', exact: true })).not.toBeVisible()
    await expect(page.locator('.status-path')).toHaveText(repo)
    await page.locator('.commit-select').first().click()
    await expect(page.getByRole('button', { name: '贮藏当前修改', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '贮藏当前修改', exact: true })).toHaveAttribute(
      'title',
      /未提交的更改/,
    )
    await page.locator('.wip-row').click()
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('Draft survives stash')
    await page.getByRole('checkbox', { name: '选择暂存 A.txt', exact: true }).check()
    await page.getByRole('textbox', { name: '筛选工作区文件', exact: true }).fill('A.txt')
    const created = await create('Switch task snapshot')
    assert.equal(created.snapshot.stashes.length, 1)
    assert.equal(created.snapshot.staged.length, 0)
    assert.equal(created.snapshot.unstaged.length, 0)
    assert.equal(created.snapshot.head, originalHead)
    assert.equal(await readFile(repo + '/keep.ignored', 'utf8'), 'ignored remains\n')
    await expect(page.locator('.commit-row')).toHaveCount(1)
    await expect(page.locator('.stash-sidebar-entry')).toHaveCount(1)
    await expect(page.locator('.stash-row')).toHaveCount(1)
    await expect(page.locator(`[data-stash-base="${originalHead}"]`)).toHaveCount(1)
    const graphGeometry = await page.locator('.history-body').evaluate((body) => {
      const stash = body.querySelector('.stash-row').getBoundingClientRect(),
        commit = body.querySelector('.commit-row').getBoundingClientRect(),
        square = body.querySelector('.stash-graph-node rect').getBoundingClientRect(),
        circle = body.querySelector('[data-node-hash] > circle').getBoundingClientRect()
      return {
        stashCenter: stash.y + stash.height / 2,
        nodeCenter: square.y + square.height / 2,
        commitCenter: commit.y + commit.height / 2,
        commitNodeCenter: circle.y + circle.height / 2,
      }
    })
    assert.ok(Math.abs(graphGeometry.stashCenter - graphGeometry.nodeCenter) < 0.6)
    assert.ok(Math.abs(graphGeometry.commitCenter - graphGeometry.commitNodeCenter) < 0.6)
    await capture('workspace-stash')
    await page.locator(`[data-stash-node="${created.snapshot.stashes[0].oid}"]`).click()
    await expect(panel()).toBeVisible()
    await expect(
      panel().getByRole('button', { name: '查看贮藏文件差异 A.txt', exact: true }),
    ).toBeVisible()
    await noDialog()
    await expect(page.locator('.stash-row')).toBeFocused()
    await expect(diff()).toHaveCount(0)
    await expect(page.locator('.wip-row')).toHaveCount(0)
    await expect(page.locator('.stash-row')).toHaveClass(/selected/)
    await expect(page.getByRole('button', { name: '贮藏当前修改', exact: true })).toBeDisabled()
    await preview('A.txt')
    await expect(diff()).toContainText('+working A')
    await diff().getByRole('button', { name: '原暂存内容', exact: true }).click()
    await expect(diff()).toContainText('+index A')
    await diff().getByRole('button', { name: '关闭差异预览', exact: true }).click()
    await expect(diff()).toHaveCount(0)
    await expect(
      panel().getByRole('button', { name: '查看贮藏文件差异 A.txt', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(diff()).toContainText('+working A')
    await diff().getByRole('button', { name: '原暂存内容', exact: true }).click()
    // Inline detail and diff survive a tab round trip; late reads must not own a new tab.
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
    await page
      .locator('.tab-select')
      .filter({ hasText: path.basename(repo) })
      .click()
    await expect(panel()).toBeVisible()
    await expect(diff()).toContainText('+index A')
    await noDialog()
    await preview('新增 文件[1].txt')
    await expect(diff()).toContainText('+untracked new')
    await capture('preview-desktop')
    const geometry = []
    for (const width of [1100, 900]) {
      await page.setViewportSize({ width, height: 1000 })
      const layout = await panel().evaluate((p) => {
        const r = p.getBoundingClientRect(),
          buttons = [...p.querySelectorAll('.stash-restore-buttons button')].map((b) =>
            b.getBoundingClientRect(),
          )
        return {
          width: r.width,
          overflow: p.scrollWidth > p.clientWidth,
          withinViewport: r.right <= innerWidth,
          buttonsOverlap:
            buttons.length === 2 &&
            buttons[0].right > buttons[1].left &&
            buttons[0].top < buttons[1].bottom &&
            buttons[0].bottom > buttons[1].top,
        }
      })
      assert.equal(layout.overflow, false)
      assert.equal(layout.withinViewport, true)
      assert.equal(layout.buttonsOverlap, false)
      geometry.push({ viewport: width, ...layout })
      await capture('preview-' + width)
    }
    await page.setViewportSize({ width: 900, height: 650 })
    const shortButton = panel().getByRole('button', { name: '恢复并移除', exact: true })
    await shortButton.scrollIntoViewIfNeeded()
    await expect(shortButton).toBeInViewport()
    await noDialog()
    await capture('preview-900-short')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await close()
    await noDialog()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Draft survives stash',
    )
    await expect(page.getByLabel('恢复贮藏菜单', { exact: true })).toHaveCount(0)
    // Target changes are checked on execution; dirty state is explained in the panel.
    await write('B.txt', 'new local task\n')
    await refresh()
    await openEntry(0)
    await expect(panel().getByRole('button', { name: '恢复并保留', exact: true })).toBeEnabled()
    await panel().getByRole('button', { name: '恢复并保留', exact: true }).click()
    const consent = panel().getByRole('region', { name: '确认恢复到有修改的工作区', exact: true })
    await expect(consent).toBeVisible()
    await consent.getByRole('button', { name: '取消恢复', exact: true }).click()
    await expect(consent).not.toBeVisible()
    assert.equal(await readFile(repo + '/B.txt', 'utf8'), 'new local task\n')
    await close()
    await write('B.txt', 'base B\n')
    await refresh()
    await openEntry(0)
    await panel().getByRole('checkbox', { name: '恢复原暂存状态', exact: true }).check()
    const applied = await action(() =>
      panel().getByRole('button', { name: '恢复并保留', exact: true }).click(),
    )
    assert.equal(applied.outcome, 'succeeded', JSON.stringify(applied))
    await expect(panel()).toHaveCount(0)
    await noDialog()
    assert.equal(await git.git(repo, ['show', ':A.txt']), 'index A\n')
    assert.equal(await readFile(repo + '/A.txt', 'utf8'), 'working A\n')
    assert.equal(await readFile(repo + '/B.txt', 'utf8'), 'working B\n')
    assert.equal(await readFile(repo + '/新增 文件[1].txt', 'utf8'), 'untracked new\n')
    assert.equal((await git.stash.list(repo)).entries.length, 1)
    await create('Repacked task', false)
    // Only deletion asks for a confirmation; cancelling does not mutate the stash stack.
    await page.locator('.stash-row').nth(1).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除贮藏', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '删除这条贮藏？', exact: true })
    await expect(confirmation).toContainText('Switch task snapshot')
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal((await git.stash.list(repo)).entries.length, 2)
    await noDialog()
    await panel().getByRole('button', { name: '删除贮藏…', exact: true }).click()
    const dropped = await action(() =>
      confirmation.getByRole('button', { name: '删除贮藏', exact: true }).click(),
    )
    assert.equal(dropped.outcome, 'succeeded')
    await expect(page.locator('.stash-sidebar-entry')).toHaveCount(1)
    await noDialog()
    await page.locator('.stash-row').first().click({ button: 'right' })
    const popped = await action(() =>
      page.getByRole('menuitem', { name: '弹出贮藏', exact: true }).click(),
    )
    assert.equal(popped.outcome, 'succeeded', JSON.stringify(popped))
    assert.equal((await git.stash.list(repo)).entries.length, 0)
    await noDialog()
    await expect(panel()).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Draft survives stash',
    )
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'New baseline'])
    await write('A.txt', 'stashed conflict version\n')
    await refresh()
    await create('Conflict backup', 'shortcut')
    await write('A.txt', 'different target version\n')
    await git.git(repo, ['add', 'A.txt'])
    await git.git(repo, ['commit', '-m', 'Other work'])
    const target = await git.head(repo)
    await refresh()
    await openEntry(0)
    await panel().getByRole('checkbox', { name: '恢复原暂存状态', exact: true }).uncheck()
    const conflict = await action(() =>
      panel().getByRole('button', { name: '恢复并移除', exact: true }).click(),
    )
    assert.equal(conflict.outcome, 'partial')
    assert.equal(conflict.snapshot.stashes.length, 1)
    assert.equal(conflict.snapshot.head, target)
    assert.ok(conflict.snapshot.unstaged.some((f) => f.status === 'U'))
    const conflicts = page.getByRole('region', { name: '解决恢复冲突', exact: true })
    await expect(conflicts).toBeVisible()
    await expect(conflicts).toContainText('贮藏记录保留')
    await capture('conflict-retains-stash')
    await conflicts.getByRole('button', { name: '稍后处理', exact: true }).click()
    await expect(page.locator('[data-staging-zone="unstaged"]')).toContainText('A.txt')
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Draft survives stash',
    )
    return {
      realGit: true,
      transport: 'browser-http',
      temporaryRepositoryOnly: true,
      onlyWipSelectionEnablesCreation: true,
      inlineCreationAndDirectToolbar: true,
      inlineShortcutDoesNotCommit: true,
      noDialogsForCreatePreviewApplyOrPop: true,
      onlyDeletionUsesModal: true,
      mutuallyExclusiveHistoryWipAndStashSelection: true,
      diffReusesMainArea: true,
      diffCloseReturnsFileFocus: true,
      shortWindowControlsRemainReachable: true,
      tabRoundTripPreservesStashDiffAndDraft: true,
      entireScopeIndependentOfSelectionAndSearch: true,
      untrackedUnicodeSpacesAndBrackets: true,
      ignoredPreserved: true,
      commitDraftPreserved: true,
      stashExcludedFromOrdinaryCommitCount: true,
      stashGraphNodeConnectedToBase: true,
      restoreAccessibleFromGraphNode: true,
      previewWorkingAndIndex: true,
      dirtyRestoreRequiresInlineConsent: true,
      applyPreservesOriginalIndex: true,
      popDeletesOnlyAfterSuccess: true,
      deleteTargetsSelectedOlderEntry: true,
      conflictPreservesStashAndHead: true,
      geometry,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
