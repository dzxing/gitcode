import { confirmFixtureTrust } from './confirm-fixture-trust.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')
export async function verifyGitFlowFinish(
  page,
  {
    url,
    type = 'feature',
    conflict = false,
    stop = false,
    keep = false,
    collision = false,
    stale = false,
    recover = false,
    dirty = false,
    width = 1440,
    height = 900,
    screenshotDirectory,
  } = {},
) {
  const expectedTag = collision && recover ? 'v1.2.4' : 'v1.2.3'
  const repo = await mkdtemp(path.join(tmpdir(), 'gitcode-flow-browser-')),
    git = new GitService(),
    suffix = type === 'feature' ? 'browser-work' : '1.2.3',
    branch = type + '/' + suffix
  const action = async (click) => {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const result = await (await pending).json()
    assert.equal(result.error, undefined)
    return result.result
  }
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      if (!(await page.locator('dialog[open]').count())) {
        const notices = page
          .locator('.toast')
          .getByRole('button', { name: '关闭提示', exact: true })
        for (let i = 0; i < 10 && (await notices.count()); i++) {
          try {
            await notices.first().click({ timeout: 500 })
          } catch {
            break
          }
        }
      }
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') })
    }
  }
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  const openRepo = async () => {
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await dialog.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await confirmFixtureTrust(page)
    await expect(dialog).not.toBeVisible()
  }
  const label = type === 'feature' ? '完成功能分支' : type === 'release' ? '完成发布' : '完成热修复'
  try {
    await page.setViewportSize({ width, height })
    await git.git(repo, ['init', '-b', 'production'])
    for (const [k, v] of [
      ['user.name', 'GitFlow Browser'],
      ['user.email', 'flow-browser@example.test'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
      ['core.autocrlf', 'false'],
      ['gitflow.branch.master', 'production'],
      ['gitflow.branch.develop', 'develop'],
      ['gitflow.prefix.feature', 'feature/'],
      ['gitflow.prefix.release', 'release/'],
      ['gitflow.prefix.hotfix', 'hotfix/'],
      ['gitflow.prefix.versiontag', 'v'],
    ])
      await git.git(repo, ['config', k, v])
    await writeFile(repo + '/shared.txt', 'base\n')
    const base = await commit('base')
    await git.git(repo, ['branch', 'develop'])
    // A local bare remote makes it possible to prove Finish never publishes.
    const bare = path.join(repo, '.git', 'test-remote.git')
    await git.git(repo, ['init', '--bare', bare])
    await git.git(repo, ['remote', 'add', 'origin', bare])
    await git.git(repo, ['push', 'origin', 'production', 'develop'])
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText(/(?:本机核心|Git 服务)已连接/)
    await openRepo()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
    const panel = page.locator('.gitflow-panel')
    await panel.getByRole('button', { name: '开始新分支…', exact: true }).click()
    await panel.getByRole('button', { name: new RegExp('^' + type) }).click()
    await panel.getByRole('textbox', { name: '分支名称', exact: true }).fill(suffix)
    const created = await action(() =>
      panel.getByRole('button', { name: '创建并切换', exact: true }).click(),
    )
    assert.equal(created.outcome, 'succeeded', created.error)
    assert.equal(created.snapshot.branch, branch)
    await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    await writeFile(repo + '/shared.txt', 'source ' + type + '\n')
    const source = await commit('source ' + type)
    if (conflict) {
      await git.git(repo, ['switch', 'develop'])
      await writeFile(repo + '/shared.txt', 'develop content\n')
      await commit('parallel develop')
      await git.git(repo, ['switch', branch])
    }
    if (collision) await git.git(repo, ['tag', 'v1.2.3'])
    if (dirty) await writeFile(repo + '/finish-draft.txt', 'local draft survives Finish\n')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(
      page.locator('.toolbar-actions').getByRole('button', { name: '刷新', exact: true }),
    ).toBeEnabled()
    await expect(page.locator('.branch-row-action')).toHaveCount(0)
    const row = page.locator(`[data-sidebar-section="gitflow"] [data-branch-name="${branch}"]`)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: `完成 ${branch}`, exact: true }).click()
    const confirm = page.getByRole('dialog', { name: label, exact: true })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('combobox')).toHaveCount(0)
    await expect(confirm).toContainText(type === 'feature' ? 'develop' : 'production')
    await confirm
      .getByRole('checkbox', { name: '完成后删除本地分支', exact: true })
      .setChecked(!keep)
    await capture('finish-confirmation')
    await expect(
      confirm.getByRole('button', { name: '关闭 GitFlow 完成确认', exact: true }),
    ).toBeInViewport()
    await expect(confirm.getByRole('heading', { name: label, exact: true })).toBeInViewport()
    await expect(confirm.getByRole('button', { name: label, exact: true })).toBeInViewport()
    if (stale) {
      await git.git(repo, ['switch', 'develop'])
      await writeFile(repo + '/parallel.txt', 'external target movement\n')
      await commit('external update')
      await git.git(repo, ['switch', branch])
    }
    let result = await action(() =>
      confirm.getByRole('button', { name: label, exact: true }).click(),
    )
    if (collision || stale) {
      assert.equal(result.outcome, 'failed')
      await expect(confirm.getByRole('alert')).toContainText(collision ? '已存在' : '已变化')
      assert.equal((await git.git(repo, ['rev-parse', 'production'])).trim(), base)
      assert.ok(result.snapshot.branches.some((b) => b.name === branch))
      await capture('precondition-blocked')
      if (!recover) return { type, collision, stale, blockedBeforeTargetsChanged: true }
      if (collision) {
        await confirm.getByRole('textbox', { name: '版本标签名称', exact: true }).fill(expectedTag)
        await confirm
          .getByRole('textbox', { name: '版本标签说明', exact: true })
          .fill('New version without replacing existing tag')
      } else await confirm.getByRole('button', { name: '重新检查', exact: true }).click()
      result = await action(() => confirm.getByRole('button', { name: label, exact: true }).click())
    }
    if (conflict) {
      assert.equal(result.outcome, 'partial', result.error)
      const list = page.getByRole('region', { name: '解决冲突', exact: true })
      await expect(list).toBeVisible()
      await expect(
        page.getByRole('region', { name: 'GitFlow 执行进度', exact: true }),
      ).toBeVisible()
      const production = (await git.git(repo, ['rev-parse', 'production'])).trim()
      await capture('paused-at-conflict')
      if (stop) {
        await list.getByRole('button', { name: '中止合并', exact: true }).click()
        result = await action(() =>
          list.getByRole('button', { name: '确认中止合并', exact: true }).click(),
        )
        assert.equal(result.outcome, 'succeeded', result.error)
        await writeFile(repo + '/local-draft.txt', 'keep new local draft\n')
        const progress = page.getByRole('region', { name: 'GitFlow 执行进度', exact: true })
        await progress.getByRole('button', { name: '停止后续步骤', exact: true }).click()
        result = await action(() =>
          progress.getByRole('button', { name: '确认停止后续步骤', exact: true }).click(),
        )
        assert.equal(result.outcome, 'succeeded', result.error)
        assert.equal(await readFile(repo + '/local-draft.txt', 'utf8'), 'keep new local draft\n')
        assert.equal((await git.git(repo, ['rev-parse', 'production'])).trim(), production)
        assert.ok(result.snapshot.branches.some((b) => b.name === branch))
        await capture('stopped-preserves-completed-work')
        return { type, stopped: true, sourceRetained: true, completedProductionPreserved: true }
      }
      await list.locator('.conflict-file-name').click()
      const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
      await expect(editor).toBeVisible({ timeout: 15000 })
      await expect(editor.locator('.merge-pane:last-child h3')).toContainText('production')
      await editor
        .getByRole('textbox', { name: '编辑合并结果', exact: true })
        .fill('combined ' + type + '\n')
      await capture('resolve-in-three-panes')
      result = await action(() =>
        editor.getByRole('button', { name: '保存并标记已解决', exact: true }).click(),
      )
      assert.equal(result.outcome, 'succeeded', result.error)
      const ready = page.getByRole('region', { name: '检查合并结果', exact: true })
      await expect(ready).toBeVisible()
      await ready.getByRole('button', { name: '稍后处理', exact: true }).click()
      await page.reload()
      await expect(page.locator('.repo-selector')).toHaveAttribute('title', '打开本地仓库：' + repo)
      await expect(
        page.getByRole('dialog', { name: '信任此仓库？', exact: true }),
      ).not.toBeVisible()
      const progress = page.getByRole('region', { name: 'GitFlow 执行进度', exact: true })
      await expect(progress).toBeVisible()
      await expect(ready).toBeVisible()
      await capture('resume-after-reopen')
      result = await action(() =>
        ready.getByRole('button', { name: '完成当前合并并继续', exact: true }).click(),
      )
      assert.equal(
        (await git.git(repo, ['rev-parse', 'production'])).trim(),
        production,
        'Resume must not repeat the production merge',
      )
    }
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    assert.equal(result.snapshot.gitflow.finish, null)
    assert.equal(result.snapshot.branch, 'develop')
    assert.equal(
      result.snapshot.branches.some((b) => b.name === branch),
      keep,
    )
    assert.equal((await git.git(repo, ['merge-base', source, 'develop'])).trim(), source)
    if (type !== 'feature') {
      const prod = (await git.git(repo, ['rev-parse', 'production'])).trim()
      assert.equal((await git.git(repo, ['rev-parse', expectedTag + '^{}'])).trim(), prod)
      assert.equal((await git.git(repo, ['cat-file', '-t', expectedTag])).trim(), 'tag')
    } else assert.equal((await git.git(repo, ['rev-parse', 'production'])).trim(), base)
    if (collision && recover)
      assert.equal((await git.git(repo, ['rev-parse', 'v1.2.3'])).trim(), source)
    if (stale && recover)
      assert.equal(await readFile(repo + '/parallel.txt', 'utf8'), 'external target movement\n')
    assert.equal((await git.git(bare, ['rev-parse', 'refs/heads/production'])).trim(), base)
    assert.equal((await git.git(bare, ['tag', '--list'])).trim(), '')
    assert.equal(
      await readFile(repo + '/shared.txt', 'utf8'),
      conflict ? 'combined ' + type + '\n' : 'source ' + type + '\n',
    )
    await capture('finished')
    if (dirty) {
      assert.equal(
        await readFile(repo + '/finish-draft.txt', 'utf8'),
        'local draft survives Finish\n',
      )
      assert.equal((await git.stash.list(repo)).entries.length, 0)
    }
    return {
      type,
      conflict,
      keep,
      source,
      recover,
      realStartAndFinish: true,
      automaticLocalProtection: dirty,
      noRemoteWrites: true,
      tagAtProduction: type !== 'feature',
      restartResumes: conflict,
      sourceDeleted: !keep,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(repo, { recursive: true, force: true, maxRetries: 3 })
  }
}
