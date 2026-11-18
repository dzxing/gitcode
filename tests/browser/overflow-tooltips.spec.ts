import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

test('visible names stay quiet; clipped commit text gains a title and clears it after resize or leaving', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const state = structuredClone(repositoryFixture)
  state.name = 'Short'
  state.commits[0]!.subject = 'Short'
  const full = 'Improve history rendering and repository navigation '.repeat(2)
  state.commits[1]!.subject = full
  await page.setViewportSize({ width: 1280, height: 900 })
  await openFixtureRepository(page, false, state)
  await expect(page.locator('.section-count')).toHaveCount(0)
  await expect(page.locator('.section-toggle')).toHaveCount(5)
  await page.locator('.tab-select').hover()
  await expect(page.locator('.tab-select')).not.toHaveAttribute('title')
  await page.locator('.repo-selector').hover()
  await expect(page.locator('.repo-selector')).not.toHaveAttribute('title')
  const groupedBranch = page.locator(
    '[data-sidebar-section="local"] [data-branch-name="feature/commit-graph"] .branch-main',
  )
  await groupedBranch.hover()
  await expect
    .poll(() =>
      groupedBranch.locator('.branch-name').evaluate((el) => el.scrollWidth <= el.clientWidth),
    )
    .toBe(true)
  await expect(page.locator('.branch-name-tooltip')).toHaveCount(0)
  const short = page.getByRole('button', { name: '查看提交 Short', exact: true })
  await short.hover()
  await expect(short).not.toHaveAttribute('title')
  const long = page.getByRole('button', { name: `查看提交 ${full.trim()}`, exact: true })
  await long.hover()
  await expect(long).toHaveAttribute('title', full)
  await page.mouse.move(4, 4)
  await expect(long).not.toHaveAttribute('title')
  await long.hover()
  await expect(long).toHaveAttribute('title', full)
  await page.setViewportSize({ width: 2800, height: 900 })
  const text = page.locator('.commit-row').filter({ has: long }).locator('.commit-subject')
  await expect.poll(() => text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(long).not.toHaveAttribute('title')
  expect(errors).toEqual([])
})
