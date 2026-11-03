import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')
export async function verifyPushStates(page, { url, screenshotDirectory } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-push-states-')),
    repo = path.join(root, 'local'),
    bare = path.join(root, 'remote.git'),
    git = new GitService()
  const capture = async (name) => {
    if (!screenshotDirectory) return
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
  }
  try {
    await mkdir(repo)
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'State test'],
      ['user.email', 'state@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(repo + '/base.txt', 'base\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'base'])
    const base = await git.head(repo)
    await git.git(repo, ['init', '--bare', bare])
    await git.git(repo, ['remote', 'add', 'origin', bare])
    await git.git(repo, ['push', '-u', 'origin', 'main'])
    await git.git(repo, ['switch', '-c', 'feature/states'])
    await writeFile(repo + '/feature.txt', 'local work\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'feature'])
    const tip = await git.head(repo)
    await git.git(repo, ['push', 'origin', `${base}:refs/heads/feature/states`])
    await page.goto(url)
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    const show = async () =>
      page.locator('.toolbar-actions').getByRole('button', { name: '推送', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '推送指定分支', exact: true })
    const cancel = async () => dialog.getByRole('button', { name: '取消', exact: true }).click()
    await show()
    await expect(dialog.getByRole('status')).toContainText('1 个提交')
    await expect(dialog.getByRole('button', { name: '推送并关联', exact: true })).toBeEnabled()
    await capture('existing-target')
    await cancel()
    // An unavailable push endpoint must never become a "create branch" state.
    await git.git(repo, ['remote', 'set-url', '--push', 'origin', root + '/unavailable.git'])
    await show()
    await expect(dialog.getByRole('status')).toContainText('未能确认远端状态')
    await expect(dialog.getByRole('button', { name: '推送并关联', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('远端分支', { exact: true })).toHaveValue('feature/states')
    await capture('check-failed')
    await cancel()
    await git.git(repo, ['remote', 'set-url', '--push', 'origin', bare])
    // Changing the destination invalidates the old check immediately. Enter checks it.
    await show()
    await expect(dialog.getByRole('button', { name: '推送并关联', exact: true })).toBeEnabled()
    await dialog.getByLabel('远端分支', { exact: true }).fill('review/new-target')
    await expect(dialog.getByRole('button', { name: '推送并关联', exact: true })).toBeDisabled()
    await dialog.getByLabel('远端分支', { exact: true }).press('Enter')
    await expect(dialog.getByRole('button', { name: '创建并推送', exact: true })).toBeEnabled()
    await cancel()
    // Associate the existing target and then verify deleted tracking targets explicitly.
    await show()
    await expect(dialog.getByRole('button', { name: '推送并关联', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '推送并关联', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/feature/states'])).trim(), tip)
    await git.git(bare, ['update-ref', '-d', 'refs/heads/feature/states'])
    await show()
    await expect(dialog.getByRole('status')).toContainText('已被删除')
    await expect(dialog.getByRole('button', { name: '重新创建并推送', exact: true })).toBeEnabled()
    await capture('tracked-target-deleted')
    await cancel()
    return {
      existingTarget: true,
      failureBlocksPush: true,
      editingInvalidatesCheck: true,
      deletedTargetWarned: true,
      temporaryRepositoriesOnly: true,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
