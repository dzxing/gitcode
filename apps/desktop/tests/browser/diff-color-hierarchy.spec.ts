import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { openFixtureRepository } from './repository-fixture'
import { measureThemeContrast } from './theme-audit-metrics'
const themes: Record<string, { mode: 'dark' | 'light' }> = createRequire(import.meta.url)(
  '../../electron/theme-presets.json',
)
for (const [theme, preset] of Object.entries(themes)) {
  test(`${theme}: diff fragments, merge selection and conflict editing`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: preset.mode })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await openFixtureRepository(page)
    const mergeRow = page.locator('.commit-row.is-merge').first()
    await expect(mergeRow).toBeVisible()
    await mergeRow.locator('.commit-select').click()
    await expect(mergeRow).toHaveClass(/selected/)
    const metrics = await measureThemeContrast(page, {
      selectedMerge: '.commit-row.is-merge.selected .commit-message',
    })
    for (const metric of metrics) expect(metric.ratio).toBeGreaterThanOrEqual(4.5)
    await page.evaluate(async () => {
      const modulePath = '/src/features/repository/stores/repository.ts'
      const repo = (await import(modulePath)).useRepositoryStore()
      repo.clearSelection()
      repo.selectedFile = { path: 'colors.ts', status: 'M' }
      repo.diffLoading = false
      repo.diffText =
        'diff --git a/colors.ts b/colors.ts\n--- a/colors.ts\n+++ b/colors.ts\n@@ -1,2 +1,2 @@\n-const value = "old"\n+const value = "new"\n context\n'
    })
    await expect(page.locator('.diff-fragment')).toHaveText(['old', 'new'])
    const contrasts = await measureThemeContrast(page, {
      add: '.diff-line.add code',
      remove: '.diff-line.remove code',
      addedFragment: '.diff-line.add .diff-fragment',
      removedFragment: '.diff-line.remove .diff-fragment',
    })
    expect(contrasts).toHaveLength(4)
    for (const metric of contrasts)
      expect(metric.ratio, `${theme} ${metric.role}`).toBeGreaterThanOrEqual(4.5)
    const output = `.tmp/diff-color-hierarchy/${theme}`
    await mkdir(output, { recursive: true })
    await page.locator('.diff-panel').screenshot({ path: `${output}/diff.png` })
    await page.evaluate(async () => {
      const repoPath = '/src/features/repository/stores/repository.ts',
        mergePath = '/src/features/merge/stores/merge.ts'
      const repo = (await import(repoPath)).useRepositoryStore()
      repo.clearSelection()
      const state = {
        active: true,
        head: repo.repo.head,
        incoming: repo.repo.head,
        branch: repo.repo.branch,
        signature: 'colors',
        unsupported: false,
        staged: [],
        message: 'merge',
        files: [{ path: 'colors.ts', type: 'UU', stages: {} }],
      }
      repo.repo.merge = state
      // Allow the state watcher to initialize the session before setting the editor fixture.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const merge = (await import(mergePath)).useMergeStore()
      const working =
        'prefix\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> incoming\nsuffix\n' +
        'long '.repeat(250) +
        '\n' +
        'context\n'.repeat(80)
      merge.session.state = state
      merge.session.file = {
        path: 'colors.ts',
        token: 'colors',
        branch: repo.repo.branch,
        incoming: repo.repo.head,
        base: { exists: true, text: 'base\n', binary: false },
        ours: { exists: true, text: 'local\n', binary: false },
        theirs: { exists: true, text: 'remote\n', binary: false },
        working,
        editable: true,
        supported: true,
      }
      merge.session.draft = working
      merge.session.editor = true
    })
    const input = page.getByRole('textbox', { name: '编辑合并结果' })
    await expect(input).toBeVisible()
    await expect(page.locator('.merge-conflict-backdrop mark')).toContainText('<<<<<<< HEAD')
    await expect(page.locator('.merge-result-status')).toHaveText('1 个冲突块')
    await expect(page.getByRole('button', { name: '保存并标记已解决', exact: true })).toBeDisabled()
    // Measure the textarea ink against its sibling backdrop's actual highlight background.
    await page.locator('.merge-conflict-backdrop mark').evaluate((element) => {
      ;(element as HTMLElement).style.color = getComputedStyle(
        document.querySelector('.merge-result textarea')!,
      ).color
    })
    const conflictContrast = await measureThemeContrast(page, {
      conflictInk: '.merge-conflict-backdrop mark',
      conflictStatus: '.merge-result-status',
    })
    await page.locator('.merge-conflict-backdrop mark').evaluate((element) => {
      ;(element as HTMLElement).style.removeProperty('color')
    })
    for (const metric of conflictContrast)
      expect(metric.ratio, `${theme} ${metric.role}`).toBeGreaterThanOrEqual(4.5)
    const geometry = await input.evaluate((element) => {
      const backdrop = document.querySelector<HTMLElement>('.merge-conflict-backdrop')!
      const a = getComputedStyle(element),
        b = getComputedStyle(backdrop)
      return {
        same: [
          'fontFamily',
          'fontSize',
          'lineHeight',
          'paddingTop',
          'paddingLeft',
          'whiteSpace',
          'tabSize',
        ].every(
          (key) =>
            a.getPropertyValue(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) ===
            b.getPropertyValue(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())),
        ),
        hidden: backdrop.getAttribute('aria-hidden'),
      }
    })
    expect(geometry).toEqual({ same: true, hidden: 'true' })
    await input.evaluate((element) => {
      element.scrollTop = 100
      element.scrollLeft = 120
      element.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() =>
        input.evaluate((element) => {
          const backdrop = document.querySelector<HTMLElement>('.merge-conflict-backdrop')!
          return (
            Math.abs(element.scrollTop - backdrop.scrollTop) +
            Math.abs(element.scrollLeft - backdrop.scrollLeft)
          )
        }),
      )
      .toBe(0)
    await input.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.scrollLeft = element.scrollWidth
      element.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() =>
        input.evaluate((element) => {
          const backdrop = document.querySelector<HTMLElement>('.merge-conflict-backdrop')!
          return (
            Math.abs(element.scrollTop - backdrop.scrollTop) +
            Math.abs(element.scrollLeft - backdrop.scrollLeft)
          )
        }),
      )
      .toBe(0)
    await input.evaluate((element) => {
      element.scrollTop = 0
      element.scrollLeft = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await page.locator('.merge-editor').screenshot({ path: `${output}/conflict.png` })
    await page.getByRole('button', { name: '本块采用当前分支', exact: true }).click()
    await expect(page.locator('.merge-conflict-backdrop mark')).toHaveCount(0)
    await expect(page.locator('.merge-result-status')).toHaveText('待检查并保存')
    await expect(input).toHaveValue(/^prefix\nlocal\nsuffix\n/)
    await expect(page.getByRole('button', { name: '保存并标记已解决', exact: true })).toBeEnabled()
    await input.fill('<img src=x onerror="alert(1)">\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n')
    await expect(page.locator('.merge-conflict-backdrop mark')).toHaveCount(1)
    await expect(page.locator('.merge-conflict-backdrop img')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存并标记已解决', exact: true })).toBeDisabled()
  })
}
