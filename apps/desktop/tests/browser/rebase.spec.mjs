import { confirmFixtureTrust } from '../../scripts/confirm-fixture-trust.mjs'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const { GitService } = createRequire(import.meta.url)('../../electron/git.cjs')
async function fixture(page, options, work) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-rebase-ui-')),
    git = new GitService()
  const cmd = (...args) => git.git(root, args),
    write = (file, text) => writeFile(path.join(root, file), text)
  const commit = async (message) => {
    await cmd('add', '.')
    await cmd('commit', '-m', message)
    return git.head(root)
  }
  try {
    await cmd('init', '-b', 'main')
    for (const [k, v] of Object.entries({
      'user.name': 'Rebase UI',
      'user.email': 'rebase-ui@test.invalid',
      'commit.gpgsign': 'false',
      'core.autocrlf': 'false',
      'core.hooksPath': '.no-hooks',
    }))
      await cmd('config', k, v)
    await write('shared.txt', 'base\n')
    await commit('initial')
    await write('base.txt', 'base\n')
    const base = await commit('common base')
    await cmd('switch', '-c', 'develop')
    await write('shared.txt', 'develop\n')
    const target = await commit('develop update')
    await cmd('switch', '-c', 'feature/test', base)
    await write(options.conflict ? 'shared.txt' : 'feature.txt', 'feature\n')
    const first = await commit('first feature')
    await write('second.txt', 'second\n')
    await commit('second feature')
    if (options.merge) {
      await cmd('switch', '-c', 'side', base)
      await write('side.txt', 'side')
      await commit('side')
      await cmd('switch', 'feature/test')
      await cmd('merge', '--no-ff', 'side', '-m', 'merge side')
    }
    const original = await git.head(root)
    if (options.dirty) await write('feature.txt', 'feature\nlocal draft\n')
    await page.goto('/')
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await dialog.getByLabel('仓库路径', { exact: true }).fill(root)
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await confirmFixtureTrust(page)
    await expect(dialog).not.toBeVisible()
    const menu = async () => {
      await page
        .locator('[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main')
        .click({ button: 'right' })
      await expect(page.getByRole('menu')).toBeVisible()
      return page.getByRole('menu')
    }
    const start = async () => {
      await (
        await menu()
      )
        .getByRole('menuitem', { name: '将 feature/test 变基到 develop', exact: true })
        .click()
    }
    const finished = async () => {
      await expect.poll(async () => !!(await git.merge.state(root))).toBe(false)
      await expect(
        page.getByRole('status').filter({ hasText: /正在变基|正在继续变基/ }),
      ).toHaveCount(0)
    }
    await work({ root, git, cmd, write, first, original, target, menu, start, finished })
  } finally {
    await page.goto('about:blank')
    await git.shutdown()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

test('ordinary rebase uses actual menu and preserves dirty tracked changes', async ({ page }) => {
  await fixture(page, { dirty: true }, async (f) => {
    await f.start()
    await expect.poll(() => f.cmd('rev-parse', 'HEAD~2').then((s) => s.trim())).toBe(f.target)
    await f.finished()
    expect(await readFile(path.join(f.root, 'feature.txt'), 'utf8')).toBe('feature\nlocal draft\n')
    expect((await f.cmd('stash', 'list')).trim()).toBe('')
    await expect(page.getByRole('dialog', { name: '解决冲突', exact: true })).not.toBeVisible()
  })
})

test('interactive rebase replaces navigation and graph, preserves details and executes reword / squash', async ({
  page,
}) => {
  await fixture(page, {}, async (f) => {
    // Simulate an older source commit falling outside the history snapshot's 250-row limit.
    await page.evaluate(async (sha) => {
      const { useRepositoryStore } = await import('/src/features/repository/stores/repository.ts')
      const repo = useRepositoryStore()
      // This fixture intentionally alters the loaded history. Pause external
      // observation so it cannot restore the omitted row during menu planning.
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      for (let i = 0; repo.externalRefreshing && i < 100; i++)
        await new Promise((resolve) => setTimeout(resolve, 50))
      repo.repo.commits = repo.repo.commits.filter((commit) => commit.hash !== sha)
    }, f.first)
    const eligibility = page.waitForResponse(
      (response) =>
        response.url().endsWith('/__gitcode/rpc') &&
        response.request().postDataJSON().method === 'rebase-menu-read',
    )
    await f.menu()
    await eligibility
    // Branch menus apply asynchronous eligibility on the next opening.
    await page.keyboard.press('Escape')
    await (
      await f.menu()
    )
      .getByRole('menuitem', { name: '交互式变基 feature/test 到 develop', exact: true })
      .click()
    const panel = page.getByRole('region', { name: '交互式变基', exact: true })
    await expect(panel).toBeVisible()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.history-panel')).toHaveCount(0)
    await expect(page.locator('.inspector')).toBeVisible()
    await expect(page.locator('.detail-full-hash')).toHaveText(f.first)
    await expect(page.locator('.detail-author')).toContainText('Rebase UI')
    await expect(panel.locator('.rebase-steps .rebase-step')).toHaveCount(2)
    await expect(panel.locator('select').last().locator('option[value="squash"]')).toHaveCount(0)
    await panel.locator('select').first().selectOption('drop')
    await panel.getByRole('button', { name: '重置编排', exact: true }).click()
    await expect(panel.locator('select').first()).toHaveValue('pick')
    await panel.locator('select').last().selectOption('reword')
    await panel.getByRole('textbox').fill('重新整理的功能提交')
    await panel.locator('select').first().selectOption('squash')
    await mkdir('.tmp/rebase-verification', { recursive: true })
    await page.screenshot({ path: '.tmp/rebase-verification/interactive.png' })
    await panel.getByRole('button', { name: '开始变基', exact: true }).click()
    await expect(panel).not.toBeVisible()
    await expect.poll(() => f.cmd('rev-parse', 'HEAD~1').then((s) => s.trim())).toBe(f.target)
    expect(await f.cmd('log', '-1', '--format=%B')).toContain('重新整理的功能提交')
    await f.finished()
  })
})

test('rebase conflicts use correct A/B labels, save marks resolved and Continue finishes', async ({
  page,
}) => {
  await fixture(page, { conflict: true }, async (f) => {
    await f.start()
    const inspector = page.getByRole('region', { name: '变基进行中', exact: true })
    await expect(inspector).toBeVisible()
    await expect(inspector.getByRole('button', { name: '跳过当前提交', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: '解决冲突', exact: true })).not.toBeVisible()
    await inspector.getByRole('button', { name: 'shared.txt', exact: true }).click()
    const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
    await expect(editor).toBeVisible()
    await expect(editor.getByRole('heading', { name: /A · 目标基线 develop/ })).toBeVisible()
    await expect(editor.getByRole('heading', { name: /B · 正在重放 feature\/test/ })).toBeVisible()
    await mkdir('.tmp/rebase-verification', { recursive: true })
    await page.screenshot({ path: '.tmp/rebase-verification/conflict.png' })
    await editor.getByRole('button', { name: '整文件采用重放提交', exact: true }).click()
    await expect(editor).not.toBeVisible()
    await expect(inspector.getByRole('button', { name: '继续变基', exact: true })).toBeEnabled()
    await inspector.getByRole('button', { name: '继续变基', exact: true }).click()
    await expect(inspector).not.toBeVisible()
    await f.finished()
    expect(await readFile(path.join(f.root, 'shared.txt'), 'utf8')).toBe('feature\n')
    expect((await f.cmd('rev-parse', 'HEAD~2')).trim()).toBe(f.target)
  })
})

for (const abort of [true, false])
  test(
    abort ? 'abort restores original HEAD' : 'skip drops conflict patch and keeps later commit',
    async ({ page }) => {
      await fixture(page, { conflict: true }, async (f) => {
        await f.start()
        const inspector = page.getByRole('region', { name: '变基进行中', exact: true })
        await expect(inspector).toBeVisible()
        await inspector
          .getByRole('button', { name: abort ? '中止变基' : '跳过当前提交', exact: true })
          .click()
        await expect(inspector).not.toBeVisible()
        await f.finished()
        if (abort) expect(await f.git.head(f.root)).toBe(f.original)
        else {
          expect((await f.cmd('rev-parse', 'HEAD~1')).trim()).toBe(f.target)
          expect(await readFile(path.join(f.root, 'shared.txt'), 'utf8')).toBe('develop\n')
        }
      })
    },
  )

test('merge-containing range hides interactive entry and cancelled plan leaves Git unchanged', async ({
  page,
}) => {
  await fixture(page, { merge: true }, async (f) => {
    const menu = await f.menu()
    await expect(
      menu.getByRole('menuitem', { name: '将 feature/test 变基到 develop', exact: true }),
    ).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /交互式变基/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(await f.git.head(f.root)).toBe(f.original)
  })
})

test('interactive drag and keyboard-friendly move controls reorder preview; cancel does not write Git', async ({
  page,
}) => {
  await fixture(page, {}, async (f) => {
    await (
      await f.menu()
    )
      .getByRole('menuitem', { name: '交互式变基 feature/test 到 develop', exact: true })
      .click()
    const panel = page.getByRole('region', { name: '交互式变基', exact: true }),
      rows = panel.locator('.rebase-step')
    await expect(rows.first()).toContainText('second feature')
    await rows
      .first()
      .getByRole('button', { name: /下移提交/ })
      .click()
    await expect(rows.first()).toContainText('first feature')
    await panel.getByRole('button', { name: '重置编排', exact: true }).click()
    await rows.first().dragTo(rows.last())
    await expect(rows.first()).toContainText('first feature')
    await panel.getByRole('button', { name: '取消变基', exact: true }).last().click()
    await expect(panel).not.toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
    expect(await f.git.head(f.root)).toBe(f.original)
    expect((await f.cmd('status', '--porcelain')).trim()).toBe('')
  })
})
