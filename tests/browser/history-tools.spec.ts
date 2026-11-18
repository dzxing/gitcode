import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
test.setTimeout(90000)
test('real Git: query old commits, follow file rename, compare staged versions and return without losing selection', async ({
  page,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-history-tools-ui-'))
  const git = new GitService({ dataDirectory: path.join(root, 'logs') })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  const cmd = (...args: string[]) => git.git(repo, args)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await cmd('init', '-b', 'qa/base')
    for (const [k, v] of [
      ['user.name', 'History UI'],
      ['user.email', 'history@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await cmd('config', k!, v!)
    await fs.writeFile(path.join(repo, 'old.txt'), 'first\nsecond\nthird\n')
    await cmd('add', '.')
    await cmd('commit', '-m', 'needle earliest file')
    const initial = (await cmd('rev-parse', 'HEAD')).trim()
    let data = ''
    for (let i = 1; i <= 310; i++) {
      const message = `history filler ${i}`
      data += `commit refs/heads/qa/base\nmark :${i}\ncommitter History UI <history@example.test> ${1800000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i === 1 ? initial : ':' + (i - 1)}\n`
    }
    await git.git(repo, ['fast-import', '--quiet'], { input: data })
    await cmd('reset', '--hard', 'qa/base')
    await cmd('mv', 'old.txt', 'new.txt')
    await cmd('commit', '-m', 'rename file')
    await fs.appendFile(path.join(repo, 'new.txt'), 'fourth\n')
    await cmd('add', '.')
    await cmd('commit', '-m', 'latest file change')
    await fs.appendFile(path.join(repo, 'new.txt'), 'staged line\n')
    await cmd('add', 'new.txt')
    await fs.appendFile(path.join(repo, 'new.txt'), 'unstaged line\n')
    await page.addInitScript(() => localStorage.removeItem('gitcode.workspaceSession.v1'))
    await page.goto('/')
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await page.getByRole('textbox', { name: '搜索提交', exact: true }).fill('needle earliest file')
    await expect(page.locator('.commit-row')).toHaveCount(1)
    await expect(page.locator('.commit-row')).toContainText('needle earliest file')
    await expect(page.locator('.history-query-toolbar')).toContainText('已加载 1 条')
    await page.locator('.history-filter summary').filter({ hasText: '作者' }).click()
    await page.getByRole('textbox', { name: '筛选作者', exact: true }).fill('not an author')
    await expect(page.locator('.commit-row')).toHaveCount(0)
    await page
      .locator('.history-query-toolbar')
      .getByRole('button', { name: '清除筛选', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await page.locator('.history-filter summary').filter({ hasText: '路径' }).click()
    await page.getByRole('textbox', { name: '筛选路径', exact: true }).fill('old.txt')
    await expect(page.locator('.commit-row')).toHaveCount(2)
    await expect(page.locator('.commit-row')).toContainText(['rename file', 'needle earliest file'])
    await page
      .locator('.history-query-toolbar')
      .getByRole('button', { name: '清除筛选', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await page.getByRole('button', { name: '查看提交 latest file change', exact: true }).click()
    await page.locator('.file-main[data-file-path="new.txt"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '显示文件历史', exact: true }).click()
    await expect(page.getByRole('region', { name: '文件历史', exact: true })).toBeVisible()
    await expect(page.locator('.file-history-revision')).toHaveCount(3)
    await expect(page.locator('.file-history-revision')).toContainText([
      'latest file change',
      'rename file',
      'needle earliest file',
    ])
    await expect(page.locator('.file-history-preview')).toContainText('+fourth')
    await page
      .locator('.file-history-revision')
      .last()
      .click({ modifiers: ['Control'] })
    await expect(page.locator('.history-tool-subhead')).toContainText('所选版本比较')
    await expect(page.locator('.file-history-revision.selected')).toHaveCount(2)
    await expect(page.getByText('正在读取…', { exact: true })).toHaveCount(0)
    await fs.mkdir('.tmp/history-tools-ui', { recursive: true })
    await page.screenshot({ path: '.tmp/history-tools-ui/file-history.png' })
    await page.getByRole('tab', { name: '提交历史', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '查看提交 latest file change', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('tab', { name: '历史：new.txt', exact: true }).click()
    await page.locator('.file-history-revision').last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '与本地版本比较', exact: true }).click()
    await expect(page.locator('.history-tool-subhead')).toContainText('所选版本与本地文件比较')
    await expect(page.locator('.file-history-preview')).toContainText('+unstaged line')
    await page.locator('.file-history-revision').last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在提交图中定位', exact: true }).click()
    await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', initial)
    await page.getByRole('button', { name: '返回全部历史', exact: true }).click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await page.getByText('未提交的更改', { exact: true }).click()
    await page
      .locator('[data-file-path="new.txt"][data-file-staged="false"]')
      .first()
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: '比较三个版本', exact: true }).click()
    await expect(page.getByRole('region', { name: '三版本对照', exact: true })).toBeVisible()
    await expect(page.locator('.version-pane')).toHaveCount(3)
    await expect(page.locator('.version-pane').nth(0)).not.toContainText('staged line')
    await expect(page.locator('.version-pane').nth(1)).toContainText('staged line')
    await expect(page.locator('.version-pane').nth(1)).not.toContainText('unstaged line')
    await expect(page.locator('.version-pane').nth(2)).toContainText('unstaged line')
    await page.getByRole('button', { name: '下一处', exact: true }).click()
    await fs.appendFile(path.join(repo, 'new.txt'), 'external edit\n')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(page.locator('.history-tool-stale')).toBeVisible()
    await page
      .locator('.history-tool-stale')
      .getByRole('button', { name: '重新读取', exact: true })
      .click()
    await expect(page.locator('.version-pane').nth(2)).toContainText('external edit')
    await expect(page.locator('.history-tool-stale')).toHaveCount(0)
    await page
      .getByRole('combobox', { name: '比较版本', exact: true })
      .selectOption('index-working')
    await expect(page.locator('.version-pane')).toHaveCount(2)
    await page.screenshot({ path: '.tmp/history-tools-ui/three-versions.png' })
    expect(errors).toEqual([])
    expect(await cmd('diff', '--cached', '--numstat')).toContain('1\t0\tnew.txt')
    expect(await cmd('diff', '--numstat')).toContain('2\t0\tnew.txt')
  } finally {
    await page.close()
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  }
})
