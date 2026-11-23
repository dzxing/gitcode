import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
test.setTimeout(90000)
async function fixture(page: Page) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-history-ui-'))
  const repo = path.join(root, 'app')
  await fs.mkdir(repo)
  const git = new GitService({ dataDirectory: path.join(root, 'logs') })
  const cmd = (...args: string[]) => git.git(repo, args)
  await cmd('init', '-b', 'qa/base')
  for (const [k, v] of [
    ['user.name', 'History UI'],
    ['user.email', 'qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await cmd('config', k!, v!)
  let data = ''
  for (let i = 1; i <= 620; i++)
    data += `commit refs/heads/qa/base\nmark :${i}\ncommitter QA <qa@example.test> ${1700000000 + i} +0000\ndata ${Buffer.byteLength('commit ' + i)}\ncommit ${i}\n${i > 1 ? 'from :' + (i - 1) + '\n' : ''}\n`
  await git.git(repo, ['fast-import', '--quiet'], { input: data })
  await cmd('reset', '--hard', 'qa/base')
  const old = (await cmd('rev-parse', 'HEAD~400')).trim()
  await cmd('branch', 'qa/old', old)
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
  await expect(open).not.toBeVisible()
  await expect(page.locator('.commit-row')).toHaveCount(250)
  return {
    repo,
    cmd,
    old,
    dispose: async () => {
      await page.close()
      await git.shutdown()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
test('real history paging retains graph geometry, scroll and selection across append and refresh', async ({
  page,
}) => {
  const f = await fixture(page)
  try {
    await page.getByRole('button', { name: '查看提交 commit 600', exact: true }).click()
    const selected = await page.locator('.commit-row.selected').getAttribute('data-commit-hash')
    const geometry = await page
      .locator('[data-node-hash] > circle:first-child')
      .evaluateAll((nodes) =>
        nodes.slice(0, 250).map((n) => [n.getAttribute('cx'), n.getAttribute('cy')]),
      )
    const more = page.getByRole('button', { name: '加载更早的 250 条提交', exact: true })
    await more.scrollIntoViewIfNeeded()
    const top = await page.locator('.history-scroll').evaluate((e) => e.scrollTop)
    await more.click()
    await expect(page.locator('.commit-row')).toHaveCount(500)
    await expect(page.locator('.commit-row.selected')).toHaveAttribute(
      'data-commit-hash',
      selected!,
    )
    expect(await page.locator('.history-scroll').evaluate((e) => e.scrollTop)).toBe(top)
    expect(
      await page
        .locator('[data-node-hash] > circle:first-child')
        .evaluateAll((nodes) =>
          nodes.slice(0, 250).map((n) => [n.getAttribute('cx'), n.getAttribute('cy')]),
        ),
    ).toEqual(geometry)
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(500)
    await more.click()
    await expect(page.locator('.commit-row')).toHaveCount(620)
    await expect(more).toHaveCount(0)
    await fs.mkdir('design/history-pagination', { recursive: true })
    await page.screenshot({ path: 'design/history-pagination/01-loaded-all.png' })
    await f.cmd('commit', '--allow-empty', '-m', 'new external commit')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(621)
    await expect(page.locator('.history-pagination')).toHaveCount(0)
    // Multiple independent tips and a merge whose parents cross page one.
    await f.cmd('switch', '-c', 'qa/side', 'HEAD~400')
    for (let i = 0; i < 3; i++) await f.cmd('commit', '--allow-empty', '-m', `side ${i}`)
    await f.cmd('switch', 'qa/base')
    await f.cmd('merge', '--no-ff', '--no-edit', 'qa/side')
    await f.cmd('switch', '-c', 'qa/other', 'HEAD~500')
    await f.cmd('commit', '--allow-empty', '-m', 'other tip')
    await f.cmd('switch', 'qa/base')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(626)
    await expect(page.locator('.history-pagination')).toHaveCount(0)
    const forkGeometry = await page
      .locator('[data-node-hash] > circle:first-child')
      .evaluateAll((nodes) =>
        nodes.slice(0, 250).map((n) => [n.getAttribute('cx'), n.getAttribute('cy')]),
      )
    await expect(more).toHaveCount(0)
    expect(
      await page
        .locator('[data-node-hash] > circle:first-child')
        .evaluateAll((nodes) =>
          nodes.slice(0, 250).map((n) => [n.getAttribute('cx'), n.getAttribute('cy')]),
        ),
    ).toEqual(forkGeometry)
    await page.locator('.history-scroll').evaluate((e) => {
      e.scrollTop = 0
    })
    await page.screenshot({ path: 'design/history-pagination/03-merge-boundary.png' })
  } finally {
    await f.dispose()
  }
})
test('real SHA location reaches older commits, preserves failed lookups and opens an old branch outside page one', async ({
  page,
}) => {
  const f = await fixture(page)
  try {
    const input = page.getByRole('textbox', { name: '搜索提交', exact: true })
    await input.fill(f.old.slice(0, 12))
    await expect(page.locator('.history-scope-banner')).toContainText('SHA 定位')
    await input.press('Enter')
    await expect(page.locator('.history-scope-banner')).toContainText('定位视图')
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', f.old)
    await expect(input).toHaveValue('')
    await input.fill('deadbee')
    await input.press('Enter')
    await expect(page.locator('.history-page-error')).toBeVisible()
    await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', f.old)
    await input.fill('')
    await page.getByRole('button', { name: '返回全部历史', exact: true }).click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await page
      .locator('[data-sidebar-section="local"] [data-branch-name="qa/old"] .branch-main')
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await expect(page.locator('.filter-banner')).toContainText('qa/old')
    await expect(page.locator('.history-scope-banner')).toContainText('定位视图')
    await fs.mkdir('design/history-pagination', { recursive: true })
    await page.screenshot({ path: 'design/history-pagination/02-old-branch.png' })
    await page.getByRole('button', { name: '返回全部历史', exact: true }).click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await expect(page.locator('.filter-banner')).toHaveCount(0)
  } finally {
    await f.dispose()
  }
})
