import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// A source-only base is deliberately outside the target branch's ancestry.
// Stash visibility and recovery must work without inventing branch ownership.
export async function verifyStashRepositoryScope(page, { url, screenshotDirectory } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-stash-scope-')),
    git = new GitService()
  const panel = () => page.getByRole('region', { name: '贮藏详情', exact: true })
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      const notices = page.locator('.toast').getByRole('button', { name: '关闭提示', exact: true })
      while (await notices.count()) await notices.first().click()
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  const action = async (click) => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const payload = await (await response).json()
    assert.equal(payload.error, undefined)
    assert.equal(payload.result.outcome, 'succeeded', JSON.stringify(payload.result))
    return payload.result
  }
  try {
    await git.git(repo, ['init', '-b', 'feature/source'])
    for (const [key, value] of [
      ['user.name', 'Stash scope test'],
      ['user.email', 'stash-scope@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(repo + '/A.txt', 'base\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'Common base'])
    const targetHead = await git.head(repo)
    await git.git(repo, ['branch', 'feature/target', targetHead])
    await writeFile(repo + '/source-only.txt', 'source branch only\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'Source-only base'])
    const sourceBase = await git.head(repo)
    await writeFile(repo + '/A.txt', 'cross-branch stash content\n')
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    await expect(page.locator('.status-path')).toHaveAttribute('title', repo)
    await page.getByRole('tab', { name: '贮藏', exact: true }).click()
    await page
      .getByRole('form', { name: '贮藏当前修改', exact: true })
      .getByRole('textbox', { name: /贮藏名称/ })
      .fill('仓库共享验证')
    const created = await action(() =>
        page.getByRole('button', { name: '贮藏当前修改', exact: true }).click(),
      ),
      entry = created.snapshot.stashes[0]
    assert.equal(entry.base, sourceBase)
    assert.equal(entry.branch, 'feature/source')
    assert.notEqual(sourceBase, targetHead)
    const row = () => page.locator(`[data-stash-oid="${entry.oid}"]`)
    await expect(row()).toBeVisible()
    await expect(page.locator(`[data-stash-base="${sourceBase}"]`)).toHaveCount(1)
    const stashX =
      Number(await page.locator(`[data-stash-node="${entry.oid}"] rect`).getAttribute('x')) + 6
    const baseX = Number(
      await page.locator(`[data-node-hash="${sourceBase}"] > circle`).first().getAttribute('cx'),
    )
    assert.equal(
      stashX,
      baseX,
      'A free corridor must align the stash with its base instead of reserving an outer track',
    )
    await capture('stash-aligned-with-base')
    const beforeGraph = await page.locator('.stash-base-edge').getAttribute('d')
    await page.locator('.branch-selector > summary').click()
    await action(() =>
      page
        .locator('.branch-dropdown')
        .getByRole('button', { name: 'feature/target', exact: true })
        .click(),
    )
    await expect(page.locator('.branch-selector strong')).toHaveText('feature/target')
    await expect(row()).toBeVisible()
    await expect(page.locator(`[data-stash-base="${sourceBase}"]`)).toHaveCount(1)
    assert.equal(
      await page.locator('.stash-base-edge').getAttribute('d'),
      beforeGraph,
      'Checking out another branch must not change the base connection',
    )
    // The author column is not a creation-branch column, and sidebar rows have no branch ownership badge.
    assert.equal((await row().locator('.author-cell').textContent()).trim(), '')
    await expect(page.locator('.stash-sidebar-entry > small')).toHaveCount(0)
    await page
      .locator('[data-sidebar-section="local"] [data-branch-name="feature/target"] .branch-main')
      .click()
    await expect(page.locator('.filter-banner')).toContainText('feature/target')
    await expect(page.locator(`[data-node-hash="${sourceBase}"]`)).toHaveCount(0)
    await expect(row()).toBeVisible()
    await expect(page.locator(`[data-stash-base="${sourceBase}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-stash-base="${targetHead}"]`)).toHaveCount(0)
    await expect(page.locator('.stash-graph-node title')).toContainText('不在当前视图')
    await expect(page.locator('.stash-sidebar-entry')).toHaveCount(1)
    await capture('branch-filter-retains-stash')
    await row().click()
    await expect(panel()).toContainText('创建时分支 feature/source')
    await expect(panel()).toContainText('仓库共享记录，可恢复到其他分支')
    await expect(panel().locator('.stash-target')).toContainText('feature/target')
    await expect(panel().getByRole('button', { name: '恢复并保留', exact: true })).toBeEnabled()
    await panel().getByRole('button', { name: '查看贮藏文件差异 A.txt', exact: true }).click()
    await expect(page.getByRole('region', { name: '文件差异', exact: true })).toContainText(
      '+cross-branch stash content',
    )
    await capture('cross-branch-restore-target')
    const refsBefore = (await git.snapshot(repo)).branches.map((b) => [b.name, b.hash]).sort()
    const restored = await action(() =>
      panel().getByRole('button', { name: '恢复并保留', exact: true }).click(),
    )
    assert.equal(restored.snapshot.branch, 'feature/target')
    assert.equal(restored.snapshot.head, targetHead)
    assert.equal(await readFile(repo + '/A.txt', 'utf8'), 'cross-branch stash content\n')
    assert.equal(restored.snapshot.stashes[0].oid, entry.oid)
    assert.deepEqual(restored.snapshot.branches.map((b) => [b.name, b.hash]).sort(), refsBefore)
    assert.equal(await git.git(repo, ['show', 'feature/source:A.txt']), 'base\n')
    assert.equal(restored.snapshot.staged.length, 0)
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await capture('restored-on-other-branch')
    return {
      realGit: true,
      temporaryRepositoryOnly: true,
      creationBranch: 'feature/source',
      recoveryBranch: 'feature/target',
      sourceBase,
      targetHead,
      stashOid: entry.oid,
      checkoutKeepsBaseConnection: true,
      branchFilterDoesNotHideRepositoryStash: true,
      missingBaseKeepsBoundaryWithoutRetargeting: true,
      creationBranchIsMetadataOnly: true,
      crossBranchApplyRestoresContents: true,
      branchReferencesAndTargetHeadUnchanged: true,
      applyRetainsRecord: true,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
