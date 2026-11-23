import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')

test('approved repository opens after reload and in a new browser session without a trust dialog', async ({
  page,
  browser,
  baseURL,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-trust-ui-'))
  const repo = path.join(root, 'repo')
  const git = new GitService({ dataDirectory: path.join(root, 'setup') })
  let approvals = 0
  page.on('request', (r) => {
    if (
      r.url().endsWith('/__gitcode/rpc') &&
      r.postDataJSON().method === 'repository-trust-approve'
    )
      approvals++
  })
  const trust = page.getByRole('dialog', { name: '信任此仓库？', exact: true })
  try {
    await fs.mkdir(repo)
    await git.git(repo, ['init', '-b', 'qa/base'])
    await git.git(repo, ['config', 'user.name', 'Trust UI'])
    await git.git(repo, ['config', 'user.email', 'trust@example.invalid'])
    await page.goto('/')
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByRole('button', { name: '浏览…', exact: true }).click()
    const browserPicker = page.getByRole('dialog', { name: '选择 Git 仓库', exact: true })
    await browserPicker.getByLabel('目录地址', { exact: true }).fill(repo)
    await browserPicker.getByLabel('目录地址', { exact: true }).press('Enter')
    await expect(browserPicker.locator('.directory-footer strong')).toHaveText(repo)
    await browserPicker.getByRole('button', { name: '选择仓库目录', exact: true }).click()
    await expect(open.getByLabel('仓库路径', { exact: true })).toHaveValue(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(trust).toBeVisible()
    await expect(trust).toContainText('此选择会保存在本机，重启后仍然有效')
    await trust.getByRole('button', { name: '信任并打开', exact: true }).click()
    await expect(trust).not.toBeVisible()
    await expect(page.locator('.branch-selector summary strong')).toHaveText('qa/base')
    await page.reload()
    await expect(page.locator('.branch-selector summary strong')).toHaveText('qa/base')
    await expect(trust).not.toBeVisible()
    expect(approvals).toBe(1)
    const context = await browser.newContext()
    try {
      const fresh = await context.newPage()
      await fresh.goto(baseURL!)
      await expect(fresh.locator('#operation-status')).toContainText('已连接')
      await fresh.keyboard.press('Control+o')
      const openFresh = fresh.getByRole('dialog', { name: '打开本地仓库', exact: true })
      await openFresh.getByLabel('仓库路径', { exact: true }).fill(repo)
      await openFresh.getByRole('button', { name: '打开仓库', exact: true }).click()
      await expect(fresh.locator('.branch-selector summary strong')).toHaveText('qa/base')
      await expect(
        fresh.getByRole('dialog', { name: '信任此仓库？', exact: true }),
      ).not.toBeVisible()
      await fresh.screenshot({ path: 'design/trust-persistence/new-session.png' })
    } finally {
      await context.close()
    }
  } finally {
    await page.close()
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  }
})
