import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import type { Snapshot } from '../../src/shared/contracts'

const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20)
const merge = sha(1),
  base = sha(63)
function fixture(incomplete = false): Snapshot {
  const commits = [
    { hash: merge, parents: [base, sha(2)], subject: 'Merge feature into main' },
    ...Array.from({ length: 61 }, (_, i) => ({
      hash: sha(i + 2),
      parents: [i < 60 ? sha(i + 3) : base],
      subject: `Feature work ${i + 1}`,
    })),
    { hash: base, parents: [], subject: 'Common base' },
  ].map((c) => ({
    ...c,
    author: 'Graph review',
    email: 'graph@example.invalid',
    date: '2026-11-09T00:00:00Z',
    refs: [],
  }))
  return {
    ...structuredClone(repositoryFixture),
    name: 'Merge navigation',
    branch: 'main',
    head: merge,
    total: commits.length,
    staged: [],
    unstaged: [],
    stashes: [],
    commits: incomplete ? commits.slice(0, 40) : commits,
    history: incomplete
      ? {
          token: 'partial-graph',
          signature: 'partial-graph',
          basis: '',
          focus: null,
          nextOffset: 40,
          total: commits.length,
        }
      : undefined,
    branches: [
      { name: 'main', hash: merge, kind: 'local', current: true },
      { name: 'origin/main', hash: merge, kind: 'remote', current: false },
      { name: 'feature/topic', hash: sha(2), kind: 'local', current: false },
    ].map((b) => ({ ...b, upstream: '', track: '' })) as Snapshot['branches'],
  }
}

for (const ratio of [1, 1.25, 1.5, 2]) {
  test.describe(`graph paint at ${ratio * 100}% device scale`, () => {
    test.use({ deviceScaleFactor: ratio })
    test('merge arrow navigates down to the actual parent and back without Git writes', async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await openFixtureRepository(page, false, fixture())
      const down = page.locator(`[data-graph-arrow="down"][data-arrow-target="${base}"]`)
      const up = page.locator(`[data-graph-arrow="up"][data-arrow-target="${merge}"]`)
      await expect(down).toHaveCount(1)
      await expect(up).toHaveCount(1)
      const aligned = () =>
        page.evaluate(() => {
          const stroke = document.querySelector('.commit-graph > path[data-child-hash]')!
          const parity =
            (Math.round(Number(stroke.getAttribute('stroke-width')) * devicePixelRatio) % 2) / 2
          return [
            ...document.querySelectorAll<SVGCircleElement>('[data-node-hash] > circle:first-child'),
          ].every((node) => {
            const point = new DOMPoint(
              Number(node.getAttribute('cx')),
              Number(node.getAttribute('cy')),
            ).matrixTransform(node.getScreenCTM()!)
            return [point.x, point.y].every(
              (v) =>
                Math.abs(
                  v * devicePixelRatio - parity - Math.round(v * devicePixelRatio - parity),
                ) < 0.001,
            )
          })
        })
      await expect.poll(aligned).toBe(true)
      const radius = await page
        .locator(`[data-node-hash="${base}"] > circle:first-child`)
        .getAttribute('r')
      await down.hover()
      await expect(page.getByRole('tooltip')).toContainText('Common base')
      await expect(page.getByRole('tooltip')).toContainText('Graph review')
      // Click near the beginning of the arrow-bearing line, outside the glyph.
      const hit = await down.evaluate((node) => {
        const path = node
          .closest('.graph-jump-arrow')!
          .querySelector<SVGPathElement>('.graph-arrow-segment')!
        const point = path
          .getPointAtLength(path.getTotalLength() * 0.05)
          .matrixTransform(path.getScreenCTM()!)
        return { x: point.x, y: point.y }
      })
      await page.mouse.click(hit.x, hit.y)
      await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', base)
      expect(await page.locator('.history-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(
        500,
      )
      await expect(page.locator(`[data-node-hash="${base}"] > circle:first-child`)).toHaveAttribute(
        'r',
        radius!,
      )
      await expect(page.locator('.node-selection-ring')).toHaveCount(1)
      await up.focus()
      await up.press('Enter')
      await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', merge)
      expect(await page.locator('.history-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(100)
      const visibleTop = await page
        .locator('.table-head')
        .evaluate((el) => el.getBoundingClientRect().bottom)
      expect(
        (await page.locator(`[data-commit-hash="${merge}"]`).boundingBox())!.y,
      ).toBeGreaterThanOrEqual(visibleTop - 0.5)
      await expect.poll(aligned).toBe(true)
      await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
      expect(errors).toEqual([])
      await page.screenshot({ path: `design/idea-graph-polish/scale-${ratio * 100}.png` })
    })
  })
}

test('unloaded arrow destination explains the limit without loading history or changing selection', async ({
  page,
}) => {
  await openFixtureRepository(page, false, fixture(true))
  await page.evaluate(() => {
    ;(window as unknown as { metadataReads: number }).metadataReads = 0
    window.gitcode!.historyMetadata = async (_repo, hash) => {
      ;(window as unknown as { metadataReads: number }).metadataReads++
      return {
        hash,
        subject: 'Unloaded common base',
        author: 'Metadata Reader',
        date: '2026-11-09T00:00:00Z',
      }
    }
    window.gitcode!.historyRead = async () => {
      throw new Error('Arrow must not implicitly change loaded history')
    }
  })
  const selected = page.locator('.commit-row.selected')
  const original = (await selected.count()) ? await selected.getAttribute('data-commit-hash') : null
  const down = page.locator(`[data-graph-arrow="down"][data-arrow-target="${base}"]`)
  await down.hover()
  await expect(page.getByRole('tooltip')).toContainText('Unloaded common base')
  await expect(page.getByRole('tooltip')).toContainText('Metadata Reader')
  await down.click()
  await expect(
    page.getByText('目标提交尚未加载或被筛选隐藏；请加载更早的提交或调整筛选。', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.commit-row')).toHaveCount(40)
  await expect(page.locator('.notice').filter({ hasText: '目标提交尚未加载' })).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as { metadataReads: number }).metadataReads),
  ).toBe(1)
  expect((await selected.count()) ? await selected.getAttribute('data-commit-hash') : null).toBe(
    original,
  )
})

test('device-scale changes repaint on resize and keep the selected commit', async ({ page }) => {
  await openFixtureRepository(page, false, fixture())
  const target = sha(2)
  await page.locator(`[data-commit-hash="${target}"] .commit-select`).click()
  const order = await page
    .locator('.commit-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-commit-hash')))
  const session = await page.context().newCDPSession(page)
  try {
    for (const [ratio, expected] of [
      [1.25, '1.6'],
      [1.5, '2'],
      [2, '2'],
    ]) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: ratio as number,
        mobile: false,
      })
      // CDP changes devicePixelRatio without firing resolution/resize events.
      // Supply the resize notification emitted by a real window scale change.
      await page.evaluate(() => window.dispatchEvent(new Event('resize')))
      await expect(page.locator('.commit-graph > path[data-child-hash]').first()).toHaveAttribute(
        'stroke-width',
        expected as string,
      )
      await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-commit-hash', target)
      expect(
        await page
          .locator('.commit-row')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-commit-hash'))),
      ).toEqual(order)
    }
  } finally {
    await session.send('Emulation.clearDeviceMetricsOverride')
    await session.detach()
  }
})

test('long-edge setting keeps arrows, persists, and is shared by View and graph context menus', async ({
  page,
}) => {
  await openFixtureRepository(page, false, fixture())
  const edge = page.locator(
    `.commit-graph > path[data-child-hash="${merge}"][data-parent-hash="${base}"]`,
  )
  expect((await edge.getAttribute('d'))!.match(/M/g)).toHaveLength(2)
  await page.keyboard.press('Alt+v')
  const toggle = page.getByRole('menuitemcheckbox', { name: '展开长连线', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect.poll(async () => (await edge.getAttribute('d'))!.match(/M/g)!.length).toBe(1)
  await expect(page.locator('[data-graph-arrow]')).toHaveCount(2)
  expect(await page.evaluate(() => localStorage.getItem('gitcode.graph-long-edges'))).toBe('true')
  await page.getByLabel('历史列表显示列', { exact: true }).click({ button: 'right' })
  const contextToggle = page.getByRole('menuitemcheckbox', { name: '展开长连线', exact: true })
  await expect(contextToggle).toHaveAttribute('aria-checked', 'true')
  await contextToggle.click()
  await expect.poll(async () => (await edge.getAttribute('d'))!.match(/M/g)!.length).toBe(2)
  expect(await page.evaluate(() => localStorage.getItem('gitcode.graph-long-edges'))).toBe('false')
})

test('shown long edges draw diagonal arrows within the edge row, matching the source geometry', async ({
  page,
}) => {
  const state = fixture()
  // A completed independent main root makes the adjacent edge column move.
  state.commits[1] = { ...state.commits[1]!, parents: [], subject: 'Independent main root' }
  state.branches = state.branches.map((branch) => ({
    ...branch,
    hash: branch.name === 'main' || branch.name === 'origin/main' ? sha(2) : merge,
  }))
  state.head = sha(2)
  state.commits[0] = { ...state.commits[0]!, parents: [base], subject: 'Long topic ancestry' }
  await openFixtureRepository(page, false, state)
  await page.keyboard.press('Alt+v')
  await page.getByRole('menuitemcheckbox', { name: '展开长连线', exact: true }).click()
  const down = page.locator(`[data-graph-arrow="down"][data-arrow-target="${base}"]`)
  const geometry = await down.evaluate((node) => {
    const group = node.closest('.graph-jump-arrow')!
    const path = group.querySelector<SVGPathElement>('.graph-arrow-segment')!
    const a = path.getPointAtLength(0),
      b = path.getPointAtLength(path.getTotalLength())
    return { dx: b.x - a.x, dy: b.y - a.y }
  })
  expect(geometry.dx).not.toBe(0)
  expect(geometry.dy).toBe(15)
  await down.hover()
  await expect(page.getByRole('tooltip')).toContainText('Common base')
  await page.screenshot({ path: 'design/idea-graph-polish/diagonal-arrow-parity.png' })
})

test('graph arrow hover information closes when a context menu opens and resumes after dismissal', async ({
  page,
}) => {
  await openFixtureRepository(page, false, fixture())
  const arrow = page.locator(`[data-graph-arrow="down"][data-arrow-target="${base}"]`)
  await arrow.hover()
  await expect(page.getByRole('tooltip')).toContainText('Common base')
  await arrow.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.locator('.graph-arrow-tooltip')).toHaveCount(0)
  await arrow.evaluate((node) =>
    node
      .closest('.graph-jump-arrow')!
      .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })),
  )
  await expect(page.locator('.graph-arrow-tooltip')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.move(1000, 100)
  await arrow.hover()
  await expect(page.getByRole('tooltip')).toContainText('Common base')
})
