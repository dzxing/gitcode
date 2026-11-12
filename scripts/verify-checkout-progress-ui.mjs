import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

export async function verifyCheckoutProgress(page, { url, screenshotDirectory } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-checkout-progress-'))
  const git = new GitService()
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Checkout Progress QA'],
      ['user.email', 'checkout-progress@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.qa-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(path.join(repo, 'file.txt'), 'main\n')
    await git.git(repo, ['add', 'file.txt'])
    await git.git(repo, ['commit', '-m', 'main'])
    await git.git(repo, ['switch', '-c', 'topic'])
    await writeFile(path.join(repo, 'file.txt'), 'topic\n')
    await git.git(repo, ['commit', '-am', 'topic'])
    await git.git(repo, ['switch', 'main'])
    await mkdir(path.join(repo, '.qa-hooks'))
    const hook = path.join(repo, '.qa-hooks', 'post-checkout')
    await writeFile(hook, '#!/bin/sh\nprintf running > .git/checkout-progress-hook\nsleep 4\n')
    await chmod(hook, 0o755)
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText(/(?:本机核心|WSL Git 服务)已连接/)
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(dialog).not.toBeVisible()
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await page
      .locator('[data-sidebar-section="local"] [data-branch-name="topic"] .branch-main')
      .dblclick()
    await expect(page.locator('.sidebar-checkout-progress')).toContainText('topic')
    await expect
      .poll(() => readFile(path.join(repo, '.git/checkout-progress-hook'), 'utf8').catch(() => ''))
      .toBe('running')
    await expect(page.locator('.sidebar-content')).toHaveAttribute('inert', '')
    await expect(page.locator('.tab-select').first()).toBeDisabled()
    await expect(page.locator('[aria-label="切换当前分支，当前 main"]')).toBeVisible()
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, 'during-checkout.png') })
    }
    const payload = await (await response).json()
    assert.equal(payload.error, undefined)
    assert.equal(payload.result.outcome, 'succeeded', payload.result.error)
    await expect(page.locator('.sidebar-checkout-progress')).not.toBeVisible()
    await expect(page.locator('[aria-label="切换当前分支，当前 topic"]')).toBeVisible()
    await expect(page.locator('.tab-select').first()).toBeEnabled()
    assert.equal(await git.currentBranch(repo), 'topic')
    assert.equal(await readFile(path.join(repo, 'file.txt'), 'utf8'), 'topic\n')
    if (screenshotDirectory)
      await page.screenshot({ path: path.join(screenshotDirectory, 'checkout-complete.png') })
    return {
      passed: true,
      realGit: true,
      postCheckoutHook: true,
      navigationBlocked: true,
      branchUpdatedAfterSnapshot: true,
    }
  } finally {
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
