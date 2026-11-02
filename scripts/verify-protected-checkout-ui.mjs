import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

export async function verifyProtectedCheckout(
  page,
  { url = 'http://localhost:43189/', scenario = 'conflict', screenshotDirectory } = {},
) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-checkout-ui-')),
    git = new GitService()
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  const write = (name, text) => writeFile(path.join(repo, name), text)
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  const action = async (click) => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const payload = await (await response).json()
    assert.equal(payload.error, undefined)
    return payload.result
  }
  const open = async () => {
    await page.keyboard.press('Control+o')
    const d = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await d.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await d.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(d).not.toBeVisible()
  }
  try {
    await git.git(repo, ['init', '-b', 'main'])
    for (const [k, v] of [
      ['user.name', 'Checkout UI'],
      ['user.email', 'checkout-ui@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
      ['core.autocrlf', 'false'],
    ])
      await git.git(repo, ['config', k, v])
    await write('shared.txt', 'base\n')
    await commit('base')
    await git.git(repo, ['switch', '-c', 'topic'])
    await write('shared.txt', 'topic\n')
    const target = await commit('topic')
    await git.git(repo, ['switch', 'main'])
    if (scenario !== 'safe') await write('shared.txt', 'my local draft\n')
    if (scenario === 'staged') await git.git(repo, ['add', 'shared.txt'])
    await write('新增 文件.txt', 'untracked draft\n')
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    await open()
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('Keep commit draft')
    const row = page.locator(
      '[data-sidebar-section="local"] [data-branch-name="topic"] .branch-main',
    )
    await row.dblclick()
    const confirmation = page.getByRole('dialog', { name: '切换分支', exact: true })
    const first = await action(() =>
      confirmation.getByRole('button', { name: '确认切换', exact: true }).click(),
    )
    if (scenario === 'safe') {
      assert.equal(first.outcome, 'succeeded', first.error)
      assert.equal(first.snapshot.stashes.length, 0)
      assert.equal(first.snapshot.branch, 'topic')
      assert.equal(await readFile(repo + '/新增 文件.txt', 'utf8'), 'untracked draft\n')
      await capture('safe-carries-edits')
      return { scenario, passed: true, noStash: true }
    }
    assert.equal(first.outcome, 'failed')
    const blocked = page.getByRole('dialog', { name: '本地修改阻止切换', exact: true })
    await expect(blocked).toBeVisible()
    await expect(blocked).toContainText('shared.txt')
    await expect(blocked).toContainText('新增 文件.txt')
    await expect(blocked.getByRole('button', { name: '贮藏并切换', exact: true })).toBeInViewport()
    assert.equal(await git.currentBranch(repo), 'main')
    assert.equal(await readFile(repo + '/shared.txt', 'utf8'), 'my local draft\n')
    await capture('blocked-with-stash-choice')
    if (scenario === 'cancel') {
      await blocked.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal((await git.stash.list(repo)).entries.length, 0)
      assert.equal(await git.currentBranch(repo), 'main')
      return { scenario, passed: true, editsPreserved: true }
    }
    if (scenario === 'stale') await write('shared.txt', 'new editor draft\n')
    const switched = await action(() =>
      blocked.getByRole('button', { name: '贮藏并切换', exact: true }).click(),
    )
    if (scenario === 'stale') {
      assert.equal(switched.outcome, 'failed')
      await expect(blocked.getByRole('alert')).toContainText('已变化')
      await expect(blocked.getByRole('button', { name: '贮藏并切换', exact: true })).toBeDisabled()
      assert.equal((await git.stash.list(repo)).entries.length, 0)
      assert.equal(await readFile(repo + '/shared.txt', 'utf8'), 'new editor draft\n')
      await capture('stale-before-stash')
      await blocked.getByRole('button', { name: '关闭', exact: true }).click()
      return { scenario, passed: true, editsPreserved: true }
    }
    assert.equal(switched.outcome, 'succeeded', switched.error)
    await expect(blocked).not.toBeVisible()
    await expect(page.locator('.branch-selector summary strong')).toHaveText('topic')
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Keep commit draft',
    )
    assert.equal(await readFile(repo + '/shared.txt', 'utf8'), 'topic\n')
    assert.equal(switched.snapshot.stashes.length, 1)
    assert.equal(switched.snapshot.staged.length + switched.snapshot.unstaged.length, 0)
    await capture('switched-stash-kept')
    await page.locator('.stash-row').first().click()
    const panel = page.getByRole('region', { name: '贮藏详情', exact: true })
    await expect(panel).toBeVisible()
    await expect(
      panel.getByRole('checkbox', { name: '恢复原暂存状态', exact: true }),
    ).not.toBeChecked()
    const restored = await action(() =>
      panel.getByRole('button', { name: '恢复并移除', exact: true }).click(),
    )
    assert.equal(restored.outcome, 'partial')
    assert.equal(restored.snapshot.stashes.length, 1)
    assert.equal(restored.snapshot.merge.active, false)
    const list = page.getByRole('dialog', { name: '解决恢复冲突', exact: true })
    await expect(list).toBeVisible()
    await expect(list).toContainText('无需创建合并提交')
    await expect(list.getByRole('button', { name: '中止合并', exact: true })).toHaveCount(0)
    await expect(list.getByRole('button', { name: '完成合并', exact: true })).toHaveCount(0)
    await capture('restore-conflict-list')
    await list.getByRole('button', { name: '稍后处理', exact: true }).click()
    await page.reload()
    await open()
    await expect(list).toBeVisible()
    await list.locator('.conflict-file-name').dblclick()
    const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
    await expect(editor).toBeVisible()
    await expect(editor.locator('.merge-pane:last-child h3')).toHaveText('恢复的修改')
    await editor
      .getByRole('textbox', { name: '编辑合并结果', exact: true })
      .fill('combined draft\n')
    await capture('three-way-recovery')
    const resolved = await action(() =>
      editor.getByRole('button', { name: '保存并标记已解决', exact: true }).click(),
    )
    assert.equal(resolved.outcome, 'succeeded', resolved.error)
    assert.equal(resolved.snapshot.merge, null)
    assert.equal(resolved.snapshot.stashes.length, 1)
    assert.equal(resolved.snapshot.head, target)
    assert.equal(await readFile(repo + '/shared.txt', 'utf8'), 'combined draft\n')
    assert.equal(await readFile(repo + '/新增 文件.txt', 'utf8'), 'untracked draft\n')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await capture('resolved-keeps-stash-and-head')
    return {
      scenario,
      passed: true,
      stashRetained: true,
      reopenRecoversConflict: true,
      noMergeCommit: true,
      untrackedRestored: true,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
