import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')
export async function verifyMenuEntry(page, { url, screenshotDirectory } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-menu-entry-')),
    git = new GitService()
  let writes = 0
  const countWrites = (request) => {
    if (request.url().endsWith('/__gitcode/rpc') && request.postDataJSON()?.method === 'action')
      writes++
  }
  page.on('request', countWrites)
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  const branchMenu = async (name) => {
    await page
      .locator(`[data-sidebar-section="local"] [data-branch-name="${name}"] .branch-main`)
      .click({ button: 'right' })
    return page.getByRole('menu')
  }
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Menu entry'],
      ['user.email', 'menu@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(repo + '/base.txt', 'base\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'base'])
    const base = await git.head(repo),
      bare = path.join(repo, '.git', 'remote.git')
    await git.git(repo, ['init', '--bare', bare])
    await git.git(repo, ['remote', 'add', 'origin', bare])
    await git.git(repo, ['push', '-u', 'origin', 'main'])
    await git.git(repo, ['branch', 'feature/topic'])
    await git.git(repo, ['branch', '--set-upstream-to=origin/main', 'feature/topic'])
    await git.git(repo, ['branch', 'unlinked'])
    await writeFile(repo + '/stashed.txt', 'stashed data\n')
    await git.git(repo, ['stash', 'push', '--include-untracked', '-m', 'menu-entry-stash'])
    await page.goto(url)
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    let menu = await branchMenu('main')
    await expect(menu.getByRole('menuitem', { name: '切换到 main', exact: true })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: '删除 main', exact: true })).toHaveCount(0)
    await capture('current-branch-actions-hidden')
    await page.keyboard.press('Escape')
    menu = await branchMenu('feature/topic')
    await expect(menu.getByRole('menuitem', { name: '拉取', exact: true })).toBeEnabled()
    await menu.getByRole('menuitem', { name: '拉取', exact: true }).click()
    const pull = page.getByRole('dialog', { name: '拉取远程分支', exact: true })
    await expect(pull.getByRole('alert')).toContainText('请先切换到 feature/topic')
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeDisabled()
    await capture('pull-noncurrent-explained')
    await pull.getByRole('button', { name: '取消', exact: true }).click()
    // Missing tracking enters the upstream chooser before a pull can be planned.
    await git.git(repo, ['config', '--unset-all', 'branch.main.remote'])
    await git.git(repo, ['config', '--unset-all', 'branch.main.merge'])
    const refresh = page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
    const reload = async () => {
      const pending = page.waitForResponse(
        (r) =>
          r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'snapshot',
      )
      await refresh.click()
      await pending
      await expect(refresh).toBeEnabled()
    }
    await reload()
    menu = await branchMenu('main')
    await menu.getByRole('menuitem', { name: '拉取', exact: true }).click()
    const upstream = page.getByRole('dialog', { name: '设置上游分支', exact: true })
    await expect(upstream).toBeVisible()
    await expect(upstream.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
    await upstream
      .getByLabel('远程上游分支', { exact: true })
      .selectOption('refs/remotes/origin/main')
    await expect(upstream.getByRole('button', { name: '确认', exact: true })).toBeEnabled()
    await upstream.getByRole('button', { name: '取消', exact: true }).click()
    await git.git(repo, ['branch', '--set-upstream-to=origin/main', 'main'])
    await writeFile(repo + '/draft.txt', 'keep this draft\n')
    await reload()
    menu = await branchMenu('main')
    await expect(menu.getByRole('menuitem', { name: '拉取', exact: true })).toBeEnabled()
    await menu.getByRole('menuitem', { name: '拉取', exact: true }).click()
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeEnabled()
    await pull.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('.stash-sidebar-entry').click({ button: 'right' })
    menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: '应用贮藏', exact: true })).toBeEnabled()
    await menu.getByRole('menuitem', { name: '应用贮藏', exact: true }).click()
    const stash = page.getByRole('region', { name: '贮藏详情', exact: true })
    await expect(stash).toBeVisible()
    const consent = stash.getByRole('region', { name: '确认恢复到有修改的工作区', exact: true })
    await expect(consent).toBeVisible()
    await expect(consent.getByRole('button', { name: '继续恢复并保留', exact: true })).toBeEnabled()
    await capture('stash-dirty-confirmation')
    await consent.getByRole('button', { name: '取消恢复', exact: true }).click()
    await expect(consent).not.toBeVisible()
    assert.equal(writes, 0, 'Blocked operations must not send a Git write request')
    assert.equal(await git.head(repo), base)
    assert.equal(await git.currentBranch(repo), 'main')
    assert.equal((await git.git(repo, ['stash', 'list'])).split('\n').filter(Boolean).length, 1)
    return {
      menuItemsStayEnabled: true,
      currentBranchActionsHidden: true,
      noncurrentPullExplained: true,
      upstreamSetupExplained: true,
      dirtyPullBlockedAndStashRequiresConsent: true,
      gitWriteRequests: writes,
    }
  } finally {
    page.off('request', countWrites)
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
