import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Every remote and clone is disposable and local; never contact a user remote.
export async function verifySyncDivergence(
  page,
  { url, sameLine = false, screenshotDirectory, mergeAfter = false, abortMerge = false } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-divergence-')),
    git = new GitService()
  const local = path.join(root, 'local'),
    peer = path.join(root, 'peer'),
    bare = path.join(root, 'remote.git')
  const capture = async (name) => {
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      const notices = page.locator('.toast').getByRole('button', { name: '关闭提示', exact: true })
      if (!(await page.locator('dialog[open]').count()))
        for (let i = 0; i < 10 && (await notices.count()); i++) {
          try {
            await notices.first().click({ timeout: 1000 })
          } catch {
            break
          }
        }
      await page.screenshot({
        path: path.join(
          screenshotDirectory,
          `${sameLine ? 'same-line' : 'different-files'}-${name}.png`,
        ),
      })
    }
  }
  const configure = async (repo) => {
    for (const [k, v] of [
      ['user.name', 'Divergence test'],
      ['user.email', 'divergence@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
      ['core.autocrlf', 'false'],
    ])
      await git.git(repo, ['config', k, v])
  }
  const commit = async (repo, message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  const action = async (click) => {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
    )
    await click()
    const payload = await (await pending).json()
    assert.equal(payload.error, undefined)
    return payload.result
  }
  try {
    await mkdir(local)
    await git.git(local, ['init', '-b', 'test/divergence'])
    await configure(local)
    await writeFile(local + '/shared.txt', 'base line\n')
    const base = await commit(local, 'Shared base')
    await git.git(local, ['init', '--bare', bare])
    await git.git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/test/divergence'])
    await git.git(local, ['remote', 'add', 'origin', bare])
    await git.git(local, ['push', '-u', 'origin', 'test/divergence'])
    await git.git(local, ['clone', bare, peer])
    await configure(peer)
    await git.git(local, ['branch', '--track', 'test/behind', 'origin/test/divergence'])
    await writeFile(local + '/local-existing.txt', 'already committed locally\n')
    const previousLocal = await commit(local, 'Existing local commit')
    await writeFile(peer + (sameLine ? '/shared.txt' : '/remote.txt'), 'remote contribution\n')
    const remoteHead = await commit(peer, 'Peer remote commit')
    await git.git(peer, ['push', 'origin', 'test/divergence'])
    const file = sameLine ? 'shared.txt' : 'local-next.txt',
      content = 'next local contribution\n'
    await writeFile(path.join(local, file), content)
    await git.git(local, ['add', file])
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByRole('textbox', { name: '仓库路径', exact: true }).fill(local)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(open).not.toBeVisible()
    await expect(page.locator('.status-path')).toHaveAttribute('title', local)
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Commit while remote has advanced')
    const committed = await action(() =>
      page.getByRole('button', { name: /提交全部已暂存/ }).click(),
    )
    assert.equal(committed.outcome, 'succeeded', committed.error)
    const localHead = committed.snapshot.head
    assert.notEqual(localHead, previousLocal)
    assert.equal((await git.git(local, ['rev-parse', 'HEAD^'])).trim(), previousLocal)
    assert.equal(
      (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
      remoteHead,
    )
    assert.equal(
      (await git.git(local, ['rev-parse', 'refs/remotes/origin/test/divergence'])).trim(),
      base,
      'Local commit must not implicitly fetch',
    )
    const currentRow = page.locator(
      '[data-sidebar-section="local"] [data-branch-name="test/divergence"]',
    )
    await expect(currentRow.locator('.branch-current-check')).toBeVisible()
    await expect(currentRow.locator('.is-ahead')).toHaveText('↑2')
    await expect(currentRow.locator('.is-behind')).toHaveCount(0)
    await capture('local-commit-succeeded')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '推送', exact: true })
      .click()
    const push = page.getByRole('dialog', { name: '推送指定分支', exact: true })
    await expect(push.getByRole('button', { name: '确认推送', exact: true })).toBeEnabled()
    const pushed = await action(() =>
      push.getByRole('button', { name: '确认推送', exact: true }).click(),
    )
    assert.equal(pushed.outcome, 'failed')
    assert.match(pushed.error, /rejected|fetch first|non-fast-forward|拒绝/i)
    await expect(push.getByRole('alert')).toContainText(pushed.error)
    await expect(push).toBeVisible()
    assert.equal(await git.head(local), localHead)
    assert.equal(
      (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
      remoteHead,
    )
    await expect(push.getByRole('button', { name: '确认推送', exact: true })).toBeDisabled()
    await expect(push.getByRole('button', { name: '重新读取目标', exact: true })).toBeVisible()
    await capture('push-rejected')
    if (mergeAfter) {
      const fetched = await action(() =>
        push.getByRole('button', { name: '获取并检查更新', exact: true }).click(),
      )
      assert.equal(fetched.outcome, 'succeeded', fetched.error)
    } else {
      await push.getByRole('button', { name: '取消', exact: true }).click()
      await page
        .locator('.toolbar-actions')
        .getByRole('button', { name: '拉取', exact: true })
        .click()
    }
    const pull = page.getByRole('dialog', { name: '拉取远程分支（仅快进）', exact: true })
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeEnabled()
    const pulled = await action(() =>
      pull.getByRole('button', { name: '确认拉取', exact: true }).click(),
    )
    assert.equal(pulled.outcome, 'partial')
    assert.match(pulled.error, /fast-forward|快进/i)
    await expect(pull.getByRole('alert')).toContainText(pulled.error)
    await expect(pull).toBeVisible()
    assert.equal(pulled.snapshot.head, localHead)
    assert.equal(
      (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
      remoteHead,
    )
    assert.equal(
      pulled.snapshot.branches.find((b) => b.name === 'origin/test/divergence').hash,
      remoteHead,
    )
    assert.equal(await git.git(local, ['status', '--porcelain=v1']), '')
    assert.equal(await readFile(path.join(local, file), 'utf8'), content)
    assert.equal(
      (
        await git.git(local, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
          allowedCodes: [0, 1],
        })
      ).trim(),
      '',
    )
    assert.equal(
      (
        await git.git(local, ['for-each-ref', '--format=%(refname)', 'refs/gitcode/requests/'])
      ).trim(),
      '',
    )
    assert.equal(
      (
        await git.git(local, [
          'rev-list',
          '--left-right',
          '--count',
          'HEAD...origin/test/divergence',
        ])
      ).trim(),
      '2\t1',
    )
    await expect(currentRow.locator('.is-ahead')).toHaveText('↑2')
    await expect(currentRow.locator('.is-behind')).toHaveText('↓1')
    await expect(currentRow.locator('.branch-current-check')).toBeVisible()
    await expect(
      page.locator('[data-sidebar-section="local"] [data-branch-name="test/behind"] .is-behind'),
    ).toHaveText('↓1')
    await capture('pull-stops-at-divergence')
    // Execution plans are single use. A retry must explicitly read a fresh plan.
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeDisabled()
    await pull.getByRole('button', { name: '重新读取目标', exact: true }).click()
    await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeEnabled()
    const retry = await action(() =>
      pull.getByRole('button', { name: '确认拉取', exact: true }).click(),
    )
    assert.equal(retry.outcome, 'partial')
    assert.match(retry.error, /fast-forward|快进/i)
    assert.equal(await git.head(local), localHead)
    let mergeReport
    if (mergeAfter) {
      await expect(pull.getByRole('button', { name: '合并远端更新', exact: true })).toBeEnabled()
      await pull.getByRole('button', { name: '合并远端更新', exact: true }).click()
      await expect(pull.getByRole('button', { name: '合并远端更新', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(pull.getByRole('button', { name: '确认拉取', exact: true })).toBeEnabled()
      const integrated = await action(() =>
        pull.getByRole('button', { name: '确认拉取', exact: true }).click(),
      )
      assert.equal(integrated.outcome, sameLine ? 'partial' : 'succeeded', integrated.error)
      const list = () =>
        page.getByRole('dialog', { name: sameLine ? '解决冲突' : '检查合并结果', exact: true })
      await expect(list()).toBeVisible()
      assert.equal((await git.merge.state(local)).incoming, remoteHead)
      assert.equal(await git.head(local), localHead)
      await capture('merge-results')
      if (abortMerge) {
        await list().getByRole('button', { name: '中止合并', exact: true }).click()
        await expect(list().getByRole('group', { name: '确认中止合并' })).toBeVisible()
        const aborted = await action(() =>
          list().getByRole('button', { name: '确认中止合并', exact: true }).click(),
        )
        assert.equal(aborted.outcome, 'succeeded', aborted.error)
        assert.equal(aborted.snapshot.merge, null)
        assert.equal(aborted.snapshot.head, localHead)
        assert.equal(await readFile(path.join(local, file), 'utf8'), content)
        assert.equal(
          (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
          remoteHead,
        )
        await capture('merge-aborted')
        mergeReport = { aborted: true, preMergeStateRestored: true }
      } else {
        if (sameLine) {
          await expect(list().getByRole('button', { name: '完成合并', exact: true })).toBeDisabled()
          await list().locator('.conflict-file-name').dblclick()
          const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
          await expect(editor).toBeVisible()
          await expect(
            editor.getByRole('button', { name: '保存并标记已解决', exact: true }),
          ).toBeDisabled()
          await expect(editor).toContainText('当前分支 · test/divergence')
          await editor.getByRole('button', { name: '本块保留双方', exact: true }).click()
          const draft = editor.getByRole('textbox', { name: '编辑合并结果', exact: true })
          await expect(draft).toHaveValue('next local contribution\nremote contribution\n')
          await draft.fill('next local contribution\nremote contribution\ncustom resolution\n')
          await capture('three-way-editor')
          for (const width of [1100, 900]) {
            await page.setViewportSize({ width, height: 700 })
            const rect = await editor.boundingBox()
            assert.ok(rect.x >= 0 && rect.x + rect.width <= width)
            await expect(
              editor.getByRole('button', { name: '保存并标记已解决', exact: true }),
            ).toBeInViewport()
            await capture('three-way-editor-' + width)
          }
          await page.setViewportSize({ width: 1600, height: 1000 })
          // Closing a view does not discard an unsaved resolution draft.
          await editor.getByRole('button', { name: '返回冲突列表', exact: true }).click()
          await list().getByRole('button', { name: '稍后处理', exact: true }).click()
          await page.locator('.repo-tab.active .tab-close').click()
          const closeDraft = page.getByRole('dialog', { name: '关闭这个仓库标签？', exact: true })
          await expect(closeDraft).toContainText('冲突处理草稿')
          await closeDraft.getByRole('button', { name: '保留标签', exact: true }).click()
          await page.getByRole('button', { name: '继续处理冲突', exact: true }).click()
          await list().locator('.conflict-file-name').dblclick()
          await expect(draft).toHaveValue(
            'next local contribution\nremote contribution\ncustom resolution\n',
          )
          const resolved = await action(() =>
            editor.getByRole('button', { name: '保存并标记已解决', exact: true }).click(),
          )
          assert.equal(resolved.outcome, 'succeeded', resolved.error)
          assert.equal(resolved.snapshot.merge.files.length, 0)
        }
        const ready = page.getByRole('dialog', { name: '检查合并结果', exact: true })
        await expect(ready).toBeVisible()
        await capture('all-files-resolved')
        await ready.getByRole('button', { name: '稍后处理', exact: true }).click()
        // A new renderer and HTTP session must recover Git's unfinished merge state.
        await page.reload()
        await page.keyboard.press('Control+o')
        const reopen = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
        await reopen.getByRole('textbox', { name: '仓库路径', exact: true }).fill(local)
        await reopen.getByRole('button', { name: '打开仓库', exact: true }).click()
        await expect(reopen).not.toBeVisible()
        await expect(ready).toBeVisible()
        await ready
          .getByRole('textbox', { name: '合并提交说明', exact: true })
          .fill('Merge remote updates after review')
        const completed = await action(() =>
          ready.getByRole('button', { name: '完成合并', exact: true }).click(),
        )
        assert.equal(completed.outcome, 'succeeded', completed.error)
        assert.equal(completed.snapshot.merge, null)
        const mergeHead = completed.snapshot.head
        assert.deepEqual(
          (await git.git(local, ['show', '-s', '--format=%P', mergeHead])).trim().split(' '),
          [localHead, remoteHead],
        )
        assert.equal(
          (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
          remoteHead,
          'Merge must not implicitly push',
        )
        if (sameLine)
          assert.equal(
            await readFile(path.join(local, file), 'utf8'),
            'next local contribution\nremote contribution\ncustom resolution\n',
          )
        else {
          assert.equal(await readFile(local + '/remote.txt', 'utf8'), 'remote contribution\n')
          assert.equal(await readFile(path.join(local, file), 'utf8'), content)
        }
        await page
          .locator('.toolbar-actions')
          .getByRole('button', { name: '推送', exact: true })
          .click()
        const pushAgain = page.getByRole('dialog', { name: '推送指定分支', exact: true })
        await expect(pushAgain.getByRole('button', { name: '确认推送', exact: true })).toBeEnabled()
        const finalPush = await action(() =>
          pushAgain.getByRole('button', { name: '确认推送', exact: true }).click(),
        )
        assert.equal(finalPush.outcome, 'succeeded', finalPush.error)
        assert.equal(
          (await git.git(bare, ['rev-parse', 'refs/heads/test/divergence'])).trim(),
          mergeHead,
        )
        await capture('merge-completed-and-pushed')
        mergeReport = {
          completed: true,
          mergeHead,
          parents: [localHead, remoteHead],
          explicitPushSucceeded: true,
          reloadResumesMerge: true,
          customResolutionPreserved: sameLine,
        }
      }
    }
    return {
      sameLine,
      base,
      localHead,
      remoteHead,
      localCommit: committed.outcome,
      push: pushed.outcome,
      pushError: pushed.error,
      pushWarning: pushed.warning,
      pull: pulled.outcome,
      pullError: pulled.error,
      localAndRemoteHeadsPreserved: true,
      worktreeCleanAndContentsPreserved: true,
      noMergeStartedByFastForwardPull: true,
      trackingRefUpdated: true,
      ahead: 2,
      behind: 1,
      consumedPlanDisabledAndExplicitRetryWorks: true,
      mergeReport,
    }
  } finally {
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
