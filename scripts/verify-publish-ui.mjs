import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')
export async function verifyPublish(page, { url, custom = false, screenshotDirectory } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-first-push-')),
    repo = path.join(root, 'local'),
    bare = path.join(root, 'origin.git'),
    backup = path.join(root, 'backup.git'),
    git = new GitService()
  await mkdir(repo)
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  const action = async (click) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
      ),
      click(),
    ])
    const value = await response.json()
    assert.equal(value.error, undefined)
    return value.result
  }
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [k, v] of [
      ['user.name', 'Publish UI'],
      ['user.email', 'publish-ui@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
      ['gitflow.branch.master', 'main'],
      ['gitflow.branch.develop', 'develop'],
      ['gitflow.prefix.feature', 'feature/'],
      ['gitflow.prefix.release', 'release/'],
      ['gitflow.prefix.hotfix', 'hotfix/'],
      ['gitflow.prefix.versiontag', ''],
    ])
      await git.git(repo, ['config', k, v])
    await writeFile(repo + '/base.txt', 'base\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'base'])
    const base = await git.head(repo)
    await git.git(repo, ['branch', 'develop'])
    await git.git(repo, ['init', '--bare', bare])
    await git.git(repo, ['remote', 'add', 'origin', bare])
    await git.git(repo, ['push', '-u', 'origin', 'main'])
    if (custom) {
      await git.git(repo, ['init', '--bare', backup])
      await git.git(repo, ['remote', 'add', 'backup', backup])
    }
    await page.goto(url)
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
    const flow = page.locator('.gitflow-panel')
    await flow.getByRole('button', { name: '开始新分支…', exact: true }).click()
    await flow.getByLabel('分支名称', { exact: true }).fill('dev1.0.1')
    const created = await action(() =>
      flow.getByRole('button', { name: '创建并切换', exact: true }).click(),
    )
    assert.equal(created.outcome, 'succeeded', created.error)
    await flow.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    if (custom) {
      const switched = await action(() =>
        page
          .locator('[data-sidebar-section="local"] [data-branch-name="main"] .branch-main')
          .dblclick(),
      )
      assert.equal(switched.outcome, 'succeeded')
    }
    const show = async () => {
      if (custom) {
        await page
          .locator(
            '[data-sidebar-section="local"] [data-branch-name="feature/dev1.0.1"] .branch-main',
          )
          .click({ button: 'right' })
        await page.getByRole('menuitem', { name: '推送', exact: true }).click()
      } else
        await page
          .locator('.toolbar-actions')
          .getByRole('button', { name: '推送', exact: true })
          .click()
    }
    await show()
    const dialog = page.getByRole('dialog', { name: '推送指定分支', exact: true })
    await expect(dialog.getByRole('region', { name: '首次推送目标', exact: true })).toBeVisible()
    await expect(dialog.getByLabel('远程', { exact: true })).toHaveValue('origin')
    await expect(dialog.getByLabel('远端分支', { exact: true })).toHaveValue('feature/dev1.0.1')
    await expect(dialog.getByRole('button', { name: '创建并推送', exact: true })).toBeEnabled()
    await capture('first-push-target')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(
      (
        await git.git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/dev1.0.1'])
      ).trim(),
      '',
    )
    assert.equal(
      (
        await git.git(repo, ['config', '--get', 'branch.feature/dev1.0.1.remote'], {
          allowedCodes: [0, 1],
        })
      ).trim(),
      '',
    )
    await show()
    await expect(dialog.getByRole('button', { name: '创建并推送', exact: true })).toBeEnabled()
    let destination = 'feature/dev1.0.1',
      remote = bare,
      expected = 'origin/feature/dev1.0.1'
    if (custom) {
      destination = 'review/dev1.0.1'
      remote = backup
      expected = 'backup/' + destination
      await dialog.getByLabel('远程', { exact: true }).selectOption('backup')
      await expect(dialog.getByLabel('远端分支', { exact: true })).toBeEnabled()
      await dialog.getByLabel('远端分支', { exact: true }).fill(destination)
      await expect(dialog.getByRole('button', { name: '创建并推送', exact: true })).toBeDisabled()
      await dialog.getByLabel('远端分支', { exact: true }).press('Enter')
      await expect(dialog.getByRole('button', { name: '创建并推送', exact: true })).toBeEnabled()
      await capture('confirmed-custom-target')
    }
    const pushed = await action(() =>
      dialog.getByRole('button', { name: '创建并推送', exact: true }).click(),
    )
    assert.equal(pushed.outcome, 'succeeded', JSON.stringify(pushed))
    assert.equal(
      pushed.snapshot.branches.find((b) => b.kind === 'local' && b.name === 'feature/dev1.0.1')
        .upstream,
      expected,
    )
    assert.equal(pushed.snapshot.branch, custom ? 'main' : 'feature/dev1.0.1')
    assert.equal((await git.git(remote, ['rev-parse', 'refs/heads/' + destination])).trim(), base)
    await expect(dialog).not.toBeVisible()
    await capture('published-and-linked')
    await show()
    await expect(dialog.getByRole('button', { name: '推送', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('region', { name: '首次推送目标', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    return {
      custom,
      gitflowStartThenPush: true,
      cancelWritesNothing: true,
      sourceBranchPreserved: true,
      published: true,
      upstream: expected,
      subsequentPushUsesExistingTarget: true,
      privateRemoteContacted: false,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
