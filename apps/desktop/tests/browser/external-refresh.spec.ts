import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')

test.setTimeout(60000)
async function fixture(refFormat?: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-live-observation-'))
  const repo = path.join(directory, '中文 worktree'),
    git = new GitService()
  await fs.mkdir(path.join(repo, 'src'), { recursive: true })
  await git.git(repo, [
    'init',
    '-b',
    'qa/first',
    ...(refFormat ? [`--ref-format=${refFormat}`] : []),
  ])
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
  await expect(page.locator('.repo-selector')).toHaveAttribute('data-repository-path', repo)
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

for (const format of ['files', 'reftable']) {
  test(`${format}: all-branch graph updates preserve the loaded history window when a non-current branch advances`, async ({
    page,
  }) => {
    const f = await fixture(format)
    try {
      const context = await f.git.head(f.repo)
      let data = ''
      for (let i = 1; i <= 520; i++) {
        const message = `graph window ${i}`
        data += `commit refs/heads/qa/first\nmark :${i}\ncommitter External QA <external@example.test> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i > 1 ? `from :${i - 1}\n` : `from ${context}\n`}\n`
      }
      await f.git.git(f.repo, ['fast-import', '--quiet'], { input: data })
      await f.git.git(f.repo, ['reset', '--hard', 'qa/first'])
      await f.git.git(f.repo, ['branch', 'feature/background', 'qa/first'])
      const old = (await f.git.git(f.repo, ['rev-parse', 'HEAD~400'])).trim()
      await f.git.git(f.repo, ['branch', 'qa/old-anchor', old])
      await open(page, f.repo)
      await page.getByRole('button', { name: '加载更早的 250 条提交', exact: true }).click()
      await expect(page.locator('.commit-row')).toHaveCount(500)
      await expect(page.locator(`[data-commit-hash="${old}"]`)).toHaveCount(1)
      const draft = page.getByRole('textbox', { name: '提交说明', exact: true })
      await draft.fill('Keep draft while other branch moves')
      const head = await f.git.head(f.repo)
      const tree = (await f.git.git(f.repo, ['rev-parse', 'HEAD^{tree}'])).trim()
      const commit = (
        await f.git.git(f.repo, [
          'commit-tree',
          tree,
          '-p',
          head,
          '-m',
          'external non-current graph update',
        ])
      ).trim()
      await f.git.git(f.repo, ['update-ref', 'refs/heads/feature/background', commit])
      await expect(page.locator(`[data-commit-hash="${commit}"]`)).toHaveCount(1, {
        timeout: 10000,
      })
      await expect(page.locator(`[data-commit-hash="${old}"]`)).toHaveCount(1)
      await expect(page.locator('.commit-row')).toHaveCount(500)
      await expect(draft).toHaveValue('Keep draft while other branch moves')
      expect(await f.git.head(f.repo)).toBe(head)
      const remote = (
        await f.git.git(f.repo, [
          'commit-tree',
          tree,
          '-p',
          head,
          '-m',
          'manual refresh remote tip',
        ])
      ).trim()
      await f.git.git(f.repo, ['update-ref', 'refs/remotes/origin/feature/remote', remote])
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await expect(page.locator(`[data-commit-hash="${remote}"]`)).toHaveCount(1)
      await expect(page.locator(`[data-commit-hash="${old}"]`)).toHaveCount(1)
      await expect(page.locator('.commit-row')).toHaveCount(500)
      await f.git.git(f.repo, ['update-ref', '-d', 'refs/heads/feature/background', commit])
      await f.git.git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/feature/remote', remote])
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await expect(page.locator(`[data-commit-hash="${commit}"]`)).toHaveCount(0)
      await expect(page.locator(`[data-commit-hash="${remote}"]`)).toHaveCount(0)
      await expect(page.locator(`[data-commit-hash="${old}"]`)).toHaveCount(1)
      await expect(draft).toHaveValue('Keep draft while other branch moves')
    } finally {
      await page.close()
      await f.dispose()
    }
  })
}

test('Fetch actively refreshes changed references before planning without waiting for observation ticks', async ({
  page,
}) => {
  const f = await fixture()
  try {
    const remote = path.join(f.directory, 'remote.git')
    await f.git.git(f.directory, ['init', '--bare', remote])
    await f.git.git(f.repo, ['remote', 'add', 'origin', remote])
    await f.git.git(f.repo, ['push', '-u', 'origin', 'qa/first'])
    await open(page, f.repo)
    // Isolate the operation-driven path from periodic/background observation.
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    )
    const methods: string[] = []
    page.on('request', (request) => {
      try {
        const body = request.postDataJSON()
        if (['refresh-references', 'sync-plan', 'action'].includes(body?.method))
          methods.push(body.method)
      } catch {}
    })
    const head = await f.git.head(f.repo)
    const tree = (await f.git.git(f.repo, ['rev-parse', 'HEAD^{tree}'])).trim()
    const commit = (
      await f.git.git(f.repo, [
        'commit-tree',
        tree,
        '-p',
        head,
        '-m',
        'button-triggered graph refresh',
      ])
    ).trim()
    await f.git.git(f.repo, ['update-ref', 'refs/heads/feature/operation-entry', commit])
    await expect(page.locator(`[data-commit-hash="${commit}"]`)).toHaveCount(0)
    await page.getByRole('button', { name: '获取', exact: true }).click()
    await expect.poll(() => methods.includes('action'), { timeout: 15000 }).toBe(true)
    await expect(page.locator(`[data-commit-hash="${commit}"]`)).toHaveCount(1)
    expect(methods).toEqual(['refresh-references', 'sync-plan', 'action'])
    await expect(page.locator('.toast').filter({ hasText: '已获取' })).toBeVisible({
      timeout: 15000,
    })
    expect(await f.git.head(f.repo)).toBe(head)
    await page.screenshot({ path: '.tmp/operation-trigger-refresh.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('operation-entry refresh stops an old intent when an external checkout changed only the branch name', async ({
  page,
}) => {
  const f = await fixture()
  try {
    await open(page, f.repo)
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    )
    const methods: string[] = []
    page.on('request', (request) => {
      try {
        const body = request.postDataJSON()
        if (['refresh-references', 'sync-plan', 'action'].includes(body?.method))
          methods.push(body.method)
      } catch {}
    })
    const head = await f.git.head(f.repo)
    await f.git.git(f.repo, ['switch', 'qa/other'])
    expect(await f.git.head(f.repo)).toBe(head)
    await expect(page.locator('.branch-selector summary')).toContainText('qa/first')
    await page.getByRole('button', { name: '获取', exact: true }).click()
    await expect(page.locator('.branch-selector summary')).toContainText('qa/other')
    await expect(page.locator('.toast').filter({ hasText: '当前分支或 HEAD 已变化' })).toBeVisible()
    expect(methods).toEqual(['refresh-references'])
    expect(await f.git.head(f.repo)).toBe(head)
    expect(await f.git.currentBranch(f.repo)).toBe('qa/other')
  } finally {
    await page.close()
    await f.dispose()
  }
})
