import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-fetch-settings-ui-'))
  const source = path.join(root, 'source'),
    repo = path.join(root, '中文 clone')
  const global = path.join(root, 'global-config')
  await writeFile(global, '')
  const run = promisify(execFile)
  const git = async (cwd: string, args: string[]) =>
    (
      await run('git', args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' },
      })
    ).stdout.trim()
  await mkdir(source)
  await git(source, ['init', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'UI QA'],
    ['user.email', 'ui@example.test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git(source, ['config', key, value])
  for (let i = 0; i < 3; i++) {
    await writeFile(path.join(source, 'a.txt'), `${i}\n`)
    await git(source, ['add', 'a.txt'])
    await git(source, ['commit', '-m', `commit ${i}`])
  }
  await git(source, ['branch', 'develop'])
  await git(root, [
    'clone',
    '--depth=1',
    '--single-branch',
    '--branch=main',
    pathToFileURL(source).href,
    repo,
  ])
  await git(repo, ['config', 'core.hooksPath', '.no-hooks'])
  return { root, repo, git }
}
async function open(page: Page, repo: string) {
  await page.goto('/')
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await open.getByLabel('仓库路径', { exact: true }).fill(repo)
  await open.getByRole('button', { name: '打开仓库', exact: true }).click()
  await page
    .getByRole('dialog', { name: '信任此仓库？', exact: true })
    .getByRole('button', { name: '信任并打开', exact: true })
    .click()
  await open.waitFor({ state: 'hidden' })
  await page.getByRole('menuitem', { name: '仓库 Repository', exact: true }).click()
  await page.getByRole('menuitem', { name: '当前仓库设置…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog.getByRole('tab', { name: '当前仓库', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(dialog.getByText('当前仅获取：main', { exact: true })).toBeVisible()
  return dialog
}

test('真实本地 Git 服务：扩大范围并获取其他分支，保留浅历史和工作文件', async ({ page }) => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(path.join(repo, 'a.txt'), 'local draft\n')
    const dialog = await open(page, repo)
    await dialog.getByLabel('分支获取范围', { exact: true }).selectOption('all')
    await expect(dialog.getByRole('button', { name: '立即获取', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '补全历史…', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '保存获取范围', exact: true }).click()
    await expect(dialog.getByText('当前获取此远端的全部分支', { exact: true })).toBeVisible()
    expect(await git(repo, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    await dialog.getByRole('button', { name: '立即获取', exact: true }).click()
    await expect(dialog.getByText('已按当前获取配置更新分支列表。', { exact: true })).toBeVisible()
    expect(await git(repo, ['rev-parse', '--verify', 'refs/remotes/origin/develop'])).toMatch(
      /^[a-f0-9]{40}$/,
    )
    expect(await readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('local draft\n')
    expect(await git(repo, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    await page.screenshot({ path: 'design/fetch-settings/scope-saved.png' })
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await expect(page.locator('.sidebar [data-branch-name="origin/develop"]')).toBeVisible()
  } finally {
    await page.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('真实本地 Git 服务：补全历史需确认且不会扩大分支范围', async ({ page }) => {
  const { root, repo, git } = await fixture()
  try {
    const dialog = await open(page, repo)
    await dialog.getByRole('button', { name: '补全历史…', exact: true }).click()
    const confirm = dialog.getByRole('group', { name: '确认补全历史', exact: true })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    expect(await git(repo, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    await dialog.getByRole('button', { name: '补全历史…', exact: true }).click()
    await confirm.getByRole('button', { name: '确认补全历史', exact: true }).click()
    await expect(dialog.getByText('完整仓库：没有浅历史边界', { exact: true })).toBeVisible()
    await expect(dialog.getByText('当前仅获取：main', { exact: true })).toBeVisible()
    expect(await git(repo, ['rev-list', '--count', 'HEAD'])).toBe('3')
    expect(await git(repo, ['config', '--get-all', 'remote.origin.fetch'])).toBe(
      '+refs/heads/main:refs/remotes/origin/main',
    )
    await expect(dialog.getByRole('button', { name: '补全历史…', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'design/fetch-settings/history-completed.png' })
  } finally {
    await page.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('真实本地 Git 服务：外部配置变化会拦截保存，重新读取后可以重试', async ({ page }) => {
  const { root, repo, git } = await fixture()
  try {
    const dialog = await open(page, repo)
    await dialog.getByLabel('分支获取范围', { exact: true }).selectOption('all')
    await git(repo, ['config', 'user.name', 'Changed outside the application'])
    await dialog.getByRole('button', { name: '保存获取范围', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('已变化')
    expect(await git(repo, ['config', '--get-all', 'remote.origin.fetch'])).toBe(
      '+refs/heads/main:refs/remotes/origin/main',
    )
    await dialog.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByLabel('分支获取范围', { exact: true })).toHaveValue('selected')
  } finally {
    await page.close()
    await rm(root, { recursive: true, force: true })
  }
})
