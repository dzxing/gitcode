import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')

test.setTimeout(60000)
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-live-observation-'))
  const repo = path.join(directory, '中文 worktree'),
    git = new GitService()
  await fs.mkdir(path.join(repo, 'src'), { recursive: true })
  await git.git(repo, ['init', '-b', 'qa/first'])
  for (const [key, value] of [
    ['user.name', 'External QA'],
    ['user.email', 'external@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', key, value])
  await fs.writeFile(path.join(repo, 'src', 'file.txt'), 'base\n')
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'baseline'])
  await git.git(repo, ['branch', 'qa/other'])
  return {
    directory,
    repo,
    git,
    dispose: async () => {
      await git.shutdown()
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}
async function open(page: Page, repo: string) {
  let armed = false
  page.on('response', async (response) => {
    try {
      if (response.request().postDataJSON()?.method === 'repository-changes') {
        const value = await response.json()
        if (value.result?.watched > 0) armed = true
      }
    } catch {
      /* Non-RPC responses. */
    }
  })
  await page.addInitScript(() => localStorage.removeItem('gitcode.workspaceSession.v1'))
  await page.goto('/')
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
  await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
  await page
    .getByRole('dialog', { name: '信任此仓库？', exact: true })
    .getByRole('button', { name: '信任并打开', exact: true })
    .click()
  await expect(page.locator('.repo-selector')).toHaveAttribute('title', '打开本地仓库：' + repo)
  await expect.poll(() => armed, { timeout: 15000 }).toBe(true)
}

test('real browser watches external file changes while preserving the draft, focus and diff scroll', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    const input = page.getByRole('textbox', { name: '提交说明', exact: true })
    await input.fill('Keep this commit draft')
    await input.evaluate((node: HTMLInputElement) => {
      node.focus()
      node.setSelectionRange(3, 7)
    })
    const file = path.join(f.repo, 'src', 'file.txt')
    const lines = Array.from({ length: 160 }, (_, i) => 'external line ' + i).join('\n') + '\n'
    await fs.writeFile(file, lines)
    const row = page.locator('.file-main[data-file-path="src/file.txt"][data-file-staged="false"]')
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(input).toHaveValue('Keep this commit draft')
    await expect(input).toBeFocused()
    expect(
      await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd]),
    ).toEqual([3, 7])
    await row.click()
    await expect(page.locator('.diff-scroll')).toContainText('external line 159')
    await page.locator('.diff-scroll').evaluate((node) => {
      const host = window as unknown as { savedDiffNode: Element }
      host.savedDiffNode = node
      node.scrollTop = 200
    })
    const index = await f.git.indexFingerprint(f.repo)
    await fs.writeFile(file, lines + 'external second save\n')
    await expect(page.locator('.diff-scroll')).toContainText('external second save', {
      timeout: 15000,
    })
    expect(
      await page
        .locator('.diff-scroll')
        .evaluate(
          (node) => node === (window as unknown as { savedDiffNode: Element }).savedDiffNode,
        ),
    ).toBe(true)
    expect(
      await page.locator('.diff-scroll').evaluate((node) => node.scrollTop),
    ).toBeGreaterThanOrEqual(180)
    expect(await f.git.indexFingerprint(f.repo)).toBe(index)
    await fs.rename(file, path.join(f.repo, 'src', 'renamed.txt'))
    await expect(page.locator('.file-main[data-file-path="src/renamed.txt"]')).toBeVisible({
      timeout: 15000,
    })
    await fs.unlink(path.join(f.repo, 'src', 'renamed.txt'))
    await expect(page.locator('.file-main[data-file-path="src/renamed.txt"]')).toHaveCount(0, {
      timeout: 15000,
    })
    await fs.mkdir(path.join(f.repo, 'new', 'deep'), { recursive: true })
    await fs.writeFile(path.join(f.repo, 'new', 'deep', 'new.txt'), 'new external file\n')
    await expect(page.locator('.file-main[data-file-path="new/deep/new.txt"]')).toBeVisible({
      timeout: 15000,
    })
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('terminal staging, commits and checkout update the graph while keeping commit text', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    const input = page.getByRole('textbox', { name: '提交说明', exact: true })
    await input.fill('Keep draft across external checkout')
    await fs.writeFile(path.join(f.repo, 'src', 'file.txt'), 'terminal edit\n')
    await expect(
      page.locator('.file-main[data-file-path="src/file.txt"][data-file-staged="false"]'),
    ).toBeVisible({ timeout: 15000 })
    await f.git.git(f.repo, ['add', 'src/file.txt'])
    await expect(
      page.locator('.file-main[data-file-path="src/file.txt"][data-file-staged="true"]'),
    ).toBeVisible({ timeout: 15000 })
    await f.git.git(f.repo, ['commit', '-m', 'external terminal commit'])
    await expect(page.locator('.history-panel')).toContainText('external terminal commit', {
      timeout: 15000,
    })
    await expect(input).toHaveValue('Keep draft across external checkout')
    await f.git.git(f.repo, ['switch', 'qa/other'])
    await expect(page.locator('.branch-selector summary')).toContainText('qa/other', {
      timeout: 15000,
    })
    await expect(input).toHaveValue('Keep draft across external checkout')
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('external conflict edits preserve the manual result and require explicit reread before resolving', async ({
  page,
}) => {
  const f = await fixture()
  try {
    const file = path.join(f.repo, 'src', 'file.txt')
    await f.git.git(f.repo, ['switch', '-c', 'qa/incoming'])
    await fs.writeFile(file, 'incoming side\n')
    await f.git.git(f.repo, ['commit', '-am', 'incoming'])
    await f.git.git(f.repo, ['switch', 'qa/first'])
    await fs.writeFile(file, 'current side\n')
    await f.git.git(f.repo, ['commit', '-am', 'current'])
    await f.git.git(f.repo, ['merge', 'qa/incoming'], { allowedCodes: [0, 1] })
    await open(page, f.repo)
    await page.locator('.conflict-file-name').click()
    const editor = page.getByRole('textbox', { name: '编辑合并结果', exact: true })
    await editor.fill('My unsaved manual result\n')
    const index = await f.git.indexFingerprint(f.repo)
    await fs.writeFile(file, 'external editor saved this\n')
    await expect(page.getByRole('region', { name: '冲突解决编辑器', exact: true })).toContainText(
      '文件或合并状态已变化',
      { timeout: 15000 },
    )
    await expect(editor).toHaveValue('My unsaved manual result\n')
    await expect(page.getByRole('button', { name: '保存并标记已解决', exact: true })).toBeDisabled()
    expect(await fs.readFile(file, 'utf8')).toBe('external editor saved this\n')
    expect(await f.git.indexFingerprint(f.repo)).toBe(index)
  } finally {
    await page.close()
    await f.dispose()
  }
})
