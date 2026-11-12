import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
test.setTimeout(60000)
async function fixture() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-recovery-ui-中文-')),
    git = new GitService()
  await git.git(repo, ['init', '-b', 'qa/first'])
  for (const [key, value] of [
    ['user.name', 'Recovery UI'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', key, value])
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n')
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'baseline'])
  const base = await git.head(repo)
  await fs.writeFile(path.join(repo, 'file.txt'), 'second\n')
  await git.git(repo, ['commit', '-am', 'local second commit'])
  const head = await git.head(repo)
  await fs.mkdir('design/git-recovery', { recursive: true })
  return {
    repo,
    git,
    base,
    head,
    dispose: async () => {
      await git.shutdown()
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}
async function open(page: Page, repo: string, alreadyTrusted = false) {
  await page.addInitScript(() => localStorage.removeItem('gitcode.workspaceSession.v1'))
  await page.goto('/')
  await expect(page.locator('#operation-status')).toContainText('已连接', { timeout: 15000 })
  await page.keyboard.press('Control+o')
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
  await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
  if (!alreadyTrusted)
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('dialog', { name: '信任此仓库？', exact: true })).not.toBeVisible()
  await expect(page.locator('.history-panel')).toContainText('local second commit')
}
async function recovery(page: Page) {
  await page
    .getByRole('menubar', { name: '应用菜单' })
    .getByRole('menuitem', { name: '仓库 Repository', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Git 操作恢复…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Git 操作恢复', exact: true })
  await expect(dialog.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
  return dialog
}
test('visible recovery menu undoes a local commit preserving code and draft, then restores its checkpoint as a new branch', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    const input = page.getByRole('textbox', { name: '提交说明', exact: true })
    await input.fill('Keep recovery draft')
    let dialog = await recovery(page)
    const undo = dialog.getByRole('button', { name: '撤回提交并保留代码', exact: true })
    await expect(undo).toBeDisabled()
    await dialog.getByRole('checkbox', { name: '我已确认该提交尚未共享' }).check()
    await expect(undo).toBeEnabled()
    await page.screenshot({ path: 'design/git-recovery/01-browser-undo-preview.png' })
    const index = await f.git.indexFingerprint(f.repo)
    await undo.click()
    await expect(dialog).not.toBeVisible()
    expect(await f.git.head(f.repo)).toBe(f.base)
    expect(await f.git.indexFingerprint(f.repo)).toBe(index)
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe('second\n')
    await expect(input).toHaveValue('Keep recovery draft')
    dialog = await recovery(page)
    await expect(dialog).toContainText('首次提交暂不支持撤回')
    await dialog.getByRole('combobox', { name: '恢复点', exact: true }).selectOption({ index: 1 })
    await dialog
      .getByRole('textbox', { name: '恢复后的本地分支名', exact: true })
      .fill('qa/restored-commit')
    await page.screenshot({ path: 'design/git-recovery/02-browser-restore-preview.png' })
    await dialog.getByRole('button', { name: '恢复为本地分支', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect((await f.git.git(f.repo, ['rev-parse', 'qa/restored-commit'])).trim()).toBe(f.head)
    expect(await f.git.currentBranch(f.repo)).toBe('qa/first')
    await expect(input).toHaveValue('Keep recovery draft')
  } finally {
    await page.close()
    await f.dispose()
  }
})
test('deleting a local branch through its context menu creates a durable recovery point', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.git.git(f.repo, ['branch', 'qa/deletable'])
    await open(page, f.repo)
    await page
      .locator('[data-sidebar-section="local"] [data-branch-name="qa/deletable"] .branch-main')
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除 qa/deletable', exact: true }).click()
    await page.getByRole('button', { name: '确认删除本地分支', exact: true }).click()
    await expect(
      page.locator('[data-sidebar-section="local"] [data-branch-name="qa/deletable"]'),
    ).toHaveCount(0)
    await page.reload()
    await open(page, f.repo, true)
    const dialog = await recovery(page)
    await expect(dialog.getByRole('combobox', { name: '恢复点', exact: true })).toContainText(
      'qa/deletable',
    )
    await dialog.getByRole('combobox', { name: '恢复点', exact: true }).selectOption({ index: 1 })
    await expect(
      dialog.getByRole('textbox', { name: '恢复后的本地分支名', exact: true }),
    ).toHaveValue('qa/deletable')
    await dialog.getByRole('button', { name: '恢复为本地分支', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect((await f.git.git(f.repo, ['rev-parse', 'qa/deletable'])).trim()).toBe(f.head)
  } finally {
    await page.close()
    await f.dispose()
  }
})
test('shared history is blocked and an external checkout invalidates an open undo preview', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await f.git.git(f.repo, ['update-ref', 'refs/remotes/origin/shared', f.head])
    await open(page, f.repo)
    let dialog = await recovery(page)
    await expect(dialog).toContainText('已有本地远程引用包含此提交')
    await expect(
      dialog.getByRole('button', { name: '撤回提交并保留代码', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await f.git.git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/shared'])
    dialog = await recovery(page)
    await dialog.getByRole('checkbox', { name: '我已确认该提交尚未共享' }).check()
    await f.git.git(f.repo, ['switch', '-c', 'qa/external'])
    await dialog.getByRole('button', { name: '撤回提交并保留代码', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(await f.git.head(f.repo)).toBe(f.head)
    expect((await f.git.git(f.repo, ['rev-parse', 'qa/first'])).trim()).toBe(f.head)
    await expect(dialog.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: '我已确认该提交尚未共享' })).not.toBeChecked()
    await expect(dialog).toContainText('qa/external')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    await page.close()
    await f.dispose()
  }
})
