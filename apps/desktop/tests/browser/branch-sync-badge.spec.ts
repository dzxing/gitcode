import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { repositoryFixture } from '../fixtures/repository'
import { openFixtureRepository } from './repository-fixture'
import { measureThemeContrast } from './theme-audit-metrics'
const themes: Record<string, { mode: 'dark' | 'light' }> = createRequire(import.meta.url)(
  '../../electron/theme-presets.json',
)
for (const [theme, preset] of Object.entries(themes))
  test(`${theme}: sync counts align beside the branch name and stay readable`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: preset.mode })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    const state = structuredClone(repositoryFixture)
    state.branches.find((b) => b.current)!.track = '[ahead 3, behind 124]'
    await openFixtureRepository(page, false, state)
    const toolbar = page.locator('.tracking .branch-sync-badge')
    await expect(toolbar.locator('.branch-sync-number')).toHaveText(['3', '124'])
    await expect(toolbar.locator('[data-icon="ArrowUp"]')).toHaveCount(1)
    await expect(toolbar.locator('[data-icon="ArrowDown"]')).toHaveCount(1)
    const offsets = await page.locator('.branch-selector-name').evaluate((row) => {
      const nodes = [
        row.querySelector('strong')!,
        ...row.querySelectorAll('.branch-sync-number, svg'),
      ]
      const centers = nodes.map((e) => {
        const r = e.getBoundingClientRect()
        return r.top + r.height / 2
      })
      return Math.max(...centers) - Math.min(...centers)
    })
    expect(offsets).toBeLessThan(0.6)
    const sidebar = page.locator('[data-sidebar-section="local"] .branch-row.current')
    await expect(sidebar.locator('.branch-sync-number')).toHaveText(['3', '124'])
    for (const hover of [false, true]) {
      if (hover) await sidebar.hover()
      const metrics = await measureThemeContrast(page, {
        toolbarAhead: '.tracking .is-ahead',
        toolbarBehind: '.tracking .is-behind',
        sidebarAhead: '[data-sidebar-section="local"] .branch-row.current .is-ahead',
        sidebarBehind: '[data-sidebar-section="local"] .branch-row.current .is-behind',
      })
      expect(metrics).toHaveLength(4)
      for (const m of metrics)
        expect(m.ratio, `${theme} ${m.role} hover=${hover}`).toBeGreaterThanOrEqual(4.5)
    }
    await mkdir(`.tmp/sync-badge/${theme}`, { recursive: true })
    await page
      .locator('.branch-selector')
      .screenshot({ path: `.tmp/sync-badge/${theme}/toolbar.png` })
    await page.evaluate(async () => {
      const name = '/src/features/repository/stores/repository.ts'
      const s = (await import(name)).useRepositoryStore()
      s.repo.branches.find((b: { current: boolean }) => b.current)!.track = ''
    })
    await expect(page.locator('.tracking')).toHaveCount(0)
    await expect(sidebar.locator('.branch-sync-badge')).toHaveCount(0)
    await page.evaluate(async () => {
      const name = '/src/features/repository/stores/repository.ts'
      const s = (await import(name)).useRepositoryStore()
      s.repo.branches.find((b: { current: boolean }) => b.current)!.track = '[gone]'
    })
    await expect(page.locator('.tracking')).toHaveText('上游不存在')
    await expect(sidebar.locator('.branch-sync-state')).toHaveText('上游缺失')
  })
