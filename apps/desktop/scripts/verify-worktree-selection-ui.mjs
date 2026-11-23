import { confirmFixtureTrust } from './confirm-fixture-trust.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'

const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Real UI and HTTP core; every Git mutation is confined to disposable fixtures.
export async function verifyWorktreeSelection(
  page,
  { url = 'http://localhost:43187/', screenshotDirectory } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-worktree-selection-'))
  const repo = path.join(root, 'repository-one'),
    second = path.join(root, 'repository-two')
  const git = new GitService(),
    actions = [],
    plans = []
  const record = (request) => {
    if (!request.url().endsWith('/__gitcode/rpc')) return
    const body = request.postDataJSON()
    if (body.method === 'action') actions.push(body.args[1])
    if (body.method === 'selected-commit-plan') plans.push(body.args[1])
  }
  page.on('request', record)
  const put = async (repo, name, value) => {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true })
    await writeFile(path.join(repo, name), value)
  }
  const init = async (target) => {
    await mkdir(target, { recursive: true })
    await git.git(target, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Worktree selection UI'],
      ['user.email', 'worktree-ui@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.git/hooks'],
      ['core.autocrlf', 'false'],
    ]) {
      await git.git(target, ['config', key, value])
    }
  }
  const open = async (target) => {
    await page.keyboard.press('Control+o')
    await page.getByLabel('仓库路径', { exact: true }).fill(target)
    await page
      .getByRole('dialog', { name: '打开本地仓库', exact: true })
      .getByRole('button', { name: '打开仓库', exact: true })
      .click()
    await confirmFixtureTrust(page)
    await expect(page.locator('.repo-selector')).toHaveAttribute('data-repository-path', target)
    await expect(page.locator('.worktree-changes')).toBeVisible()
  }
  const choose = (name) => page.getByRole('checkbox', { name: `选择提交 ${name}`, exact: true })
  const file = (name) =>
    page.locator(`.worktree-file-row[data-worktree-path="${name}"] .worktree-file-main`)
  const submit = () => page.locator('.commit-form').getByRole('button', { name: /提交所选到/ })
  const actionResponse = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/__gitcode/rpc') &&
        response.request().postDataJSON()?.method === 'action',
    )
  const commitSelection = async (partial) => {
    const action = actionResponse()
    await submit().click()
    if (partial) {
      const dialog = page.getByRole('dialog', { name: '复核提交所选文件', exact: true })
      await expect(dialog).toContainText('partial.txt')
      await dialog.getByRole('button', { name: '提交完整文件版本', exact: true }).click()
    }
    return (await (await action).json()).result
  }
  const show = (revision, name) => git.git(repo, ['show', `${revision}:${name}`])
  try {
    await init(repo)
    for (const name of [
      'src/selected.txt',
      'src/hidden.txt',
      'external.txt',
      'delete.txt',
      'old-name.txt',
      'partial.txt',
    ])
      await put(repo, name, `base ${name}\n`)
    await git.git(repo, ['add', '--all'])
    await git.git(repo, ['commit', '-m', 'Fixture base'])
    const base = await git.head(repo)
    await put(repo, 'src/selected.txt', 'selected current contents\n')
    await put(repo, 'src/hidden.txt', 'hidden by search; do not commit\n')
    await put(repo, 'external.txt', 'external staging must survive\n')
    await git.git(repo, ['add', '--', 'external.txt'])
    const externalBlob = (await git.git(repo, ['rev-parse', ':external.txt'])).trim()
    await put(repo, 'partial.txt', 'partial staged contents\n')
    await git.git(repo, ['add', '--', 'partial.txt'])
    const partialBlob = (await git.git(repo, ['rev-parse', ':partial.txt'])).trim()
    await put(repo, 'partial.txt', 'partial working contents\n')
    await rm(path.join(repo, 'delete.txt'))
    await git.git(repo, ['mv', '--', 'old-name.txt', 'renamed.txt'])
    await put(repo, 'new/new.txt', 'new selected file\n')
    await init(second)
    await put(second, 'other.txt', 'other repository\n')
    await git.git(second, ['add', '--all'])
    await git.git(second, ['commit', '-m', 'Other base'])
    await put(second, 'other.txt', 'other repository edit\n')

    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText(/(?:本机核心|Git 服务)已连接/)
    assert.equal(await page.evaluate(() => typeof window.gitk), 'undefined')
    await open(repo)
    const initialIndex = await readFile(path.join(repo, '.git/index'))
    await expect(choose('src/selected.txt')).not.toBeChecked()
    await file('src/selected.txt').click()
    await expect(page.getByRole('region', { name: '文件差异' })).toBeVisible()
    await expect(choose('src/selected.txt')).not.toBeChecked()
    await page.keyboard.press('Escape')
    await choose('src/hidden.txt').check()
    await page.getByRole('button', { name: '展开或折叠 src', exact: true }).click()
    const filter = page.getByRole('textbox', { name: '筛选工作区文件', exact: true })
    await filter.fill('src/selected')
    await page.getByRole('checkbox', { name: '选择当前显示的 变更 1 项', exact: true }).check()
    await expect(page.locator('.worktree-selection-summary')).toContainText('已选 2 个文件')
    await expect(page.locator('.worktree-selection-summary')).toContainText('1 个被筛选隐藏')
    await filter.fill('')
    await page.getByRole('button', { name: '展开或折叠 src', exact: true }).click()
    await expect(choose('src/hidden.txt')).toBeChecked()
    await expect(choose('src/selected.txt')).toBeChecked()
    await choose('src/hidden.txt').uncheck()
    assert.equal(actions.length, 0, 'Browsing, filtering and checkboxes must not mutate Git')
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), initialIndex)
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('Selected files only')

    const view = page.getByLabel('工作区视图选项', { exact: true })
    await file('src/selected.txt').click()
    await expect(page.getByRole('region', { name: '文件差异' })).toBeVisible()
    await view.click()
    await page.getByRole('radio', { name: '列表视图', exact: true }).check()
    await page.keyboard.press('Escape')
    await expect(page.locator('.worktree-view-menu')).not.toHaveAttribute('open', '')
    await expect(view).toBeFocused()
    await expect(page.getByRole('region', { name: '文件差异' })).toBeVisible()
    await page.keyboard.press('Escape')
    await view.click()
    await page.getByRole('button', { name: '使用暂存区模式', exact: true }).click()
    await expect(page.locator('.worktree-staging-mode')).toContainText('提交全部已暂存内容')
    await page.getByRole('button', { name: '使用勾选提交', exact: true }).click()
    await expect(choose('src/selected.txt')).toBeChecked()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Selected files only',
    )
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), initialIndex)
    await open(second)
    await expect(choose('other.txt')).not.toBeChecked()
    await page.locator(`.tab-select[title="${repo}"]`).click()
    await expect(choose('src/selected.txt')).toBeChecked()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Selected files only',
    )
    for (const name of ['new/new.txt', 'delete.txt', 'renamed.txt']) await choose(name).check()
    await expect(choose('external.txt')).not.toBeChecked()
    await expect(choose('partial.txt')).not.toBeChecked()
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDirectory, 'selected-tree.png') })
    }
    const result = await commitSelection(false)
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    const selectedHead = await git.head(repo)
    assert.notEqual(selectedHead, base)
    const changedPaths = (
      await git.git(repo, ['diff', '--no-renames', '--name-only', '-z', base, selectedHead])
    )
      .split('\0')
      .filter(Boolean)
      .sort()
    assert.deepEqual(
      changedPaths,
      ['delete.txt', 'new/new.txt', 'old-name.txt', 'renamed.txt', 'src/selected.txt'].sort(),
    )
    const committedPaths = (await git.git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']))
      .split('\0')
      .filter(Boolean)
    assert.equal(committedPaths.includes('old-name.txt'), false)
    assert.equal(committedPaths.includes('delete.txt'), false)
    assert.equal(committedPaths.includes('renamed.txt'), true)
    assert.equal(await show('HEAD', 'src/selected.txt'), 'selected current contents\n')
    assert.equal(await show('HEAD', 'external.txt'), 'base external.txt\n')
    assert.equal((await git.git(repo, ['rev-parse', ':external.txt'])).trim(), externalBlob)
    assert.equal((await git.git(repo, ['rev-parse', ':partial.txt'])).trim(), partialBlob)
    assert.equal(
      await readFile(path.join(repo, 'partial.txt'), 'utf8'),
      'partial working contents\n',
    )
    await expect(choose('partial.txt')).not.toBeChecked()
    await choose('partial.txt').check()
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Preserve draft after blocked hook')
    const partialIndex = await readFile(path.join(repo, '.git/index'))
    await submit().click()
    const review = page.getByRole('dialog', { name: '复核提交所选文件', exact: true })
    await expect(review).toContainText('partial.txt')
    await review.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await git.head(repo), selectedHead)
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), partialIndex)
    await expect(choose('partial.txt')).toBeChecked()
    const hook = path.join(repo, '.git/hooks/pre-commit')
    await writeFile(hook, '#!/bin/sh\nprintf "selection test hook blocked\\n" >&2\nexit 1\n')
    await chmod(hook, 0o755)
    const blocked = await commitSelection(true)
    assert.equal(blocked.outcome, 'failed', JSON.stringify(blocked))
    assert.equal(await git.head(repo), selectedHead)
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), partialIndex)
    await expect(choose('partial.txt')).toBeChecked()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Preserve draft after blocked hook',
    )
    await expect(page.locator('.toast.error').last()).toContainText('hook blocked')
    await rm(hook)
    // Reference hooks receive the transaction through stdin, not argv. A
    // wrapper that invokes `git hook run` without --to-stdin bypasses this rule.
    const referenceHook = path.join(repo, '.git/hooks/reference-transaction')
    await writeFile(
      referenceHook,
      '#!/bin/sh\nif [ "$1" = prepared ]; then\n  while read -r old new ref; do\n    if [ "$ref" = refs/heads/main ]; then\n      echo "reference hook blocked selected update" >&2\n      exit 1\n    fi\n  done\nfi\n',
    )
    await chmod(referenceHook, 0o755)
    const referenceBlocked = await commitSelection(true)
    assert.equal(referenceBlocked.outcome, 'failed', JSON.stringify(referenceBlocked))
    assert.equal(await git.head(repo), selectedHead)
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), partialIndex)
    await expect(choose('partial.txt')).toBeChecked()
    await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
      'Preserve draft after blocked hook',
    )
    await rm(referenceHook)
    const partialResult = await commitSelection(true)
    assert.equal(partialResult.outcome, 'succeeded', JSON.stringify(partialResult))
    assert.equal(await show('HEAD', 'partial.txt'), 'partial working contents\n')
    assert.equal((await git.git(repo, ['rev-parse', ':external.txt'])).trim(), externalBlob)
    assert.equal(await show('HEAD', 'external.txt'), 'base external.txt\n')
    assert.equal(
      await stat(path.join(repo, '.git/index.lock')).then(
        () => true,
        () => false,
      ),
      false,
    )
    if (screenshotDirectory)
      await page.screenshot({ path: path.join(screenshotDirectory, 'committed-selection.png') })
    // A selected path from an old process must not silently select a new change
    // with the same name after an external commit while GitCode is closed.
    await open(second)
    await choose('other.txt').check()
    await page.goto('about:blank')
    await git.git(second, ['add', '--', 'other.txt'])
    await git.git(second, ['commit', '-m', 'External completion while application is closed'])
    await put(second, 'other.txt', 'new task at the same path\n')
    await page.goto(url)
    await open(second)
    await expect(choose('other.txt')).not.toBeChecked()
    return {
      realGit: true,
      actions: actions.length,
      plans: plans.length,
      browseAndSelectWriteNothing: true,
      hiddenSelectionExplicit: true,
      repoScopedSelectionAndDraft: true,
      exactSelectedCommit: true,
      unselectedExternalIndexPreserved: true,
      partialReviewRequired: true,
      hookFailureKeepsIndexDraftAndSelection: true,
      referenceHookReceivesStdinAndCanReject: true,
      newChangeAtOldPathNotSelectedAfterRestart: true,
      temporaryRepositoriesOnly: true,
    }
  } finally {
    page.off('request', record)
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
