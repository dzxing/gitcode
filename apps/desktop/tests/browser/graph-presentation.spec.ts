import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import type { Snapshot } from '../../src/shared/contracts'

const sha = (row: number) => (row + 1).toString(16).padStart(40, '0')
function fixture(): Snapshot {
  const commits = Array.from({ length: 100 }, (_, row) => ({
    hash: sha(row),
    parents: (row === 0 ? [1, 2] : row < 13 ? [13] : row < 99 ? [row + 1] : []).map(sha),
    subject:
      row === 0
        ? 'Integrate independent histories'
        : row === 14
          ? 'Merge is only a word'
          : `History ${row}`,
    author: 'Graph test',
    email: 'graph@example.invalid',
    date: '2026-11-09T00:00:00Z',
    refs: [],
  }))
  return {
    ...structuredClone(repositoryFixture),
    name: 'Graph presentation',
    branch: 'main',
    head: sha(0),
    staged: [],
    unstaged: [],
    stashes: [],
    total: commits.length,
    commits,
    branches: [
      { name: 'main', hash: sha(0), kind: 'local', current: true, track: '', upstream: '' },
    ],
  }
}

test('row spacing follows graph width; merge highlighting respects selection and persistent menus', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openFixtureRepository(page, false, fixture())
  const merge = page.locator(`[data-commit-hash="${sha(0)}"]`)
  const plain = page.locator(`[data-commit-hash="${sha(14)}"]`)
  await plain.locator('.commit-select').click()
  await expect(merge).toHaveClass(/is-merge/)
  await expect(plain).not.toHaveClass(/is-merge/)
  const color = (row: typeof merge) =>
    row.locator('.commit-message').evaluate((el) => getComputedStyle(el).color)
  const muted = await color(merge)
  expect(muted).not.toBe(await color(plain))
  const geometry = () =>
    page
      .locator('[data-node-hash] > circle:first-child')
      .evaluateAll((nodes) =>
        nodes.map((n) => [n.getAttribute('cx'), n.getAttribute('cy'), n.getAttribute('fill')]),
      )
  const before = await geometry()
  await merge.locator('.commit-select').click()
  expect(await color(merge)).not.toBe(muted)
  expect(await geometry()).toEqual(before)
  await plain.locator('.commit-select').click()
  expect(await color(merge)).toBe(muted)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    const widths = await page.locator('.commit-row').evaluateAll((rows) =>
      rows.map((row) => ({
        width: Number.parseFloat((row as HTMLElement).style.getPropertyValue('--row-graph-width')),
        message: row.querySelector('.commit-message')!.getBoundingClientRect().left,
      })),
    )
    expect(widths[12]!.width).toBeGreaterThan(widths[99]!.width)
    expect(widths[12]!.message).toBeGreaterThan(widths[99]!.message)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'design/idea-graph-presentation/browser-verified.png' })
  await page.keyboard.press('Alt+v')
  const toggle = page.getByRole('menuitemcheckbox', { name: '淡化合并提交', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(merge).not.toHaveClass(/is-merge/)
  expect(await page.evaluate(() => localStorage.getItem('gitcode.graph-dim-merges'))).toBe('false')
  await page.reload()
  await page
    .getByRole('button', { name: 'repository /test-fixtures/repository', exact: true })
    .click()
  await expect(merge).toBeVisible()
  await expect(merge).not.toHaveClass(/is-merge/)
  await page.getByLabel('历史列表显示列', { exact: true }).click({ button: 'right' })
  const contextToggle = page.getByRole('menuitemcheckbox', { name: '淡化合并提交', exact: true })
  await expect(contextToggle).toHaveAttribute('aria-checked', 'false')
  await contextToggle.click()
  await expect(merge).toHaveClass(/is-merge/)
  expect(errors).toEqual([])
})

test('search preserves branch identity and collapsed ancestry; merge rings retain centered dots', async ({
  page,
}) => {
  const state = fixture()
  state.commits = [
    { ...state.commits[0]!, hash: sha(0), parents: [sha(2), sha(1)], subject: 'keep merge' },
    { ...state.commits[1]!, hash: sha(1), parents: [sha(3)], subject: 'omit side' },
    { ...state.commits[2]!, hash: sha(2), parents: [sha(3)], subject: 'omit intermediate' },
    { ...state.commits[3]!, hash: sha(3), parents: [], subject: 'keep root' },
  ]
  state.total = 4
  state.branches.push({
    name: 'feature/side',
    hash: sha(1),
    kind: 'local',
    current: false,
    track: '',
    upstream: '',
  })
  await openFixtureRepository(page, false, state)
  const colors = () =>
    page
      .locator('[data-node-hash]>circle:first-child')
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((n) => [
            n.parentElement!.getAttribute('data-node-hash'),
            n.getAttribute('stroke'),
          ]),
        ),
      )
  const before = await colors()
  const mergeCircle = page.locator(`[data-node-hash="${sha(0)}"]>circle:first-child`)
  await expect(mergeCircle).toHaveAttribute('fill', 'var(--bg)')
  await expect(mergeCircle).toHaveAttribute('stroke-width', '2')
  const center = page.locator(`[data-node-hash="${sha(0)}"]>.merge-node-center`)
  await expect(center).toHaveCount(1)
  await expect(center).toHaveAttribute('cx', (await mergeCircle.getAttribute('cx'))!)
  await expect(center).toHaveAttribute('cy', (await mergeCircle.getAttribute('cy'))!)
  await expect(page.locator(`[data-node-hash="${sha(1)}"]>.merge-node-center`)).toHaveCount(0)
  const search = page.getByRole('textbox', { name: '搜索提交', exact: true })
  await search.fill('keep')
  await expect(page.locator('.commit-row')).toHaveCount(2)
  await expect(center).toHaveCount(1)
  await expect(center).toHaveAttribute('cx', (await mergeCircle.getAttribute('cx'))!)
  await expect(center).toHaveAttribute('cy', (await mergeCircle.getAttribute('cy'))!)
  const collapsed = page.locator(
    `.commit-graph>path[data-child-hash="${sha(0)}"][data-parent-hash="${sha(3)}"]`,
  )
  await expect(collapsed).toHaveAttribute('stroke-dasharray', '3 3')
  const after = await colors()
  for (const [hash, color] of Object.entries(after)) expect(color).toBe(before[hash])
  await page.screenshot({ path: 'design/idea-graph-fixes/filtered-history.png' })
  await search.fill('')
  await expect(page.locator('.commit-row')).toHaveCount(4)
  expect(await colors()).toEqual(before)
  await expect(collapsed).toHaveCount(0)
})
