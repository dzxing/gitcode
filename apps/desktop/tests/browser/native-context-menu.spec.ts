import { expect, test, type Page } from '@playwright/test'
import type { NativeMenuItem } from '../../src/infrastructure/contextMenu'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

type NativeTestWindow = Window & {
  nativeRequests: { requestId: number; items: NativeMenuItem[] }[]
  nativeResolves: Record<number, (value: string | null) => void>
  nativeOpenedAt: number[]
  nativeClosed: number[]
  nativeTooltipTitles: string[][]
}
async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeRequests = []
    host.nativeResolves = {}
    host.nativeClosed = []
    host.nativeOpenedAt = []
    host.nativeTooltipTitles = []
    window.gitcodeContextMenu = {
      popup: (request) => {
        host.nativeTooltipTitles.push(
          [
            ...document.querySelectorAll(
              '.branch-row [title], .commit-row [title], .stash-row[title], .stash-sidebar-entry[title], .stash-graph-node title, .worktree-node-row [title], .section-head [title], .branch-dropdown [title]',
            ),
          ].map((element) => element.getAttribute('title') || element.textContent || ''),
        )
        host.nativeRequests.push(request)
        host.nativeOpenedAt.push(performance.now())
        return new Promise((resolve) => {
          host.nativeResolves[request.requestId] = resolve
        })
      },
      close: async (id) => {
        host.nativeClosed.push(id)
      },
    }
  })
}
const develop = (page: Page) =>
  page.locator('[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main')

test('branches avoid redundant hover hints and native menus suppress remaining icon tips', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  const row = page.locator('[data-sidebar-section="local"] [data-branch-name="main"]')
  const button = row.locator('.branch-main')
  await expect(button).not.toHaveAttribute('title')
  await button.hover()
  await expect(page.locator('.branch-name-tooltip')).toHaveCount(0)
  await expect(page.locator('.section-toggle[title], .section-count[title]')).toHaveCount(0)
  await button.click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  expect(
    await page.evaluate(() => (window as unknown as NativeTestWindow).nativeTooltipTitles[0]),
  ).toEqual([])
  await expect(row.locator('[title]')).toHaveCount(0)
  await expect(button).toHaveAccessibleName(/单击筛选.*当前分支/)
  // A native popup can keep the pointer captured without delivering mouseleave.
  await button.dispatchEvent('mouseenter')
  await expect(page.locator('.branch-name-tooltip')).toHaveCount(0)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await expect(button).not.toHaveAttribute('title')
  await expect(row.locator('.branch-meta')).not.toHaveAttribute('title')
  await expect(row.locator('.branch-favorite')).toHaveAttribute('title', /收藏/)
})

test('desktop uses one native menu with ordered groups and dispatches the chosen object', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await expect(page.getByRole('menu')).toHaveCount(0)
  const items = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[0]!.items,
  )
  const ids = items.flatMap((item) => ('id' in item ? [item.id] : []))
  expect(ids.slice(0, 3)).toEqual(['branch-pull', 'branch-push', 'set-upstream'])
  expect(ids).not.toContain('locate')
  expect(ids).not.toContain('history')
  expect(ids.indexOf('delete-branch')).toBeLessThan(ids.indexOf('copy-name'))
  expect(items[0]).not.toHaveProperty('type', 'separator')
  await expect(page.locator('.wip-row')).toHaveClass(/selected/)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('rename-branch')
  })
  const dialog = page.getByRole('dialog', { name: '重命名分支', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('新分支名称', { exact: true })).toHaveValue('develop')
})

test('dismissing native menus restores focus without creating a web menu', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await expect(develop(page)).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a stale native selection cannot execute after opening another menu', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page
    .locator('[data-sidebar-section="local"] [data-branch-name="main"] .branch-main')
    .click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(2)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('delete-branch')
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const closed = await page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed)
  expect(closed).toContain(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[1]!.requestId]!(null)
  })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('unavailable native menus fall back to the browser menu', async ({ page }) => {
  await page.addInitScript(() => {
    window.gitcodeContextMenu = {
      popup: async () => {
        throw new Error('unavailable')
      },
      close: async () => {},
    }
  })
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '切换到 develop', exact: true })).toBeEnabled()
})

test('a native selection cannot execute after leaving its repository tab', async ({ page }) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed.length))
    .toBe(1)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('delete-branch')
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('native checkout directly attempts the named branch with frozen reference guards', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.action = async (_repo, request) => {
      document.documentElement.dataset.nativeCheckout = JSON.stringify(request)
      throw new Error('Read-only fixture rejects the attempt')
    }
  })
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  const labels = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[0]!.items.flatMap((item) =>
      'label' in item ? [item.label] : [],
    ),
  )
  expect(labels).toContain('切换到 develop')
  expect(labels).toContain('重命名 develop')
  expect(labels).toContain('删除 develop')
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('checkout')
  })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.nativeCheckout))
    .toBeTruthy()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.nativeCheckout!),
  )
  expect(request.action).toBe('checkout')
  expect(request.name).toBe('develop')
  expect(request.expectedBranch).toBe('main')
  expect(request.expectedOid).toMatch(/^[a-f0-9]{40}$/)
  await expect(page.getByRole('dialog', { name: '切换分支', exact: true })).toHaveCount(0)
  await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
})

test('remote-only branch menu does not wait for Git rebase planning', async ({ page }) => {
  await installBridge(page)
  const snapshot = structuredClone(repositoryFixture)
  snapshot.branches = snapshot.branches.filter((b) => b.kind !== 'local' || b.name !== 'develop')
  snapshot.commits.pop()
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    document.documentElement.dataset.rebaseReads = '0'
    window.gitcode!.rebaseMenuRead = async () => {
      document.documentElement.dataset.rebaseReads = String(
        Number(document.documentElement.dataset.rebaseReads) + 1,
      )
      return new Promise(() => {})
    }
  })
  await page.locator('[data-branch-name="origin/develop"] .branch-main').click({ button: 'right' })
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length),
      { timeout: 1500 },
    )
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.rebaseReads))
    .toBe('1')
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('track-branch')
  })
  await expect(page.getByRole('dialog', { name: '创建本地跟踪分支', exact: true })).toBeVisible()
})

test('unchanged background snapshots keep the native branch menu; moved refs cancel stale choices', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await page.locator('[data-branch-name="origin/develop"] .branch-main').click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await page.evaluate(async () => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    const repo = useRepositoryStore()
    repo.repo = JSON.parse(JSON.stringify(repo.repo))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  expect(await page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed)).toEqual(
    [],
  )
  await page.evaluate(async () => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    const repo = useRepositoryStore()
    const snapshot = JSON.parse(JSON.stringify(repo.repo))
    snapshot.branches.find((b: { name: string }) => b.name === 'origin/develop').hash = 'f'.repeat(
      40,
    )
    repo.repo = snapshot
  })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed))
    .toEqual([1])
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!('track-branch')
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('interactive rebase menu uses history eligibility; full preflight stays on invocation', async ({
  page,
}) => {
  await installBridge(page)
  const snapshot = structuredClone(repositoryFixture)
  snapshot.commits.pop()
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    document.documentElement.dataset.rebaseReads = ''
    window.gitcode!.rebaseMenuRead = async () => {
      document.documentElement.dataset.rebaseReads += 'rebase-menu,'
      return { canInteractive: true }
    }
    window.gitcode!.navigationRead = async (_repo, request) => {
      document.documentElement.dataset.rebaseReads += request.kind + ','
      throw new Error('测试：工作区已变化，完整预检阻止变基')
    }
  })
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.rebaseReads))
    .toBe('rebase-menu,')
  // The unknown first menu is not held open waiting for eligibility.
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await expect(develop(page)).toBeFocused()
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(2)
  const ids = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[1]!.items.flatMap((item) =>
      'id' in item ? [item.id] : [],
    ),
  )
  expect(ids).toContain('rebase-interactive')
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[1]!.requestId]!('rebase-interactive')
  })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.rebaseReads))
    .toBe('rebase-menu,rebase,')
  await expect(
    page.getByText('测试：工作区已变化，完整预检阻止变基', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: '交互式变基', exact: true })).toHaveCount(0)
})

test('ineligible history hides interactive rebase without removing ordinary rebase and checkout', async ({
  page,
}) => {
  await installBridge(page)
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.rebaseMenuRead = async () => ({ canInteractive: false })
  })
  await develop(page).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  const ids = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[0]!.items.flatMap((item) =>
      'id' in item ? [item.id] : [],
    ),
  )
  expect(ids).not.toContain('rebase-interactive')
  expect(ids).toContain('rebase')
  expect(ids).toContain('checkout')
})

test('slow history read cannot block remote tracking menus or mutate an already open native menu', async ({
  page,
}) => {
  await installBridge(page)
  const snapshot = structuredClone(repositoryFixture)
  snapshot.branches = snapshot.branches.filter((b) => b.kind !== 'local' || b.name !== 'develop')
  snapshot.commits.pop()
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    document.documentElement.dataset.historyStarted = 'false'
    window.gitcode!.rebaseMenuRead = () =>
      new Promise((resolve) => {
        document.documentElement.dataset.historyStarted = 'true'
        document.addEventListener('resolve-menu-history', () => resolve({ canInteractive: true }), {
          once: true,
        })
      })
  })
  const row = page.locator('[data-branch-name="origin/develop"] .branch-main')
  const elapsed = await page.evaluate(async () => {
    const row = document.querySelector('[data-branch-name="origin/develop"] .branch-main')!
    const start = performance.now()
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200,
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    return (window as unknown as NativeTestWindow).nativeOpenedAt[0]! - start
  })
  expect(elapsed).toBeLessThan(100)
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length),
      { timeout: 1500 },
    )
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.historyStarted))
    .toBe('true')
  await page.evaluate(() => document.dispatchEvent(new Event('resolve-menu-history')))
  const ids = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[0]!.items.flatMap((item) =>
      'id' in item ? [item.id] : [],
    ),
  )
  expect(ids).not.toContain('rebase-interactive')
  expect(ids).toContain('track-branch')
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await expect(row).toBeFocused()
  await row.click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(2)
  const nextIds = await page.evaluate(() =>
    (window as unknown as NativeTestWindow).nativeRequests[1]!.items.flatMap((item) =>
      'id' in item ? [item.id] : [],
    ),
  )
  expect(nextIds).toContain('rebase-interactive')
})

test('native commit menu opens before optional slow Git eligibility reads and keeps fixed disabled entries', async ({
  page,
}) => {
  await installBridge(page)
  const snapshot = structuredClone(repositoryFixture)
  snapshot.commits.pop()
  await openFixtureRepository(page, false, snapshot)
  await page.evaluate(() => {
    window.gitcode!.rebaseMenuRead = async () => {
      document.documentElement.dataset.commitMenuOpenedFirst = String(
        (window as unknown as NativeTestWindow).nativeRequests.length > 0,
      )
      return new Promise(() => {})
    }
  })
  const commit = snapshot.commits[2]!
  await page.locator(`[data-commit-hash="${commit.hash}"]`).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(1)
  const items = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[0]!.items,
  )
  const commands = items.flatMap((item) => ('id' in item ? [item] : []))
  expect(commands).toHaveLength(21)
  expect(commands.find((i) => i.id === 'commit-undo')!.enabled).toBe(false)
  expect(commands.find((i) => i.id === 'commit-interactive')!.enabled).toBe(true)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.commitMenuOpenedFirst))
    .toBe(undefined)
  await page.evaluate(() => {
    const host = window as unknown as NativeTestWindow
    host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
  })
  await page.locator(`[data-commit-hash="${snapshot.head}"]`).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(2)
  const headItems = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[1]!.items,
  )
  expect(headItems.flatMap((i) => ('id' in i ? [i.id] : []))).toEqual(commands.map((i) => i.id))
  expect(headItems.find((i) => 'id' in i && i.id === 'commit-squash')).toHaveProperty(
    'enabled',
    false,
  )
  const activeId = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[1]!.requestId,
  )
  await page.evaluate(async () => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    const repo = useRepositoryStore()
    repo.repo = JSON.parse(JSON.stringify(repo.repo))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  expect(
    await page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed),
  ).not.toContain(activeId)
  await page.evaluate(async () => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    useRepositoryStore().repo.head = 'f'.repeat(40)
  })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed))
    .toContain(activeId)
  await page.evaluate(async (head) => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    useRepositoryStore().repo.head = head
  }, snapshot.head)
  await page.locator(`[data-commit-hash="${snapshot.head}"]`).click({ button: 'right' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length))
    .toBe(3)
  const remoteSensitiveId = await page.evaluate(
    () => (window as unknown as NativeTestWindow).nativeRequests[2]!.requestId,
  )
  await page.evaluate(async () => {
    const modulePath = '/src/features/repository/stores/repository.ts'
    const { useRepositoryStore } = await import(modulePath)
    const store = useRepositoryStore()
    const next = JSON.parse(JSON.stringify(store.repo))
    next.branches.find((branch: { kind: string }) => branch.kind === 'remote').hash = 'e'.repeat(40)
    store.repo = next
  })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NativeTestWindow).nativeClosed))
    .toContain(remoteSensitiveId)
})

for (const entry of [
  { name: 'commit messages', source: '.commit-row', target: '.commit-select' },
  { name: 'reference badges', source: '.ref-tag', target: '.ref-primary' },
  { name: 'changed files', source: '.worktree-file-row', target: '.worktree-row-main' },
  {
    name: 'navigation groups',
    source: '[data-sidebar-section="local"] .section-head',
    target: '.section-toggle',
  },
  { name: 'sidebar stashes', source: '.stash-sidebar-entry', target: '' },
  { name: 'graph stashes', source: '.stash-graph-node', target: '' },
]) {
  test(`${entry.name} stop hover titles before native menus capture the pointer`, async ({
    page,
  }) => {
    await installBridge(page)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.stashes = [
      {
        ref: 'stash@{0}',
        oid: 'e'.repeat(40),
        message: 'WIP on main: tooltip check',
        date: new Date().toISOString(),
        branch: 'main',
        base: snapshot.head,
      },
    ]
    await openFixtureRepository(page, false, snapshot)
    const source = page.locator(entry.source).first()
    const titles = () =>
      source.evaluate((element) => [
        ...(element.hasAttribute('title') ? [element.getAttribute('title')] : []),
        ...[...element.querySelectorAll('[title], title')].map(
          (node) => node.getAttribute('title') || node.textContent,
        ),
      ])
    const target = entry.target ? source.locator(entry.target).first() : source
    await target.hover({ force: entry.name === 'graph stashes' })
    const before = await titles()
    await target.click({ button: 'right', force: entry.name === 'graph stashes' })
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as NativeTestWindow).nativeRequests.length),
      )
      .toBe(1)
    expect(
      await page.evaluate(() => (window as unknown as NativeTestWindow).nativeTooltipTitles[0]),
    ).toEqual([])
    expect(await titles()).toEqual([])
    await expect(page.locator('.ref-labels.is-expanded, .graph-arrow-tooltip')).toHaveCount(0)
    await page.evaluate(() => {
      const host = window as unknown as NativeTestWindow
      host.nativeResolves[host.nativeRequests[0]!.requestId]!(null)
    })
    await expect.poll(titles).toEqual(before)
  })
}
