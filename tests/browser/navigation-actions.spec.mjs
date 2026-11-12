import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
async function fixture(page, mode, work) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-navigation-ui-')),
    repo = path.join(root, 'repo'),
    git = new GitService(),
    remote = path.join(root, 'remote.git')
  const write = (file, text) => writeFile(path.join(repo, file), text)
  const commit = async (message) => {
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', message])
    return git.head(repo)
  }
  try {
    await mkdir(repo)
    await git.git(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Navigation UI'],
      ['user.email', 'navigation-ui@test.local'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await write('base.txt', 'base\n')
    const base = await commit('base')
    await git.git(repo, ['switch', '-c', 'topic'])
    await write(mode === 'conflict' ? 'base.txt' : 'topic.txt', 'topic\n')
    const topic = await commit('topic')
    await git.git(repo, ['switch', 'main'])
    if (mode === 'conflict') {
      await write('base.txt', 'main\n')
      await commit('parallel main')
    }
    if (mode === 'remote') {
      await git.git(root, ['init', '--bare', remote])
      await git.git(repo, ['remote', 'add', 'origin', remote])
      await git.git(repo, ['push', 'origin', 'topic:topic'])
    }
    if (mode === 'working') {
      await write('draft.txt', 'local draft\n')
    }
    await page.goto('/')
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await dialog.getByLabel('仓库路径', { exact: true }).fill(repo)
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await page
      .getByRole('dialog', { name: '信任此仓库？', exact: true })
      .getByRole('button', { name: '信任并打开', exact: true })
      .click()
    await expect(dialog).not.toBeVisible()
    const menu = async (section = 'local', name = 'topic') => {
      await page
        .locator(`[data-sidebar-section="${section}"] [data-branch-name="${name}"] .branch-main`)
        .click({ button: 'right' })
      return page.getByRole('menu')
    }
    const action = async (click) => {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith('/__gitcode/rpc') && r.request().postDataJSON()?.method === 'action',
      )
      await click()
      const payload = await (await response).json()
      expect(payload.error).toBeUndefined()
      return payload.result
    }
    await work({ git, repo, remote, base, topic, menu, action, write, commit })
  } finally {
    await page.goto('about:blank')
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
test('navigation fast-forwards the current branch after confirmation and keeps source unchanged', async ({
  page,
}) =>
  fixture(page, 'ff', async ({ git, repo, topic, menu, action }) => {
    await (await menu()).getByRole('menuitem', { name: '快进 main 到 topic', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '快进当前分支', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: '快进当前分支', exact: true })).toBeEnabled()
    const result = await action(() =>
      dialog.getByRole('button', { name: '快进当前分支', exact: true }).click(),
    )
    expect(result.outcome).toBe('succeeded')
    await expect(dialog).not.toBeVisible()
    expect(await git.head(repo)).toBe(topic)
    expect(await git.currentBranch(repo)).toBe('main')
  }))
test('navigation merge conflicts enter the existing resolution dialog and abort safely', async ({
  page,
}) =>
  fixture(page, 'conflict', async ({ git, repo, menu, action }) => {
    const head = await git.head(repo)
    await (await menu()).getByRole('menuitem', { name: '合并 topic 到 main', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '合并分支', exact: true })
    await expect(dialog.getByRole('button', { name: '合并分支', exact: true })).toBeEnabled()
    const result = await action(() =>
      dialog.getByRole('button', { name: '合并分支', exact: true }).click(),
    )
    expect(result.outcome).toBe('partial')
    await expect(dialog).not.toBeVisible()
    const conflict = page.getByRole('region', { name: '解决冲突', exact: true })
    await expect(conflict).toBeVisible()
    expect(await git.head(repo)).toBe(head)
    await conflict.getByRole('button', { name: '中止合并', exact: true }).click()
    const aborted = await action(() =>
      conflict.getByRole('button', { name: '确认中止合并', exact: true }).click(),
    )
    expect(aborted.outcome).toBe('succeeded')
    await expect(conflict).not.toBeVisible()
    expect(await git.head(repo)).toBe(head)
    expect(await readFile(repo + '/base.txt', 'utf8')).toBe('main\n')
  }))
test('lightweight and annotated tag forms target the clicked branch and reject duplicate names', async ({
  page,
}) =>
  fixture(page, 'ff', async ({ git, repo, topic, menu, action }) => {
    for (const annotated of [false, true]) {
      const title = annotated ? '创建附注标签' : '创建标签',
        name = annotated ? 'v2' : 'v1'
      await (await menu()).getByRole('menuitem', { name: title, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await dialog.getByLabel('标签名称', { exact: true }).fill(name)
      if (annotated) await dialog.getByLabel('标签说明', { exact: true }).fill('Release notes')
      await expect(dialog.getByRole('button', { name: title, exact: true })).toBeEnabled()
      const result = await action(() =>
        dialog.getByRole('button', { name: title, exact: true }).click(),
      )
      expect(result.outcome).toBe('succeeded')
      await expect(dialog).not.toBeVisible()
      expect((await git.git(repo, ['rev-parse', `${name}^{commit}`])).trim()).toBe(topic)
    }
    await (await menu()).getByRole('menuitem', { name: '创建标签', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '创建标签', exact: true })
    await dialog.getByLabel('标签名称', { exact: true }).fill('v1')
    await expect(dialog.getByRole('button', { name: '创建标签', exact: true })).toBeEnabled()
    const duplicate = await action(() =>
      dialog.getByRole('button', { name: '创建标签', exact: true }).click(),
    )
    expect(duplicate.outcome).toBe('failed')
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '创建标签', exact: true })).toBeDisabled()
  }))
test('hide and Solo change graph history only, keep sidebar refs and can always show all', async ({
  page,
}) =>
  fixture(page, 'ff', async ({ git, repo, topic, base, menu }) => {
    let writes = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/__gitcode/rpc') && request.postDataJSON()?.method === 'action')
        writes++
    })
    await expect(page.locator(`[data-commit-hash="${topic}"]`)).toBeVisible()
    await (await menu()).getByRole('menuitemcheckbox', { name: '隐藏', exact: true }).click()
    await expect(page.locator(`[data-commit-hash="${topic}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-commit-hash="${base}"]`)).toBeVisible()
    await expect(
      page.locator('[data-sidebar-section="local"] [data-branch-name="topic"]'),
    ).toBeVisible()
    const popup = await menu()
    await expect(popup.getByRole('menuitemcheckbox', { name: '隐藏', exact: true })).toBeChecked()
    await popup.getByRole('menuitemcheckbox', { name: 'Solo', exact: true }).click()
    await expect(page.locator(`[data-commit-hash="${topic}"]`)).toBeVisible()
    await expect(page.locator('.ref-tag').filter({ hasText: 'main' })).toHaveCount(0)
    await (await menu()).getByRole('menuitem', { name: '显示全部引用', exact: true }).click()
    await expect(page.locator('.ref-tag').filter({ hasText: 'main' })).toBeVisible()
    expect(writes).toBe(0)
    expect(await git.head(repo)).toBe(base)
  }))
test('comparison shows full branch and working differences without Git writes', async ({ page }) =>
  fixture(page, 'working', async ({ git, repo, base, menu }) => {
    const index = await git.indexFingerprint(repo)
    await (await menu()).getByRole('menuitem', { name: '与当前分支比较', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '与当前分支比较', exact: true })
    await expect(dialog.getByRole('button', { name: /topic.txt/ })).toBeVisible()
    await dialog.getByRole('button', { name: /topic.txt/ }).click()
    await expect(dialog.getByLabel('比较差异', { exact: true })).toContainText('-topic')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await (await menu()).getByRole('menuitem', { name: '与工作区比较', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '与工作区比较', exact: true })
    await expect(dialog.getByRole('button', { name: /draft.txt/ })).toBeVisible()
    await dialog.getByRole('button', { name: /draft.txt/ }).click()
    await expect(dialog.getByLabel('比较差异', { exact: true })).toContainText('+local draft')
    expect(await git.head(repo)).toBe(base)
    expect(await git.indexFingerprint(repo)).toBe(index)
    expect(await readFile(repo + '/draft.txt', 'utf8')).toBe('local draft\n')
  }))
test('remote deletion checks server state, cancel preserves it and confirm removes only remote ref', async ({
  page,
}) =>
  fixture(page, 'remote', async ({ git, repo, remote, topic, menu, action }) => {
    const open = async () => {
      await (
        await menu('remote', 'origin/topic')
      )
        .getByRole('menuitem', { name: '删除 origin/topic', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: '删除远程分支', exact: true })
      await expect(
        dialog.getByRole('button', { name: '确认删除远程分支', exact: true }),
      ).toBeEnabled()
      return dialog
    }
    let dialog = await open()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect((await git.git(remote, ['rev-parse', 'refs/heads/topic'])).trim()).toBe(topic)
    dialog = await open()
    const result = await action(() =>
      dialog.getByRole('button', { name: '确认删除远程分支', exact: true }).click(),
    )
    expect(result.outcome).toBe('succeeded')
    await expect(dialog).not.toBeVisible()
    await expect(
      page.locator('[data-sidebar-section="remote"] [data-branch-name="origin/topic"]'),
    ).toHaveCount(0)
    expect((await git.git(repo, ['rev-parse', 'refs/heads/topic'])).trim()).toBe(topic)
  }))
