import { test, expect } from '@playwright/test'

const local = `feature/${'long-branch-name-'.repeat(10)}task`
const remote = `origin/${local}`
const tag = `release-${'long-version-'.repeat(12)}v1`
const hash = 'a'.repeat(40)
const state = {
  path: '/sidebar-name-check',
  name: 'Sidebar name check',
  branch: 'main',
  head: hash,
  total: 1,
  staged: [],
  unstaged: [],
  commits: [
    {
      hash,
      parents: [],
      subject: 'Read-only fixture',
      author: 'Test',
      email: 'test@example.com',
      date: '2026-10-29T00:00:00Z',
      refs: ['HEAD -> main'],
    },
  ],
  branches: [
    ['local', 'main'],
    ['local', local],
    ['remote', remote],
    ['tag', tag],
  ].map(([kind, name]) => ({
    kind,
    name,
    fullRef: `refs/${kind === 'local' ? 'heads' : kind === 'remote' ? 'remotes' : 'tags'}/${name}`,
    hash,
    commitHash: hash,
    current: name === 'main',
    upstream: '',
    track: '',
  })),
  gitflow: {
    config: {
      production: 'main',
      develop: 'main',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    },
    ready: true,
    configured: true,
    missing: [],
    error: '',
    writeError: '',
    signature: 'name-check',
  },
}

test('sidebar full names escape clipping without moving rows or adding checkout buttons', async ({
  page,
}) => {
  await page.addInitScript((state) => {
    const blocked = async () => {
      throw new Error('No Git writes in sidebar name check')
    }
    window.gitcode = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      repositoryTrust: async (path) => ({ path, gitDir: path + '/.git', trusted: true, token: '' }),
      snapshot: async () => structuredClone(state),
      commit: async () => ({ body: 'read-only', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      action: async () => {
        document.documentElement.dataset.checkoutAttempts = '1'
        return blocked()
      },
      create: blocked,
      chooseDirectory: async () => state.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: blocked,
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, state)
  await page.goto('/')
  await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  await page.keyboard.press('Control+o')
  const row = (section, name) =>
    page.locator(`[data-sidebar-section="${section}"] [data-branch-name="${name}"]`)
  const localRow = row('local', local),
    main = localRow.locator('.branch-main')
  const tip = page.getByRole('tooltip')
  await expect(main).toBeVisible()
  await expect(page.locator('.branch-switch, .branch-row-action-space')).toHaveCount(0)
  await expect(localRow.locator('.branch-row-action')).toHaveCount(0)
  await expect(row('gitflow', local).locator('.branch-row-action')).toHaveCount(0)
  for (const width of [190, 330]) {
    await page
      .locator('.app-shell')
      .evaluate((el, width) => el.style.setProperty('--sidebar-width', `${width}px`), width)
    for (const [section, name] of [
      ['local', local],
      ['gitflow', local],
      ['remote', remote],
      ['tag', tag],
    ]) {
      const target = row(section, name),
        label = target.locator('.branch-main > span')
      await target.scrollIntoViewIfNeeded()
      const before = await label.boundingBox(),
        starBefore = await target.locator('.branch-favorite').boundingBox()
      await target.locator('.branch-main').hover()
      await expect(tip).toHaveText(name)
      await expect(tip).toHaveCSS('pointer-events', 'none')
      expect(await label.boundingBox()).toEqual(before)
      expect(await target.locator('.branch-favorite').boundingBox()).toEqual(starBefore)
      const box = await tip.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(8)
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width - 8)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height)
      await target.locator('.branch-favorite').hover()
      await expect(tip).toHaveCount(0)
    }
  }
  await main.hover()
  await expect(tip).toHaveText(local)
  await main.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(tip).toHaveCount(0)
  await main.dispatchEvent('mouseenter')
  await expect(tip).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.move(1000, 100)
  await main.scrollIntoViewIfNeeded()
  await page.keyboard.press('Tab')
  await main.focus()
  await expect(tip).toHaveText(local)
  await expect(main).toHaveAttribute('aria-describedby', await tip.getAttribute('id'))
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  await page.getByRole('textbox', { name: '筛选分支', exact: true }).focus()
  await main.hover()
  await expect(tip).toHaveText(local)
  await page.locator('.branch-sections').dispatchEvent('scroll')
  await expect(tip).toHaveCount(0)
  await page.mouse.move(1000, 100)
  await main.dblclick()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.checkoutAttempts))
    .toBe('1')
  await expect(page.getByRole('dialog', { name: '切换分支', exact: true })).toHaveCount(0)
  await expect(tip).toHaveCount(0)
  await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
  await page.mouse.move(1000, 100)
  await main.hover()
  await expect(tip).toHaveText(local)
  await page.getByRole('textbox', { name: '筛选分支', exact: true }).fill('main')
  await expect(tip).toHaveCount(0)
  await row('local', 'main').locator('.branch-main').hover()
  await expect(tip).toHaveCount(0)
})
