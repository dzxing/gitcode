import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')
export async function verifyDeleteBranch(page, { url, screenshotDirectory } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-delete-branch-')),
    git = new GitService()
  const capture = async (name) => {
    if (!screenshotDirectory) return
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
  }
  const action = async (click) => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const value = await (await response).json()
    assert.equal(value.error, undefined)
    return value.result
  }
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Delete test'],
      ['user.email', 'delete@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(repo + '/base.txt', 'base\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'base'])
    const base = await git.head(repo)
    await git.git(repo, ['switch', '-c', 'feature/unmerged-test'])
    await writeFile(repo + '/feature.txt', 'unique work\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'unique commit'])
    const tip = await git.head(repo)
    await git.git(repo, ['switch', 'main'])
    await page.goto(url)
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    const row = page.locator(
      '[data-sidebar-section="local"] [data-branch-name="feature/unmerged-test"]',
    )
    const show = async () => {
      await row.locator('.branch-main').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除 feature/unmerged-test', exact: true }).click()
    }
    await show()
    const dialog = page.getByRole('dialog', { name: '删除本地分支', exact: true })
    await expect(dialog).toContainText('未合并的独有提交')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    assert.equal(
      (await git.git(repo, ['rev-parse', 'refs/heads/feature/unmerged-test'])).trim(),
      tip,
    )
    await capture('unmerged-confirmation')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(row).toBeVisible()
    await show()
    await capture('explicit-deletion')
    const deleted = await action(() =>
      dialog.getByRole('button', { name: '确认删除本地分支', exact: true }).click(),
    )
    assert.equal(deleted.outcome, 'succeeded', deleted.error)
    await expect(dialog).not.toBeVisible()
    await expect(row).toHaveCount(0)
    assert.equal(await git.head(repo), base)
    assert.equal(await git.currentBranch(repo), 'main')
    return {
      explicitConfirmationDeletesUnmerged: true,
      cancellationPreservesBranch: true,
      currentBranchUnchanged: true,
      temporaryRepositoryOnly: true,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
