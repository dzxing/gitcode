import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

export async function verifyGitKrakenParity(page, { url, screenshotDirectory } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-parity-ui-'))
  const repo = path.join(root, 'local'),
    bare = path.join(root, 'remote.git'),
    git = new GitService()
  const actions = []
  const action = async (click) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
      ),
      click(),
    ])
    const result = (await response.json()).result
    actions.push(result.outcome)
    return result
  }
  const capture = async (name) => {
    if (!screenshotDirectory) return
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`) })
  }
  try {
    await mkdir(repo)
    await git.git(repo, ['init', '-b', 'main'])
    for (const [k, v] of [
      ['user.name', 'Parity UI'],
      ['user.email', 'parity-ui@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', k, v])
    const commit = async (file, text, message) => {
      await writeFile(path.join(repo, file), text)
      await git.git(repo, ['add', '.'])
      await git.git(repo, ['commit', '-m', message])
      return git.head(repo)
    }
    const base = await commit('draft.txt', 'base\n', 'base')
    await git.git(repo, ['init', '--bare', bare])
    await git.git(repo, ['remote', 'add', 'origin', bare])
    await git.git(repo, ['push', 'origin', 'main'])
    await git.git(repo, ['switch', '-c', 'topic'])
    const topic = await commit('topic.txt', 'local history\n', 'local topic')
    await git.git(repo, ['switch', '-c', 'remote-work', 'main'])
    const incoming = await commit('incoming.txt', 'remote update\n', 'remote update')
    await git.git(repo, ['push', 'origin', 'HEAD:main'])
    await git.git(repo, ['switch', 'main'])
    await git.git(repo, ['branch', '-D', 'remote-work'])
    await git.git(repo, ['update-ref', 'refs/remotes/origin/topic', base])
    await writeFile(path.join(repo, 'draft.txt'), 'local draft\n')
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    await page.keyboard.press('Control+o')
    await page.getByLabel('仓库路径', { exact: true }).fill(repo)
    await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '拉取', exact: true })
      .click()
    const upstream = page.getByRole('dialog', { name: '设置上游分支', exact: true })
    await expect(upstream).toBeVisible()
    await upstream.getByLabel('远程分支', { exact: true }).selectOption('refs/remotes/origin/main')
    await upstream.getByRole('button', { name: '设置并继续拉取', exact: true }).click()
    const pull = page.getByRole('dialog', { name: '拉取远程分支', exact: true })
    await expect(
      pull.getByRole('button', { name: '尽可能快进（否则合并）', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeEnabled()
    const pulled = await action(() =>
      pull.getByRole('button', { name: '确认拉取', exact: true }).click(),
    )
    assert.equal(pulled.outcome, 'succeeded', JSON.stringify(pulled))
    assert.equal(await git.head(repo), incoming)
    assert.equal(await readFile(path.join(repo, 'draft.txt'), 'utf8'), 'local draft\n')
    assert.equal(pulled.snapshot.stashes.length, 0)
    await capture('pull-autostash-restored')
    const remoteSection = page.locator('[data-sidebar-section="remote"]')
    const toggle = remoteSection.locator('.section-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    const row = remoteSection.locator('[data-branch-name="origin/topic"] .branch-main')
    await action(() => row.dblclick())
    const choice = page.getByRole('dialog', { name: '检出 origin/topic', exact: true })
    await expect(choice).toBeVisible()
    await capture('remote-checkout-choice')
    await choice.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await git.currentBranch(repo), 'main')
    assert.equal((await git.git(repo, ['rev-parse', 'topic'])).trim(), topic)
    await action(() => row.dblclick())
    await choice.getByLabel('新本地分支名称', { exact: true }).fill('topic-copy')
    const created = await action(() =>
      choice.getByRole('button', { name: '新建分支并检出', exact: true }).click(),
    )
    assert.equal(created.outcome, 'succeeded', JSON.stringify(created))
    assert.equal(created.snapshot.branch, 'topic-copy')
    assert.equal((await git.git(repo, ['rev-parse', 'topic'])).trim(), topic)
    assert.equal(await readFile(path.join(repo, 'draft.txt'), 'utf8'), 'local draft\n')
    await action(() => row.dblclick())
    const reset = await action(() =>
      choice.getByRole('button', { name: '重置本地分支并检出', exact: true }).click(),
    )
    assert.equal(reset.outcome, 'succeeded', JSON.stringify(reset))
    assert.equal(reset.snapshot.branch, 'topic')
    assert.equal(reset.snapshot.head, base)
    assert.match(await git.git(repo, ['reflog', 'show', '--format=%H', 'topic']), new RegExp(topic))
    assert.equal(await readFile(path.join(repo, 'draft.txt'), 'utf8'), 'local draft\n')
    assert.equal((await git.git(repo, ['rev-parse', 'main'])).trim(), incoming)
    await capture('remote-reset-restored')
    return {
      passed: true,
      cases: [
        'toolbar upstream setup continues pull',
        'default merge pull restores dirty files',
        'remote checkout cancel preserves local history',
        'remote checkout create preserves original branch',
        'explicit reset preserves local file edits and reflog',
      ],
      actions,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
