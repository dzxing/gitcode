import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
test.setTimeout(60000)
async function fixture() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-partial-ui-中文-')),
    git = new GitService(),
    base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`)
  await git.git(repo, ['init', '-b', 'qa/partial'])
  for (const [k, v] of [
    ['user.name', 'Partial UI'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
    ['core.autocrlf', 'false'],
  ])
    await git.git(repo, ['config', k, v])
  await fs.writeFile(path.join(repo, 'file.txt'), base.join(''))
  await git.git(repo, ['add', '.'])
  await git.git(repo, ['commit', '-m', 'partial baseline'])
  const work = [...base]
  work[3] = 'first edit\n'
  work[25] = 'second edit\n'
  await fs.writeFile(path.join(repo, 'file.txt'), work.join(''))
  await fs.mkdir('design/partial-stage', { recursive: true })
  const blob = async (file = 'file.txt') => {
    const raw = await git.git(repo, ['cat-file', '--batch'], { input: `:${file}\n` })
    return raw.slice(raw.indexOf('\n') + 1, -1)
  }
  return {
    repo,
    git,
    base,
    work,
    blob,
    dispose: async () => {
      await git.shutdown()
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 })
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
}
async function file(page: Page, name = 'file.txt', staged = false) {
  await page.locator(`.file-main[data-file-path="${name}"][data-file-staged="${staged}"]`).click()
  await expect(page.getByRole('button', { name: '选择修改', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '选择修改', exact: true }).click()
  await expect(
    page.getByRole('button', { name: staged ? '取消暂存修改块 1' : '暂存修改块 1', exact: true }),
  ).toBeEnabled()
}

test('stage a block, switch to staged content, and unstage a single line without changing the working file or draft', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    const draft = page.getByRole('textbox', { name: '提交说明', exact: true })
    await draft.fill('Keep partial draft')
    await file(page)
    await page.getByRole('button', { name: '选择修改块 1', exact: true }).click()
    await expect(page.locator('.partial-gutter input:checked')).toHaveCount(2)
    await page.screenshot({ path: 'design/partial-stage/01-browser-line-selection.png' })
    await page.getByRole('button', { name: /^暂存所选行/ }).click()
    const staged = [...f.base]
    staged[3] = 'first edit\n'
    await expect.poll(() => f.blob()).toBe(staged.join(''))
    await expect(draft).toHaveValue('Keep partial draft')
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe(f.work.join(''))
    await expect(page.getByRole('button', { name: '暂存修改块 1', exact: true })).toBeEnabled()
    await expect(page.locator('.partial-gutter input:checked')).toHaveCount(0)
    await expect(page.locator('.partial-gutter input').first()).toBeFocused()
    await page.getByRole('button', { name: '暂存内容', exact: true }).click()
    await page.getByRole('button', { name: '选择修改', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消暂存修改块 1', exact: true })).toBeEnabled()
    await page
      .locator('.diff-line.add')
      .filter({ hasText: '+first edit' })
      .getByRole('checkbox')
      .check()
    await page.getByRole('button', { name: /^取消暂存所选行/ }).click()
    staged.splice(3, 1)
    await expect.poll(() => f.blob()).toBe(staged.join(''))
    await page.getByRole('button', { name: '取消暂存修改块 1', exact: true }).click()
    await expect.poll(() => f.blob()).toBe(f.base.join(''))
    await expect(page.getByRole('button', { name: '选择修改', exact: true })).toBeVisible()
    await expect(page.locator('.diff-scroll')).toContainText('first edit')
    await expect(page.locator('.diff-scroll')).toContainText('second edit')
    await expect(page.locator('.partial-warning')).toHaveCount(0)
    await expect(draft).toHaveValue('Keep partial draft')
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe(f.work.join(''))
  } finally {
    await page.screenshot({ path: test.info().outputPath('last-state.png') }).catch(() => {})
    await fs
      .writeFile(test.info().outputPath('last-state.html'), await page.content())
      .catch(() => {})
    await page.close()
    await f.dispose()
  }
})
test('external saves invalidate the selection, keep the old preview visible and require an explicit reread', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    await file(page)
    await page.getByRole('button', { name: '选择修改块 1', exact: true }).click()
    const changed = f.work.join('') + 'external append\n'
    await fs.writeFile(path.join(f.repo, 'file.txt'), changed)
    await expect(page.getByRole('alert')).toContainText('已变化', { timeout: 15000 })
    await expect(page.locator('.partial-gutter input:checked')).toHaveCount(2)
    await expect(page.getByRole('button', { name: /^暂存所选行/ })).toBeDisabled()
    await expect(page.locator('.diff-scroll')).not.toContainText('external append')
    await page.screenshot({ path: 'design/partial-stage/02-browser-stale-selection.png' })
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.locator('.diff-scroll')).toContainText('external append')
    await expect(page.locator('.partial-gutter input:checked')).toHaveCount(0)
    await page.getByRole('button', { name: '暂存修改块 2', exact: true }).click()
    const staged = [...f.base]
    staged[25] = 'second edit\n'
    await expect.poll(() => f.blob()).toBe(staged.join(''))
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe(changed)
  } finally {
    await page.screenshot({ path: test.info().outputPath('last-state.png') }).catch(() => {})
    await fs
      .writeFile(test.info().outputPath('last-state.html'), await page.content())
      .catch(() => {})
    await page.close()
    await f.dispose()
  }
})
test('new text files support line selection and files without EOF newline provide only safe block actions', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.repo, 'new.txt'), 'alpha\nbeta\n')
    await fs.writeFile(path.join(f.repo, 'no-eof.txt'), 'no newline')
    await open(page, f.repo)
    await file(page, 'new.txt')
    await page.locator('.diff-line.add').filter({ hasText: '+alpha' }).getByRole('checkbox').check()
    await page.getByRole('button', { name: /^暂存所选行/ }).click()
    await expect.poll(() => f.blob('new.txt')).toBe('alpha\n')
    await file(page, 'no-eof.txt')
    await expect(page.locator('.partial-note')).toContainText('仅支持整块操作')
    await expect(page.locator('.partial-gutter input')).toHaveCount(0)
    await page.getByRole('button', { name: '暂存修改块 1', exact: true }).click()
    await expect.poll(() => f.blob('no-eof.txt')).toBe('no newline')
    expect(await fs.readFile(path.join(f.repo, 'new.txt'), 'utf8')).toBe('alpha\nbeta\n')
  } finally {
    await page.screenshot({ path: test.info().outputPath('last-state.png') }).catch(() => {})
    await fs
      .writeFile(test.info().outputPath('last-state.html'), await page.content())
      .catch(() => {})
    await page.close()
    await f.dispose()
  }
})
test('an unrelated external index update is preserved and rejects the old plan without silently replacing it', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    await file(page)
    await page.getByRole('button', { name: '选择修改块 1', exact: true }).click()
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'external staged\n')
    await f.git.git(f.repo, ['add', 'other.txt'])
    await page.getByRole('button', { name: /^暂存所选行/ }).click()
    await expect(page.locator('.partial-warning')).toContainText('已变化')
    expect(await f.blob()).toBe(f.base.join(''))
    expect(await f.blob('other.txt')).toBe('external staged\n')
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('button', { name: '暂存修改块 1', exact: true }).click()
    const staged = [...f.base]
    staged[3] = 'first edit\n'
    await expect.poll(() => f.blob()).toBe(staged.join(''))
    expect(await f.blob('other.txt')).toBe('external staged\n')
  } finally {
    await page.screenshot({ path: test.info().outputPath('last-state.png') }).catch(() => {})
    await fs
      .writeFile(test.info().outputPath('last-state.html'), await page.content())
      .catch(() => {})
    await page.close()
    await f.dispose()
  }
})

test('committing after partial staging includes only the selected hunk and leaves the rest uncommitted', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    await file(page)
    await page.getByRole('button', { name: '暂存修改块 1', exact: true }).click()
    const staged = [...f.base]
    staged[3] = 'first edit\n'
    await expect.poll(() => f.blob()).toBe(staged.join(''))
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Commit first hunk only')
    await page.getByRole('button', { name: /^提交 1 个文件/ }).click()
    await expect(page.locator('.history-panel')).toContainText('Commit first hunk only')
    expect(await f.git.git(f.repo, ['show', 'HEAD:file.txt'])).toBe(staged.join(''))
    expect(await f.blob()).toBe(staged.join(''))
    expect(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8')).toBe(f.work.join(''))
    await expect(
      page.locator('.file-main[data-file-path="file.txt"][data-file-staged="false"]'),
    ).toBeVisible()
    await expect(
      page.locator('.file-main[data-file-path="file.txt"][data-file-staged="true"]'),
    ).toHaveCount(0)
    await page.screenshot({ path: 'design/partial-stage/03-browser-partial-commit.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})
