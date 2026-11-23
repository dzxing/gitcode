import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
test.setTimeout(90000)
async function fixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-filter-ui-'))
  const git = new GitService({ dataDirectory: path.join(root, 'logs') })
  const create = async (parent: string, count: number) => {
    const repo = path.join(root, parent, 'app')
    await fs.mkdir(repo, { recursive: true })
    const cmd = (...args: string[]) => git.git(repo, args)
    await cmd('init', '-b', 'qa/base')
    for (const [k, v] of [
      ['user.name', 'Filter UI'],
      ['user.email', 'qa@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await cmd('config', k!, v!)
    let data = ''
    for (let i = 1; i <= count; i++)
      data += `commit refs/heads/qa/base\nmark :${i}\ncommitter QA <qa@example.test> ${1700000000 + i} +0000\ndata ${Buffer.byteLength('commit ' + i)}\ncommit ${i}\n${i > 1 ? 'from :' + (i - 1) + '\n' : ''}\n`
    await git.git(repo, ['fast-import', '--quiet'], { input: data })
    await cmd('reset', '--hard', 'qa/base')
    return { repo, cmd }
  }
  return {
    create,
    dispose: async () => {
      await git.shutdown()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
const trust = (page: Page) => page.getByRole('dialog', { name: '信任此仓库？', exact: true })
async function approve(page: Page) {
  await trust(page).getByRole('button', { name: '信任并打开', exact: true }).click()
  await trust(page).waitFor({ state: 'hidden' })
}
async function open(page: Page, repo: string) {
  await page.keyboard.press('Control+o')
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
  await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
  await approve(page)
  await expect(dialog).not.toBeVisible()
}
const row = (page: Page, section: string, name: string) =>
  page.locator(`[data-sidebar-section="${section}"] [data-branch-name="${name}"]`)
const preference = (page: Page, repo: string) =>
  page.evaluate(
    (repo) => JSON.parse(localStorage.getItem('gitcode.historyFilter.v1:' + repo) || 'null'),
    repo,
  )

test('real restart restores an older branch and its single sidebar source; invalid GitFlow and deleted refs fall back safely', async ({
  page,
}) => {
  const f = await fixtures()
  const actions: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/__gitcode/rpc') && r.postDataJSON().method === 'action')
      actions.push(r.postDataJSON().method)
  })
  try {
    const a = await f.create('one', 620),
      old = (await a.cmd('rev-parse', 'HEAD~400')).trim()
    await a.cmd('branch', 'qa/old', old)
    await a.cmd('tag', 'qa/old', old)
    for (const [k, v] of [
      ['gitflow.branch.master', 'qa/base'],
      ['gitflow.branch.develop', 'qa/old'],
      ['gitflow.prefix.feature', 'feature/'],
      ['gitflow.prefix.release', 'release/'],
      ['gitflow.prefix.hotfix', 'hotfix/'],
      ['gitflow.prefix.versiontag', 'v'],
    ])
      await a.cmd('config', k!, v!)
    await page.goto('/')
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await open(page, a.repo)
    await row(page, 'local', 'qa/old').locator('.branch-main').click()
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await expect(row(page, 'local', 'qa/old')).toHaveClass(/filtered/)
    await expect(row(page, 'gitflow', 'qa/old')).not.toHaveClass(/filtered/)
    await expect
      .poll(() => preference(page, a.repo))
      .toEqual({ version: 1, fullRef: 'refs/heads/qa/old', section: 'local' })
    await page.reload()
    await expect(trust(page)).not.toBeVisible()
    await expect(page.locator('.filter-banner')).toContainText('qa/old')
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await expect(row(page, 'local', 'qa/old')).toHaveClass(/filtered/)
    await expect(row(page, 'gitflow', 'qa/old')).not.toHaveClass(/filtered/)
    await page
      .locator('.filter-banner')
      .getByRole('button', { name: '显示全部', exact: true })
      .click()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await expect(page.locator('.history-scope-banner')).toHaveCount(0)
    await expect.poll(() => preference(page, a.repo)).toBeNull()
    await row(page, 'gitflow', 'qa/old').locator('.branch-main').click()
    await expect(row(page, 'gitflow', 'qa/old')).toHaveClass(/filtered/)
    await expect(row(page, 'local', 'qa/old')).not.toHaveClass(/filtered/)
    await page.reload()
    await expect(trust(page)).not.toBeVisible()
    await expect(row(page, 'gitflow', 'qa/old')).toHaveClass(/filtered/)
    await expect(row(page, 'local', 'qa/old')).not.toHaveClass(/filtered/)
    await fs.mkdir('design/filter-persistence', { recursive: true })
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await expect(page.getByRole('region', { name: '应用启动状态', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'design/filter-persistence/01-restored-gitflow-source.png' })
    await a.cmd('config', '--unset', 'gitflow.branch.develop')
    await page.reload()
    await expect(trust(page)).not.toBeVisible()
    await expect(row(page, 'local', 'qa/old')).toHaveClass(/filtered/)
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await a.cmd('branch', '-D', 'qa/old')
    await page.reload()
    await expect(trust(page)).not.toBeVisible()
    await expect(page.locator('.commit-row')).toHaveCount(250)
    await expect(page.locator('.filter-banner')).toHaveCount(0)
    await expect.poll(() => preference(page, a.repo)).toBeNull()
    expect((await a.cmd('rev-parse', '--verify', 'refs/tags/qa/old')).trim()).toBe(old)
    expect((await a.cmd('symbolic-ref', '--short', 'HEAD')).trim()).toBe('qa/base')
    expect(actions).toEqual([])
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await expect(page.getByRole('region', { name: '应用启动状态', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'design/filter-persistence/02-removed-ref-fallback.png' })
  } finally {
    await page.close()
    await f.dispose()
  }
})

test('real same-name tabs keep separate filters through trust cancellation, lazy restore and explicit clear', async ({
  page,
}) => {
  const f = await fixtures()
  try {
    const a = await f.create('one', 620),
      b = await f.create('two', 12)
    await a.cmd('branch', 'qa/old', 'HEAD~400')
    await page.goto('/')
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await open(page, a.repo)
    await row(page, 'local', 'qa/old').locator('.branch-main').click()
    await expect(page.locator('.commit-row')).toHaveCount(220)
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    await open(page, b.repo)
    await row(page, 'local', 'qa/base').locator('.branch-main').click()
    await expect(page.locator('.filter-banner')).toContainText('qa/base')
    const tab = (repo: string) =>
      page
        .locator('.tab-select')
        .filter({ hasText: 'app' })
        .and(page.locator(`[data-repository-path="${repo}"]`))
    await tab(a.repo).click()
    await expect(page.locator('.filter-banner')).toContainText('qa/old')
    const beforeA = await preference(page, a.repo),
      beforeB = await preference(page, b.repo)
    const snapshots: string[] = []
    page.on('request', (r) => {
      if (r.url().endsWith('/__gitcode/rpc') && r.postDataJSON().method === 'snapshot')
        snapshots.push(r.postDataJSON().args[0])
    })
    // A routine restart retains consent. Exercise cancellation by changing
    // actual execution-related configuration, which legitimately needs consent.
    await a.cmd('config', 'core.editor', 'false')
    await page.reload()
    await trust(page).waitFor()
    await trust(page).getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
    expect(await preference(page, a.repo)).toEqual(beforeA)
    expect(await preference(page, b.repo)).toEqual(beforeB)
    expect(snapshots).toEqual([])
    await tab(a.repo).click()
    await approve(page)
    await expect(page.locator('.filter-banner')).toContainText('qa/old')
    await expect(page.locator('.commit-row')).toHaveCount(220)
    expect(snapshots).toEqual([a.repo])
    await tab(b.repo).click()
    await expect(page.locator('.filter-banner')).toContainText('qa/base')
    await expect(trust(page)).not.toBeVisible()
    await expect(page.locator('.commit-row')).toHaveCount(12)
    await page
      .locator('.filter-banner')
      .getByRole('button', { name: '显示全部', exact: true })
      .click()
    await expect.poll(() => preference(page, b.repo)).toBeNull()
    await page.reload()
    await expect(page.locator('.filter-banner')).toHaveCount(0)
    await expect(trust(page)).not.toBeVisible()
    expect(await preference(page, a.repo)).toEqual(beforeA)
    await fs.mkdir('design/filter-persistence', { recursive: true })
    await expect(page.locator('#operation-status')).toContainText('已连接')
    await expect(page.getByRole('region', { name: '应用启动状态', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'design/filter-persistence/03-independent-tabs.png' })
    expect((await a.cmd('symbolic-ref', '--short', 'HEAD')).trim()).toBe('qa/base')
    expect((await b.cmd('symbolic-ref', '--short', 'HEAD')).trim()).toBe('qa/base')
  } finally {
    await page.close()
    await f.dispose()
  }
})
