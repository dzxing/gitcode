import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'

const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Real browser HTTP transport and real Git; only the disposable repository is changed.
export async function verifyLocalCore(
  page,
  { url = 'http://localhost:43187/', screenshotPath } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-browser-ui-'))
  const repo = path.join(root, 'browser-project')
  const git = new GitService()
  const methods = []
  page.on('request', (request) => {
    if (request.url().endsWith('/__gitcode/rpc')) methods.push(request.postDataJSON().method)
  })
  try {
    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    assert.equal(
      await page.evaluate(() => typeof window.gitk),
      'undefined',
      'Must exercise browser HTTP, not preload mocks',
    )
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    await page
      .getByRole('main', { name: '新标签页', exact: true })
      .getByRole('button', { name: '创建仓库', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: '创建本地仓库', exact: true })
    await expect(dialog.locator('.local-core-note')).toContainText('本机 Git 核心已连接')
    await dialog.getByRole('button', { name: '父目录', exact: true }).click()
    const directory = page.getByRole('dialog', { name: '选择父目录', exact: true })
    await expect(directory).toBeVisible()
    await expect(directory.getByRole('button', { name: '系统选择器', exact: true })).toHaveCount(0)
    await directory.getByRole('textbox', { name: '目录地址', exact: true }).fill(root)
    await directory.getByRole('textbox', { name: '目录地址', exact: true }).press('Enter')
    await expect(directory.locator('.directory-footer strong')).toHaveText(root)
    await directory.getByRole('button', { name: '选择父目录', exact: true }).click()
    await dialog.getByLabel('新仓库路径', { exact: true }).fill(repo)
    await dialog.getByRole('button', { name: '创建并打开', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.repo-selector strong')).toHaveText('browser-project')
    for (const [key, value] of [
      ['user.name', 'Browser UI test'],
      ['user.email', 'browser-ui@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    // Executable config changed through the fixture Git process: acknowledge
    // it explicitly through the UI before resuming ordinary operations.
    await page.keyboard.press('Control+o')
    const reopen = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await reopen.getByRole('textbox', { name: '仓库路径', exact: true }).fill(repo)
    await reopen.getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(reopen).not.toBeVisible()
    await writeFile(path.join(repo, 'hello.txt'), 'Created through browser verification\n')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(page.locator('.changes-scroll .file-name')).toContainText('hello.txt')
    await page.getByRole('checkbox', { name: '选择暂存 hello.txt', exact: true }).check()
    await page.getByRole('button', { name: /^暂存所选/ }).click()
    await expect(page.locator('.commit-button')).toContainText('提交 1 个文件')
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Browser core verification')
    await page.locator('.commit-button').click()
    await expect(page.locator('.commit-row')).toHaveCount(1)
    const head = await git.head(repo)
    assert.match(head, /^[a-f0-9]{40,64}$/)
    assert.equal(
      (await git.git(repo, ['log', '-1', '--format=%s'])).trim(),
      'Browser core verification',
    )
    assert.equal((await git.status(repo)).staged.length, 0)
    assert.equal((await git.status(repo)).unstaged.length, 0)
    // Reproduce a configured repository whose local develop branch is missing.
    const snapshot = await git.snapshot(repo)
    const configured = await git.action(repo, {
      action: 'gitflow-save',
      expectedHead: head,
      expectedBranch: 'main',
      signature: snapshot.gitflow.signature,
      config: snapshot.gitflow.config,
    })
    assert.equal(configured.outcome, 'succeeded', configured.error)
    assert.equal(configured.snapshot.gitflow.ready, false)
    await writeFile(path.join(repo, 'hello.txt'), 'Keep pending work while repairing GitFlow\n')
    const beforeRepair = await git.git(repo, ['status', '--porcelain=v1', '-z'])
    const beforeIndex = await git.indexFingerprint(repo)
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    const flowSection = page.locator('[data-sidebar-section="gitflow"]')
    await expect(flowSection.locator('.section-count')).toHaveText('—')
    await flowSection.getByRole('button', { name: '补齐基础分支', exact: true }).click()
    await expect(
      page.locator('.gitflow-settings').getByRole('combobox', { name: /develop.*选择起点/ }),
    ).toBeFocused()
    await page.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
    const overview = page.locator('.gitflow-panel')
    await expect(overview.getByText('缺少基础分支：develop', { exact: true })).toBeVisible()
    await overview.getByRole('button', { name: '补齐基础分支', exact: true }).click()
    const settings = page.locator('.gitflow-settings')
    const source = settings.getByRole('combobox', { name: /develop.*选择起点/ })
    await expect(source).toBeInViewport()
    await expect(source).toBeFocused()
    await expect(source).toHaveValue('')
    await expect(settings.getByRole('button', { name: '预览补齐计划', exact: true })).toBeDisabled()
    await source.selectOption('refs/heads/main')
    await settings.getByRole('button', { name: '预览补齐计划', exact: true }).click()
    const plan = settings.locator('[aria-labelledby="flow-init-plan-heading"]')
    await expect(plan).toBeInViewport()
    await expect(plan).toBeFocused()
    await expect(plan).toContainText('保留 main')
    await expect(plan).toContainText('创建 develop')
    await plan.getByRole('button', { name: '确认补齐基础分支', exact: true }).click()
    const result = settings.locator('.gitflow-result')
    await expect(result).toContainText('本地操作已完成')
    await expect(result).toBeInViewport()
    await expect(result).toBeFocused()
    assert.equal((await git.git(repo, ['rev-parse', 'refs/heads/develop'])).trim(), head)
    assert.equal(await git.currentBranch(repo), 'main')
    assert.equal(await git.git(repo, ['status', '--porcelain=v1', '-z']), beforeRepair)
    assert.equal(await git.indexFingerprint(repo), beforeIndex)
    await result.getByRole('button', { name: '开始新分支…', exact: true }).click()
    await expect(overview.getByLabel('分支名称', { exact: true })).toBeVisible()
    await expect(overview).toContainText('本地更改会自动贮藏')
    await expect(overview.getByRole('button', { name: '创建并切换', exact: true })).toBeDisabled()
    // Exercise Start on a clean disposable worktree without touching the user's repo.
    await writeFile(path.join(repo, 'hello.txt'), 'Created through browser verification\n')
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    const branchName = overview.getByLabel('分支名称', { exact: true })
    await branchName.fill('bad..name')
    await expect(overview.getByRole('button', { name: '创建并切换', exact: true })).toBeDisabled()
    await overview.getByRole('checkbox', { name: '创建后切换到新分支', exact: true }).uncheck()
    for (const kind of ['feature', 'release', 'hotfix']) {
      await overview
        .getByRole('group', { name: '分支类型' })
        .getByRole('button', { name: new RegExp(`^${kind}`) })
        .click()
      await branchName.fill('browser-ui-check')
      await expect(overview.locator('.gitflow-full-name').nth(1)).toHaveText(
        kind === 'hotfix' ? 'main' : 'develop',
      )
      const shouldSwitch = kind === 'hotfix'
      if (shouldSwitch)
        await overview.getByRole('checkbox', { name: '创建后切换到新分支', exact: true }).check()
      await overview
        .getByRole('button', { name: shouldSwitch ? '创建并切换' : '仅创建分支', exact: true })
        .click()
      await expect(
        page.locator(
          `[data-sidebar-section="local"] [data-branch-name="${kind}/browser-ui-check"]`,
        ),
      ).toBeVisible()
      await expect(overview.locator('.gitflow-result')).toContainText('本地操作已完成')
      assert.equal(
        (await git.git(repo, ['rev-parse', `refs/heads/${kind}/browser-ui-check`])).trim(),
        head,
      )
      assert.equal(await git.currentBranch(repo), shouldSwitch ? 'hotfix/browser-ui-check' : 'main')
      assert.equal((await git.git(repo, ['rev-parse', 'refs/heads/main'])).trim(), head)
      assert.equal((await git.status(repo)).unstaged.length, 0)
      await expect(branchName).toHaveValue('')
      if (kind === 'feature') {
        await branchName.fill('browser-ui-check')
        await expect(overview.locator('#flow-start-reason')).toContainText('同名本地分支已存在')
        await expect(
          overview.getByRole('button', { name: '仅创建分支', exact: true }),
        ).toBeDisabled()
      }
    }
    await overview.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    await page
      .locator(
        '[data-sidebar-section="local"] [data-branch-name="release/browser-ui-check"] .branch-main',
      )
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: '完成 release/browser-ui-check', exact: true }).click()
    const finishDialog = page.getByRole('dialog', { name: '完成发布', exact: true })
    await expect(finishDialog).toBeVisible()
    await expect(finishDialog.locator('.flow-finish-source')).toContainText(
      'release/browser-ui-check',
    )
    await expect(finishDialog.locator('.flow-finish-targets')).toContainText('main')
    await expect(finishDialog.locator('.flow-finish-targets')).toContainText('develop')
    await expect(finishDialog.getByRole('button', { name: '完成发布', exact: true })).toBeEnabled()
    assert.equal(
      await git.currentBranch(repo),
      'hotfix/browser-ui-check',
      'Viewing Finish must not check out its selected release branch',
    )
    for (const method of ['runtime', 'directory', 'create', 'snapshot', 'action'])
      assert.ok(methods.includes(method), `Missing browser RPC ${method}`)
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })
    return {
      transport: 'browser-http',
      realGit: true,
      temporaryRepositoryOnly: true,
      head,
      methods,
      checks: [
        'connected-without-preload',
        'directory-picker',
        'create-repository',
        'refresh-changes',
        'stage-file',
        'commit',
        'clean-worktree',
        'sidebar-repair-direct-entry',
        'repair-source-in-viewport-and-focused',
        'explicit-source-before-preview',
        'repair-plan-visible',
        'repair-preserves-dirty-files-and-head',
        'repair-result-and-next-step',
        'dirty-start-blocked',
        'invalid-start-name-blocked',
        'feature-release-hotfix-start',
        'start-source-by-type',
        'start-without-checkout',
        'start-with-checkout',
        'duplicate-start-blocked',
        'finish-release-targets-and-real-confirmation',
        'finish-selection-does-not-checkout',
      ],
    }
  } finally {
    await git.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}
