import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'

const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Real browser HTTP transport and Git. Every mutation stays inside a disposable repository.
export async function verifyStagingZones(
  page,
  { url = 'http://localhost:43187/', screenshotDirectory } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-staging-zones-'))
  const repo = path.join(root, 'dual-zone-project'),
    git = new GitService(),
    actions = []
  const record = (request) => {
    if (!request.url().endsWith('/__gitcode/rpc')) return
    const body = request.postDataJSON()
    if (body.method === 'action') actions.push(body.args[1])
  }
  page.on('request', record)
  const put = async (name, value) => {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true })
    await writeFile(path.join(repo, name), value)
  }
  const zone = (name) => page.locator(`[data-staging-zone="${name}"]`)
  const choose = (name, file) =>
    zone(name).getByRole('checkbox', {
      name: `${name === 'staged' ? '选择取消暂存' : '选择暂存'} ${file}`,
      exact: true,
    })
  const file = (name, file) => zone(name).locator(`[data-file-path="${file}"]`)
  const requestAction = async (click) => {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/__gitcode/rpc') &&
        response.request().postDataJSON()?.method === 'action',
    )
    await click()
    const payload = await (await response).json()
    assert.equal(payload.error, undefined, JSON.stringify(payload))
    return payload.result
  }
  const batch = (name, label) => zone(name).getByRole('button', { name: new RegExp(`^${label}`) })
  const diff = () => page.getByRole('region', { name: '文件差异', exact: true })
  const filter = () => page.getByRole('textbox', { name: '筛选工作区文件', exact: true })
  const refresh = async () => {
    await page.getByRole('button', { name: '刷新文件状态', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新文件状态', exact: true })).toBeEnabled()
  }
  const layout = async (name) => {
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await page.getByRole('radio', { name, exact: true }).check()
    await page.keyboard.press('Escape')
  }
  const dismissNotices = async () => {
    const close = page.locator('.toast').getByRole('button', { name: '关闭提示', exact: true })
    while (await close.count()) await close.first().click()
  }
  try {
    await mkdir(repo)
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Dual zone browser verification'],
      ['user.email', 'staging-ui@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.git/hooks'],
      ['core.autocrlf', 'false'],
    ])
      await git.git(repo, ['config', key, value])
    for (const name of ['A.txt', 'B.txt', 'C.txt', 'src/one.txt', 'src/two.txt'])
      await put(name, `base ${name}\n`)
    await git.git(repo, ['add', '--all'])
    await git.git(repo, ['commit', '-m', 'Dual zone base'])
    const base = await git.head(repo)
    await put('A.txt', 'A index version\n')
    await put('B.txt', 'B index version\n')
    await git.git(repo, ['add', '--', 'A.txt', 'B.txt'])
    await put('A.txt', 'A working version\n')
    for (const name of ['C.txt', 'src/one.txt', 'src/two.txt']) await put(name, `working ${name}\n`)

    await page.goto(url)
    await expect(page.locator('#operation-status')).toContainText('本机核心已连接')
    assert.equal(
      await page.evaluate(() => typeof window.gitk),
      'undefined',
      'Must use real HTTP core, not a preload mock',
    )
    await page.keyboard.press('Control+o')
    await page.getByLabel('仓库路径', { exact: true }).fill(repo)
    await page
      .getByRole('dialog', { name: '打开本地仓库', exact: true })
      .getByRole('button', { name: '打开仓库', exact: true })
      .click()
    await expect(page.locator('.status-path')).toHaveAttribute('title', repo)
    await expect(zone('unstaged')).toBeVisible()
    await expect(zone('staged')).toBeVisible()
    await expect(page.locator('.commit-button')).toContainText('提交全部已暂存（2）')

    // An MM path is two versions, with separate checkbox identity and previews.
    const initialIndex = await readFile(path.join(repo, '.git/index'))
    await choose('unstaged', 'A.txt').check()
    await expect(choose('staged', 'A.txt')).not.toBeChecked()
    await choose('staged', 'A.txt').check()
    await choose('unstaged', 'A.txt').uncheck()
    await expect(choose('staged', 'A.txt')).toBeChecked()
    await expect(zone('staged')).toContainText('勾选用于取消暂存')
    await file('unstaged', 'A.txt').click()
    await expect(diff()).toContainText('-A index version')
    await expect(diff()).toContainText('+A working version')
    await expect(diff().locator('.diff-kind')).toHaveText('工作区')
    await expect(diff().getByRole('group', { name: '差异内容来源' })).toHaveCount(0)
    await file('staged', 'A.txt').click()
    await expect(diff()).toContainText('-base A.txt')
    await expect(diff()).toContainText('+A index version')
    await expect(diff().locator('.diff-kind')).toHaveText('已暂存')
    await expect(diff()).not.toContainText('A working version')
    await page.keyboard.press('Escape')
    await choose('staged', 'A.txt').uncheck()
    assert.equal(actions.length, 0, 'Checkboxes and previews must not write Git')
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), initialIndex)

    // A directory is navigation only. Select-all includes folded matching descendants.
    await layout('目录视图')
    const directory = zone('unstaged').getByRole('button', { name: '展开或折叠 src', exact: true })
    await expect(directory).toBeVisible()
    await expect(directory.locator('..').getByRole('checkbox')).toHaveCount(0)
    await directory.click()
    await filter().fill('src/')
    await zone('unstaged').getByRole('checkbox', { name: /全选/ }).check()
    await expect(batch('unstaged', '暂存所选')).toContainText('2')
    await filter().fill('src/one')
    await expect(zone('unstaged')).toContainText(/含隐藏\s*1\s*项/)
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), initialIndex)
    const staged = await requestAction(() => batch('unstaged', '暂存所选').click())
    assert.equal(staged.outcome, 'succeeded', JSON.stringify(staged))
    await expect(batch('unstaged', '暂存所选')).toBeDisabled()
    await filter().fill('')
    await layout('列表视图')
    for (const name of ['src/one.txt', 'src/two.txt']) {
      await expect(choose('staged', name)).not.toBeChecked()
      assert.equal(await git.git(repo, ['show', `:${name}`]), `working ${name}\n`)
      await choose('staged', name).check()
    }

    // An unavailable index must not discard the failed batch selection.
    const lockedIndex = await readFile(path.join(repo, '.git/index'))
    await writeFile(path.join(repo, '.git/index.lock'), 'verification owns this lock\n')
    let failed
    try {
      failed = await requestAction(() => batch('staged', '取消暂存所选').click())
    } finally {
      await rm(path.join(repo, '.git/index.lock'), { force: true })
    }
    assert.equal(failed.outcome, 'failed', JSON.stringify(failed))
    for (const name of ['src/one.txt', 'src/two.txt'])
      await expect(choose('staged', name)).toBeChecked()
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), lockedIndex)
    const unstaged = await requestAction(() => batch('staged', '取消暂存所选').click())
    assert.equal(unstaged.outcome, 'succeeded', JSON.stringify(unstaged))
    for (const name of ['src/one.txt', 'src/two.txt']) {
      await expect(choose('unstaged', name)).not.toBeChecked()
      assert.equal(await readFile(path.join(repo, name), 'utf8'), `working ${name}\n`)
      assert.equal(await git.git(repo, ['show', `:${name}`]), `base ${name}\n`)
    }

    // Everyday one-file actions stay one click and keep keyboard focus in the source zone.
    await file('unstaged', 'C.txt').hover()
    const singleStage = await requestAction(() =>
      zone('unstaged').getByRole('button', { name: '暂存 C.txt', exact: true }).click(),
    )
    assert.equal(singleStage.outcome, 'succeeded', JSON.stringify(singleStage))
    await expect(choose('staged', 'C.txt')).not.toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('[data-staging-zone]')?.getAttribute('data-staging-zone'),
        ),
      )
      .toBe('unstaged')
    await file('staged', 'C.txt').hover()
    const singleUnstage = await requestAction(() =>
      zone('staged').getByRole('button', { name: '取消暂存 C.txt', exact: true }).click(),
    )
    assert.equal(singleUnstage.outcome, 'succeeded', JSON.stringify(singleUnstage))
    await expect(choose('unstaged', 'C.txt')).not.toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('[data-staging-zone]')?.getAttribute('data-staging-zone'),
        ),
      )
      .toBe('staged')
    assert.equal(await readFile(path.join(repo, 'C.txt'), 'utf8'), 'working C.txt\n')

    // Commit scope is the entire index, even when only A is checked for unstaging.
    await choose('staged', 'A.txt').check()
    await expect(choose('staged', 'B.txt')).not.toBeChecked()
    await expect(page.locator('.commit-button')).toContainText('提交全部已暂存（2）')
    await page
      .getByRole('textbox', { name: '提交说明', exact: true })
      .fill('Commit entire staged index')
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await dismissNotices()
      await page.screenshot({ path: path.join(screenshotDirectory, 'dual-zone-ready.png') })
    }
    const committed = await requestAction(() => page.locator('.commit-button').click())
    assert.equal(committed.outcome, 'succeeded', JSON.stringify(committed))
    await expect(page.locator('.commit-button')).toContainText('提交全部已暂存（0）')
    const paths = (await git.git(repo, ['diff', '--name-only', '-z', base, 'HEAD']))
      .split('\0')
      .filter(Boolean)
      .sort()
    assert.deepEqual(paths, ['A.txt', 'B.txt'])
    assert.equal(await git.git(repo, ['show', 'HEAD:A.txt']), 'A index version\n')
    assert.equal(await git.git(repo, ['show', 'HEAD:B.txt']), 'B index version\n')
    assert.equal(await readFile(path.join(repo, 'A.txt'), 'utf8'), 'A working version\n')
    for (const name of ['C.txt', 'src/one.txt', 'src/two.txt']) {
      assert.equal(await git.git(repo, ['show', `HEAD:${name}`]), `base ${name}\n`)
      assert.equal(await readFile(path.join(repo, name), 'utf8'), `working ${name}\n`)
    }
    await expect(choose('unstaged', 'A.txt')).not.toBeChecked()

    // A new HEAD invalidates old operation choices even when paths still exist.
    await choose('unstaged', 'C.txt').check()
    await git.git(repo, ['commit', '--allow-empty', '-m', 'External head change'])
    await refresh()
    await expect(choose('unstaged', 'C.txt')).not.toBeChecked()
    if (screenshotDirectory) {
      await dismissNotices()
      await page.screenshot({ path: path.join(screenshotDirectory, 'dual-zone-after-commit.png') })
    }
    return {
      transport: 'browser-http',
      realGit: true,
      temporaryRepositoryOnly: true,
      browsingAndCheckboxesDoNotWriteGit: true,
      partialPathChoicesIndependent: true,
      partialDiffsUseIndexWorkingAndHeadIndex: true,
      directoriesOnlyNavigate: true,
      selectAllIncludesFoldedMatchingFiles: true,
      hiddenSelectionExplicit: true,
      batchStageAndUnstagePreserveWorkingFiles: true,
      failedBatchRetainsSelectionAndIndex: true,
      singleFileActionsRetainSourceZoneFocus: true,
      commitIncludesAllIndexRegardlessOfCheckbox: paths,
      unrelatedWorkingChangesPreserved: true,
      changedHeadClearsSelection: true,
      gitActions: actions.length,
    }
  } finally {
    page.off('request', record)
    await page.goto('about:blank').catch(() => {})
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
