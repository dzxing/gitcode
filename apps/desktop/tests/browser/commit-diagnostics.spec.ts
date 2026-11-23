import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')

async function fixture() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-commit-ui-中文-'))
  const git = new GitService()
  await git.git(repo, ['init', '-b', 'qa/hooks'])
  for (const [key, value] of [
    ['user.name', 'Commit UI QA'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.git/QA hooks'],
  ])
    await git.git(repo, ['config', key, value])
  await fs.mkdir(path.join(repo, '.git', 'QA hooks'))
  await fs.writeFile(path.join(repo, 'file.txt'), 'baseline\n')
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'baseline'])
  const head = await git.head(repo)
  await fs.writeFile(path.join(repo, 'file.txt'), 'staged edit\n')
  await git.git(repo, ['add', 'file.txt'])
  return {
    repo,
    git,
    head,
    hook: (name: string, body: string) =>
      fs.writeFile(path.join(repo, '.git', 'QA hooks', name), '#!/bin/sh\n' + body + '\n', {
        mode: 0o755,
      }),
    dispose: async () => {
      await git.shutdown()
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}
async function open(page: Page, repo: string) {
  await page.addInitScript(() => localStorage.removeItem('gitcode.workspaceSession.v1'))
  await page.goto('/')
  await expect(page.locator('#operation-status')).toContainText('已连接', { timeout: 15000 })
  await page.keyboard.press('Control+o')
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
  await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
  await page
    .getByRole('dialog', { name: '信任此仓库？', exact: true })
    .getByRole('button', { name: '信任并打开', exact: true })
    .click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('Keep attempted commit')
}
const submit = (page: Page) => page.getByRole('button', { name: /提交 \d+ 个文件/ }).click()

test('failed formatter keeps draft, actual staged content and formatted worktree; log link opens the matching hook output', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.hook(
      'pre-commit',
      "printf 'formatter edit\\n' > file.txt\nprintf 'QA_BROWSER_FORMATTER\\n' >&2\nexit 1",
    )
    await open(page, f.repo)
    await page.getByRole('button', { name: '详细说明（可选）', exact: true }).click()
    await page
      .getByRole('textbox', { name: '提交详细说明', exact: true })
      .fill('Keep detailed explanation')
    await submit(page)
    const toast = page.locator('.toast.error').filter({ hasText: '提交被 pre-commit Hook 阻止' })
    await expect(toast).toBeVisible()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Keep attempted commit',
    )
    await expect(page.getByRole('textbox', { name: '提交详细说明', exact: true })).toHaveValue(
      'Keep detailed explanation',
    )
    expect(await f.git.head(f.repo)).toBe(f.head)
    expect(await f.git.git(f.repo, ['show', ':file.txt'])).toBe('staged edit\n')
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe('formatter edit\n')
    await expect(page.locator('.file-main[data-file-path="file.txt"]')).toHaveCount(2)
    await toast.getByRole('button', { name: '查看日志', exact: true }).click()
    const log = page.getByRole('dialog', { name: '活动日志', exact: true })
    await expect(log.locator('.activity-log-detail')).toContainText('pre-commit：退出码 1')
    await expect(log.locator('.activity-log-detail')).toContainText('QA_BROWSER_FORMATTER')
    expect(
      (await log.locator('.activity-log-detail').innerText()).split('QA_BROWSER_FORMATTER'),
    ).toHaveLength(2)
    await page.screenshot({ path: 'design/commit-diagnostics/01-browser-hook-log.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('commit-msg rejection leaves input editable and does not create a commit', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.hook('commit-msg', 'exit 2')
    await open(page, f.repo)
    await submit(page)
    await expect(page.locator('.toast.error')).toContainText('commit-msg Hook 阻止')
    const input = page.getByRole('textbox', { name: '提交说明', exact: true })
    await expect(input).toHaveValue('Keep attempted commit')
    await input.fill('Corrected message')
    await expect(page.getByRole('button', { name: /提交 \d+ 个文件/ })).toBeEnabled()
    expect(await f.git.head(f.repo)).toBe(f.head)
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('signature failure keeps draft; explicit retry after fixing config creates exactly one commit', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.git.git(f.repo, ['config', 'commit.gpgsign', 'true'])
    await f.git.git(f.repo, ['config', 'gpg.format', 'openpgp'])
    await f.git.git(f.repo, ['config', 'gpg.program', path.join(f.repo, 'missing-gpg')])
    await open(page, f.repo)
    await submit(page)
    await expect(page.locator('.toast.error')).toContainText('提交签名未完成')
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Keep attempted commit',
    )
    expect(await f.git.head(f.repo)).toBe(f.head)
    await f.git.git(f.repo, ['config', 'commit.gpgsign', 'false'])
    await page.keyboard.press('Control+o')
    const reopen = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await reopen.getByRole('textbox', { name: '仓库路径', exact: true }).fill(f.repo)
    await reopen.getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(reopen).not.toBeVisible()
    await submit(page)
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue('')
    expect((await f.git.git(f.repo, ['rev-list', '--count', `${f.head}..HEAD`])).trim()).toBe('1')
    await page.screenshot({ path: 'design/commit-diagnostics/02-browser-explicit-retry.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('failed post-commit shows commit already created and clears the submitted draft', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.hook('post-commit', 'exit 9')
    await open(page, f.repo)
    await submit(page)
    const toast = page
      .locator('.toast.error')
      .filter({ hasText: '提交已创建，但 post-commit Hook 失败' })
    await expect(toast).toBeVisible()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue('')
    expect((await f.git.git(f.repo, ['rev-list', '--count', `${f.head}..HEAD`])).trim()).toBe('1')
    expect((await f.git.status(f.repo)).staged).toHaveLength(0)
    await toast.getByRole('button', { name: '查看日志', exact: true }).click()
    await expect(page.locator('.activity-log-detail')).toContainText('post-commit：退出码 9')
    await page.screenshot({ path: 'design/commit-diagnostics/03-browser-created-with-warning.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})
