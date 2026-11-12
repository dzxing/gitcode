import { confirmFixtureTrust } from './confirm-fixture-trust.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Real checkout through the browser HTTP core; all Git writes are disposable.
export async function verifyReferenceCheckout(
  page,
  { url = 'http://localhost:43187/', screenshotDirectory } = {},
) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-reference-checkout-'))
  const git = new GitService(),
    actions = []
  page.on('request', (request) => {
    if (request.url().endsWith('/__gitcode/rpc')) {
      const body = request.postDataJSON()
      if (body.method === 'action') actions.push(body.args[1])
    }
  })
  const commit = async (file, content, message) => {
    await writeFile(path.join(repo, file), content)
    await git.git(repo, ['add', '--', file])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  const actionResponse = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/__gitcode/rpc') &&
        response.request().postDataJSON()?.method === 'action',
    )
  try {
    await git.git(repo, ['init', '--initial-branch=main'])
    for (const [key, value] of [
      ['user.name', 'Reference UI test'],
      ['user.email', 'reference-ui@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    const base = await commit('shared.txt', 'base\n', 'Base version')
    await git.git(repo, ['switch', '-c', 'feature/label-target'])
    const featureHead = await commit('shared.txt', 'feature version\n', 'Feature version')
    await git.git(repo, ['tag', 'feature-mark'])
    await git.git(repo, ['switch', '-c', 'remote-fixture', 'main'])
    const remoteHead = await commit('remote.txt', 'remote\n', 'Remote-only version')
    await git.git(repo, ['update-ref', 'refs/remotes/origin/remote-only', remoteHead])
    await git.git(repo, ['switch', '-c', 'tag-fixture', 'main'])
    await commit('tag.txt', 'tag\n', 'Tag-only version')
    await git.git(repo, ['tag', 'visual-tag'])
    await git.git(repo, ['switch', 'main'])
    await git.git(repo, ['branch', '-D', 'remote-fixture', 'tag-fixture'])
    await writeFile(path.join(repo, 'shared.txt'), 'local edits must survive\n')
    await writeFile(path.join(repo, 'keep.txt'), 'untracked file must survive\n')
    const indexPath = path.join(repo, '.git', 'index'),
      beforeIndex = await readFile(indexPath)
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    assert.equal(await page.evaluate(() => typeof window.gitk), 'undefined')
    await page.keyboard.press('Control+o')
    await page.getByLabel('仓库路径', { exact: true }).fill(repo)
    await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
    await confirmFixtureTrust(page)
    for (const ref of ['origin/remote-only', 'tag: visual-tag']) {
      await page.getByRole('button', { name: `查看引用 ${ref}`, exact: true }).click()
      const refs = page.getByRole('dialog', { name: '提交引用', exact: true })
      await expect(refs).toBeVisible()
      await refs.getByRole('button', { name: '关闭引用列表', exact: true }).click()
      assert.equal(actions.length, 0)
    }
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Keep unsaved checkout draft')
    await page.locator(`[data-commit-hash="${base}"] .commit-select`).click()
    await expect(page.locator('.commit-detail h2')).toHaveText('Base version')
    const target = page.getByRole('button', {
      name: '切换到本地分支 feature/label-target',
      exact: true,
    })
    const failedResponse = actionResponse()
    await target.click()
    const failed = (await (await failedResponse).json()).result
    assert.equal(failed.outcome, 'failed')
    await expect(page.locator('.toast.error').last()).toContainText(/overwritten|覆盖/)
    await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
    await expect(page.locator('.commit-detail h2')).toHaveText('Base version')
    await expect(page.locator(`[data-commit-hash="${base}"]`)).toHaveClass(/selected/)
    assert.equal(
      await readFile(path.join(repo, 'shared.txt'), 'utf8'),
      'local edits must survive\n',
    )
    assert.deepEqual(await readFile(indexPath), beforeIndex)
    assert.equal(await git.currentBranch(repo), 'main')
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, 'blocked-checkout.png') })
    }
    await page
      .getByRole('dialog', { name: '本地修改阻止切换', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click()
    // Remove only our test fixture's tracked edit, retaining its untracked file.
    await writeFile(path.join(repo, 'shared.txt'), 'base\n')
    const succeededResponse = actionResponse()
    await target.dblclick()
    const succeeded = (await (await succeededResponse).json()).result
    assert.equal(succeeded.outcome, 'succeeded')
    await expect(page.locator('.branch-selector summary strong')).toHaveText('feature/label-target')
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Keep unsaved checkout draft',
    )
    const current = page.getByRole('button', { name: '当前分支 feature/label-target', exact: true })
    await expect(current).toBeFocused()
    assert.equal(actions.length, 2, 'A double-click must issue only one additional checkout')
    assert.deepEqual(
      actions.map((request) => ({
        action: request.action,
        name: request.name,
        expectedOid: request.expectedOid,
      })),
      Array.from({ length: 2 }, () => ({
        action: 'checkout',
        name: 'feature/label-target',
        expectedOid: featureHead,
      })),
    )
    assert.equal(await git.currentBranch(repo), 'feature/label-target')
    assert.equal(await readFile(path.join(repo, 'shared.txt'), 'utf8'), 'feature version\n')
    assert.equal(
      await readFile(path.join(repo, 'keep.txt'), 'utf8'),
      'untracked file must survive\n',
    )
    assert.equal((await git.git(repo, ['rev-parse', 'main'])).trim(), base)
    await current.click()
    assert.equal(actions.length, 2)
    await page.locator(`[data-commit-hash="${featureHead}"] .ref-more`).click()
    const refs = page.getByRole('dialog', { name: '提交引用', exact: true })
    await expect(refs.locator('li')).toHaveCount(2)
    await refs.getByRole('button', { name: '关闭引用列表', exact: true }).click()
    if (screenshotDirectory)
      await page.screenshot({ path: path.join(screenshotDirectory, 'successful-checkout.png') })
    return {
      realGit: true,
      checkoutRequests: actions.length,
      dirtyCheckoutRejected: true,
      originalEditAndIndexPreserved: true,
      doubleClickDeduplicated: true,
      expectedOidVerified: true,
      draftPreserved: true,
      remoteAndTagReadOnly: true,
      referenceListRetained: true,
      testMainUnchanged: true,
    }
  } finally {
    // Trigger pagehide so the real HTTP session is released before cleanup.
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true })
  }
}
