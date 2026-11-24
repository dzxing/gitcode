import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import { createRequire } from 'node:module'
const themePresets: Record<string, { mode: 'dark' | 'light' }> = createRequire(import.meta.url)(
  '../../electron/theme-presets.json',
)
import { measureThemeContrast } from './theme-audit-metrics'
import { mkdir, writeFile } from 'node:fs/promises'
import type { FileChange } from '../../src/types'

const staged: FileChange[] = [
  { path: 'tracked/modified.ts', status: 'M' },
  { path: 'added.ts', status: 'A' },
  { path: 'deleted.ts', status: 'D' },
  { path: 'renamed.ts', oldPath: 'old.ts', status: 'R' },
  { path: 'copied.ts', oldPath: 'source.ts', status: 'C' },
  { path: 'type.ts', status: 'T' },
]
const files: FileChange[] = [
  ...staged,
  { path: 'loose/untracked.ts', status: '?' },
  { path: 'conflict.ts', status: 'U' },
]

for (const [theme, preset] of Object.entries(themePresets)) {
  test(`${theme}: file names and status codes have consistent accessible colors in all file views`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: preset.mode as 'dark' | 'light' })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.staged = staged
    snapshot.unstaged = files.slice(staged.length)
    await openFixtureRepository(page, false, snapshot)
    await page.getByRole('button', { name: '目录视图', exact: true }).click()
    const report: unknown[] = []
    const colors: Record<string, string> = {}
    for (const file of files) {
      const row = page.locator(`.worktree-node-row[data-worktree-path="${file.path}"]`)
      const marker = row.locator('.file-status')
      await expect(marker).toHaveText(file.status)
      const color = await marker.evaluate((e) => getComputedStyle(e).color)
      colors[file.status] = color
      await expect(row.locator('.file-basename')).toHaveCSS('color', color)
      await row.hover()
      const metrics = await measureThemeContrast(page, {
        name: `.worktree-node-row[data-worktree-path="${file.path}"] .file-basename`,
        marker: `.worktree-node-row[data-worktree-path="${file.path}"] .file-status`,
      })
      expect(metrics).toHaveLength(2)
      for (const metric of metrics)
        expect(metric.ratio, `${theme} ${file.status} ${metric.role}`).toBeGreaterThanOrEqual(4.5)
      report.push({ file, state: 'hover', metrics })
    }
    expect(colors.M).not.toBe(colors.A)
    expect(colors['?']).not.toBe(colors.A)
    expect(colors.U).not.toBe(colors.D)
    expect(colors.C).toBe(colors.A)
    // Match the actual directory row independently of the internal key format.
    const trackedFolder = page
      .locator('.worktree-node-row')
      .filter({ has: page.locator('.worktree-folder-main > span', { hasText: /^tracked$/ }) })
    await expect(trackedFolder).toHaveAttribute('data-file-status', 'modified')
    await expect(trackedFolder.locator('.worktree-folder-main > span')).toHaveCSS('color', colors.M)
    const selected = page.locator('[data-file-path="tracked/modified.ts"]')
    await selected.click()
    const active = page.locator('.worktree-node-row[data-worktree-path="tracked/modified.ts"]')
    await expect(active).toHaveClass(/is-active/)
    const selectedMetrics = await measureThemeContrast(page, {
      name: '.worktree-node-row.is-active .file-basename',
      marker: '.worktree-node-row.is-active .file-status',
    })
    for (const metric of selectedMetrics)
      expect(metric.ratio, `${theme} selected`).toBeGreaterThanOrEqual(4.5)
    report.push({ state: 'selected', metrics: selectedMetrics })
    await page.getByRole('button', { name: '列表视图', exact: true }).click()
    await expect(
      page.locator('.worktree-node-row[data-worktree-path="loose/untracked.ts"] .file-status'),
    ).toHaveText('?')
    await expect(
      page.locator('.worktree-node-row[data-worktree-path="loose/untracked.ts"] .file-basename'),
    ).toHaveCSS('color', colors['?'])
    const out = `.tmp/file-status-colors/${theme}`
    await mkdir(out, { recursive: true })
    await page.locator('.inspector').screenshot({ path: `${out}/worktree.png` })
    await page.evaluate((files) => {
      window.gitcode!.commit = async () => ({ body: 'File status colors', files })
    }, files)
    await page.locator('.commit-row[data-commit-hash]').first().click()
    for (const file of files) {
      const row = page.locator(`[data-file-historical="true"][data-file-path="${file.path}"]`)
      await expect(row.locator('.file-status')).toHaveText(file.status)
      await expect(row.locator('.file-basename')).toHaveCSS('color', colors[file.status])
    }
    await page.locator('.inspector').screenshot({ path: `${out}/history.png` })
    await page.evaluate(async (files) => {
      const modulePath = '/src/stores/repository.ts'
      const store = (await import(modulePath)).useRepositoryStore()
      const entry = {
        ref: 'stash@{0}',
        oid: 'f'.repeat(40),
        message: 'Status colors',
        date: new Date().toISOString(),
        branch: store.repo.branch,
        base: store.repo.head,
      }
      window.gitcode!.stashRead = async () => ({
        files,
        stagedPaths: [],
        base: store.repo.head,
        diff: null,
      })
      store.repo.stashes = [entry]
      store.repo.stashSignature = 'status-colors'
      store.selectedCommit = null
      store.selectedFile = null
      const stashModulePath = '/src/stores/stash.ts'
      ;(await import(stashModulePath)).useStashStore().openList(entry)
    }, files)
    for (const file of files) {
      const row = page.locator(`[data-stash-file-path="${file.path}"]`)
      await expect(row.locator('.file-status')).toHaveText(file.status)
      await expect(row.locator('.stash-file-name')).toHaveCSS('color', colors[file.status])
    }
    await page.locator('.inspector').screenshot({ path: `${out}/stash.png` })
    await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n')
  })
}
