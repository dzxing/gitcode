import { expect, test } from '@playwright/test'
import type { FileChange, Snapshot } from '../../src/types'
declare global {
  interface Window {
    __fileViewWrites: number
  }
}

const files: FileChange[] = [
  { path: 'src/a/index.ts', status: 'M' },
  { path: 'src/b/index.ts', status: 'M' },
  {
    path: 'src/很长的目录/VeryLongRepositoryStatementTemplateConfigurationController.java',
    status: 'M',
  },
  { path: 'README.md', status: 'M' },
  { path: 'src/new/renamed.ts', oldPath: 'src/old/original.ts', status: 'R' },
]
const hash = 'a'.repeat(40)
const fixture: Snapshot = {
  path: '/file-view-check',
  name: 'file-view-check',
  head: hash,
  branch: 'main',
  total: 1,
  staged: [{ path: 'staged.txt', status: 'A' }],
  unstaged: files,
  commits: [
    {
      hash,
      parents: [],
      subject: 'File view check',
      author: 'Tester',
      email: 'test@example.com',
      date: '2026-10-29T00:00:00Z',
      refs: ['HEAD -> main'],
    },
  ],
  branches: [
    {
      name: 'main',
      fullRef: 'refs/heads/main',
      hash,
      current: true,
      upstream: '',
      track: '',
      kind: 'local',
    },
  ],
}

test('file density preserves selections and drafts, distinguishes paths and persists independent view preferences', async ({
  page,
}) => {
  await page.addInitScript(
    ({ fixture, files }) => {
      const blocked = async () => {
        window.__fileViewWrites++
        throw new Error('No Git writes in display checks')
      }
      window.__fileViewWrites = 0
      window.gitk = {
        runtime: async () => ({
          platform: 'windows',
          gitAvailable: true,
          gitVersion: 'test',
          gitPath: 'test',
          gitError: '',
        }),
        repositoryTrust: async (path: string) => ({
          path,
          gitDir: path + '/.git',
          trusted: true,
          token: '',
        }),
        snapshot: async () => structuredClone(fixture),
        commit: async () => ({ body: 'File view check', files: structuredClone(files) }),
        diff: async () => ({
          diff: 'diff --git a/src/a/index.ts b/src/a/index.ts\n--- a/src/a/index.ts\n+++ b/src/a/index.ts\n@@ -1 +1 @@\n-before\n+after',
          truncated: false,
        }),
        action: blocked,
        create: blocked,
        chooseDirectory: async () => fixture.path,
        cancel: async () => {},
        openResource: async () => {},
        syncPlan: blocked,
        gitflowPlan: blocked,
        listDirectory: blocked,
      }
    },
    { fixture, files },
  )
  const open = async () => {
    await page.keyboard.press('Control+o')
    await expect(page.locator('.repo-selector strong')).toHaveText(fixture.name)
  }
  await page.goto('/')
  await open()
  const settings = () => page.getByLabel('工作区视图选项', { exact: true }).click()
  await settings()
  const mode = page.getByRole('group', { name: '文件列表显示方式' })
  await expect(mode.getByRole('button', { name: '紧凑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.changes-scroll .file-row').first()).toHaveCSS('height', '32px')
  await mode.getByRole('button', { name: '详细', exact: true }).click()
  await expect(page.locator('.changes-scroll .file-row').first()).toHaveCSS('height', '40px')
  await page
    .getByRole('textbox', { name: '提交说明', exact: true })
    .fill('Keep draft while changing density')
  await page.locator('[data-file-path="src/a/index.ts"]').click()
  await expect(page.getByRole('region', { name: '文件差异' })).toBeVisible()
  await settings()
  await mode.getByRole('button', { name: '紧凑', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.changes-scroll .file-row').first()).toHaveCSS('height', '32px')
  await expect(page.locator('.changes-scroll .file-list-compact')).toHaveCount(2)
  await expect(page.locator('.file-row.selected [data-file-path="src/a/index.ts"]')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '文件差异' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(
    'Keep draft while changing density',
  )
  for (const path of ['src/a/index.ts', 'src/b/index.ts']) {
    const file = page.locator(`[data-file-path="${path}"]`)
    await expect(file).toHaveAccessibleName(`查看文件差异 ${path}`)
    await expect(file.locator('.file-basename')).toHaveText('index.ts')
    expect(await file.locator('.file-directory').evaluate((e) => e.clientWidth)).toBeGreaterThan(0)
  }
  await expect(page.locator('[data-file-path="README.md"] .file-directory')).toHaveCount(0)
  await expect(page.locator('[data-file-path="src/new/renamed.ts"]')).toHaveAccessibleName(
    '查看文件差异 src/old/original.ts → src/new/renamed.ts',
  )
  await page.setViewportSize({ width: 900, height: 960 })
  const longRow = page.locator('[data-file-path$="Controller.java"]').locator('..')
  await expect(longRow.locator('.file-basename')).toHaveCSS('overflow', 'hidden')
  const basename = await longRow.locator('.file-basename').boundingBox()
  const directory = await longRow.locator('.file-directory').boundingBox()
  expect(basename!.x + basename!.width + 7).toBeLessThanOrEqual(directory!.x)
  expect(directory!.width).toBeGreaterThan(0)
  const label = await longRow.locator('.file-name').boundingBox()
  const status = await longRow.locator('.file-status').boundingBox()
  const action = await longRow.locator('.file-action').boundingBox()
  expect(label!.x + label!.width).toBeLessThanOrEqual(status!.x)
  expect(status!.x + status!.width).toBeLessThanOrEqual(action!.x)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.locator('.commit-select').first().click()
  await expect(mode.getByRole('button', { name: '紧凑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.file-row').first()).toHaveCSS('height', '32px')
  await mode.getByRole('button', { name: '详细', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.file-row').first()).toHaveCSS('height', '40px')
  await page.getByRole('button', { name: '返回工作区', exact: true }).click()
  await settings()
  await expect(mode.getByRole('button', { name: '紧凑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.reload()
  await open()
  await settings()
  await expect(mode.getByRole('button', { name: '紧凑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')
  await page.locator('.commit-select').first().click()
  await expect(mode.getByRole('button', { name: '详细', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await page.evaluate(() => window.__fileViewWrites)).toBe(0)
})
