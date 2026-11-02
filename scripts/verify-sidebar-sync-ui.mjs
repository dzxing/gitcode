import { expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const hash = 'a'.repeat(40)
const branches = [
  ['main', 'origin/main', '[ahead 2, behind 1]', true],
  ['develop', 'origin/develop', '[behind 3]', false],
  ['feature/unpublished', '', '', false],
  ['feature/gone', 'origin/feature/gone', '[gone]', false],
  ['feature/synced', 'origin/feature/synced', '', false],
].map(([name, upstream, track, current]) => ({
  kind: 'local',
  fullRef: 'refs/heads/' + name,
  name,
  hash,
  upstream,
  track,
  current,
}))
const snapshot = {
  path: '/sidebar-sync-check',
  name: 'Sidebar sync',
  head: hash,
  branch: 'main',
  total: 1,
  staged: [],
  unstaged: [],
  commits: [
    {
      hash,
      parents: [],
      subject: 'Status fixture',
      author: 'Test',
      email: 'test@example.com',
      date: '2026-10-29T00:00:00Z',
      refs: ['HEAD -> main'],
    },
  ],
  branches: [
    ...branches,
    ...['remote', 'tag'].map((kind) => ({
      kind,
      name: kind === 'remote' ? 'origin/main' : 'v1',
      hash,
      current: false,
      upstream: '',
      track: '',
    })),
  ],
  gitflow: {
    config: {
      production: 'main',
      develop: 'develop',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    },
    configured: true,
    ready: true,
    missing: [],
    error: '',
    writeError: '',
    signature: 'sync-check',
  },
}
export async function verifySidebarSync(page, { url, screenshotDirectory } = {}) {
  await page.addInitScript((snapshot) => {
    const blocked = async () => {
      throw new Error('Read-only sidebar fixture')
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      snapshot: async () => structuredClone(snapshot),
      commit: async () => ({ files: [], body: '' }),
      diff: async () => ({ diff: '', truncated: false }),
      action: blocked,
      create: blocked,
      chooseDirectory: async () => snapshot.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: async (_repo, kind, expected) => {
        if (kind === 'push' && expected.sourceRef === 'refs/heads/feature/unpublished')
          throw new Error('分支 feature/unpublished 尚无明确上游，请先通过 Git 配置上游后重试。')
        return blocked()
      },
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, snapshot)
  await page.goto(url)
  await page.keyboard.press('Control+o')
  const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await open.getByRole('textbox', { name: '仓库路径', exact: true }).fill(snapshot.path)
  await open.getByRole('button', { name: '打开仓库', exact: true }).click()
  await expect(open).not.toBeVisible()
  const row = (section, name) =>
    page.locator(`[data-sidebar-section="${section}"] [data-branch-name="${name}"]`)
  for (const section of ['local', 'gitflow']) {
    const current = row(section, 'main')
    await expect(current.locator('.branch-current-check')).toHaveCount(1)
    await expect(current.locator('.is-ahead')).toHaveText('↑2')
    await expect(current.locator('.is-behind')).toHaveText('↓1')
    await expect(current.locator('.branch-main')).toHaveAttribute(
      'aria-label',
      /领先 2 个提交，落后 1 个提交/,
    )
    await expect(row(section, 'develop').locator('.is-behind')).toHaveText('↓3')
    await expect(row(section, 'develop').locator('.is-ahead')).toHaveCount(0)
    await expect(row(section, 'feature/unpublished').locator('.branch-meta')).toHaveCount(0)
    await expect(row(section, 'feature/gone').locator('.branch-sync-state')).toHaveText('上游缺失')
    await expect(row(section, 'feature/synced').locator('.branch-meta')).toHaveCount(0)
  }
  for (const section of ['remote', 'tag'])
    await expect(
      page.locator(`[data-sidebar-section="${section}"] .branch-sync-state`),
    ).toHaveCount(0)
  await expect(page.locator('.branch-selector .tracking')).toHaveText('↑2 ↓1')
  const geometry = []
  for (const width of [190, 210, 330]) {
    await page
      .locator('.app-shell')
      .evaluate((el, width) => el.style.setProperty('--sidebar-width', `${width}px`), width)
    for (const section of ['local', 'gitflow'])
      for (const name of ['main', 'develop', 'feature/unpublished', 'feature/gone']) {
        const entry = row(section, name)
        const value = await entry.evaluate((el) => {
          const row = el.getBoundingClientRect(),
            label = el.querySelector('.branch-name').getBoundingClientRect(),
            meta = el.querySelector('.branch-meta')?.getBoundingClientRect(),
            star = el.querySelector('.branch-favorite').getBoundingClientRect()
          return {
            labelWidth: label.width,
            noOverlap:
              label.right <= (meta?.left ?? star.left) + 0.5 &&
              (!meta || meta.right <= star.left + 0.5),
            inside: (meta?.right ?? label.right) <= row.right + 0.5,
          }
        })
        assert.ok(value.labelWidth > 0)
        assert.equal(value.noOverlap, true, `${section}/${name} at ${width}px`)
        assert.equal(value.inside, true)
        geometry.push({ width, section, name, ...value })
      }
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: `${screenshotDirectory}/sidebar-${width}.png` })
    }
  }
  await row('local', 'feature/unpublished').click({ button: 'right' })
  const push = page.getByRole('menuitem', { name: '推送此分支…', exact: true })
  await expect(push).toBeEnabled()
  await push.click()
  const dialog = page.getByRole('dialog', { name: '推送指定分支', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('尚未关联远端分支')
  await expect(dialog.getByRole('button', { name: '确认推送', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  return {
    unlinkedPushExplainedOnDemand: true,
    currentCheckAndCountsCoexist: true,
    localAndGitFlowConsistent: true,
    unconfiguredUpstreamQuiet: true,
    noWarningsOnRemoteOrTag: true,
    geometry,
  }
}
