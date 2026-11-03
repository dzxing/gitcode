import { expect, type Page } from '@playwright/test'
import { repositoryFixture } from '../fixtures/repository'
import { openFixtureRepository } from './repository-fixture'

export async function verifyRemoteTree(page: Page) {
  const snapshot = structuredClone(repositoryFixture)
  snapshot.remotes = ['upstream', 'origin', 'empty', 'team/company']
  snapshot.branches = snapshot.branches.filter((branch) => branch.kind !== 'remote')
  for (const name of [
    'origin/main',
    'origin/develop',
    'origin/feature/dev10',
    'origin/feature/dev2',
    'origin/feature/team/task',
    'upstream/main',
    'team/company/topic',
  ]) {
    snapshot.branches.push({
      name,
      fullRef: `refs/remotes/${name}`,
      kind: 'remote',
      hash: snapshot.head,
      current: false,
      upstream: '',
      track: '',
    })
  }
  snapshot.branches.push({
    name: 'origin/HEAD',
    fullRef: 'refs/remotes/origin/HEAD',
    symbolicTarget: 'refs/remotes/origin/main',
    kind: 'remote',
    hash: snapshot.head,
    current: false,
    upstream: '',
    track: '',
  })
  async function reopen() {
    await page.reload()
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await dialog.getByLabel('仓库路径', { exact: true }).fill('/test-fixtures/repository')
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(dialog).not.toBeVisible()
  }
  snapshot.gitflow = {
    configured: true,
    ready: true,
    missing: [],
    error: '',
    writeError: '',
    signature: 'navigation-tree',
    config: {
      production: 'main',
      develop: 'develop',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    },
  }
  snapshot.branches.push({
    name: 'feature/team/local-task',
    fullRef: 'refs/heads/feature/team/local-task',
    kind: 'local',
    hash: snapshot.head,
    current: false,
    upstream: '',
    track: '',
  })
  snapshot.branches.push({
    name: 'versions/v2',
    fullRef: 'refs/tags/versions/v2',
    kind: 'tag',
    hash: snapshot.head,
    current: false,
    upstream: '',
    track: '',
  })
  await openFixtureRepository(page, false, snapshot)
  const section = page.locator('[data-sidebar-section="remote"]')
  const settings = page.getByRole('button', { name: '仓库导航显示设置', exact: true })
  const local = page.locator('[data-sidebar-section="local"]')
  const gitflow = page.locator('[data-sidebar-section="gitflow"]')
  const tags = page.locator('[data-sidebar-section="tag"]')
  const localFeature = local.getByRole('button', { name: '展开或折叠目录 feature', exact: true })
  await expect(
    tags.getByRole('button', { name: '展开或折叠目录 versions', exact: true }),
  ).toBeVisible()
  await localFeature.click()
  await expect(local.locator('[data-branch-name="feature/team/local-task"]')).not.toBeVisible()
  await expect(gitflow.locator('[data-branch-name="feature/team/local-task"]')).toBeVisible()
  await localFeature.click()
  const feature = section
    .locator('[data-remote-name="origin"]')
    .getByRole('button', { name: '展开或折叠目录 feature', exact: true })
  const dev2 = section.locator('[data-branch-name="origin/feature/dev2"]')
  const dev10 = section.locator('[data-branch-name="origin/feature/dev10"]')
  await expect(section.locator('[data-remote-name]')).toHaveCount(4)
  expect(
    await section
      .locator('[data-remote-name]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-remote-name'))),
  ).toEqual(['origin', 'empty', 'team/company', 'upstream'])
  await expect(section.locator('[data-branch-name="origin/HEAD"]')).toHaveCount(0)
  await expect(section.locator('[data-remote-name="team/company"] .branch-name')).toHaveText(
    'topic',
  )
  await expect(dev2.locator('.branch-name')).toHaveText('dev2')
  const folder = feature.locator('..')
  expect(
    await folder
      .locator('[data-branch-name]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-branch-name'))),
  ).toEqual(['origin/feature/dev2', 'origin/feature/dev10', 'origin/feature/team/task'])
  await feature.click()
  await expect(dev2).not.toBeVisible()
  const search = page.getByRole('textbox', { name: '筛选分支', exact: true })
  await search.fill('dev2')
  await expect(dev2).toBeVisible()
  await search.fill('')
  await expect(dev2).not.toBeVisible()
  await feature.click()
  await folder.evaluate(async (node) => {
    await Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    )
  })
  await dev10.hover()
  await dev10.getByRole('button', { name: '收藏 origin/feature/dev10', exact: true }).click()
  await expect(dev10).toHaveCount(1)
  const origin = section.locator('[data-remote-name="origin"]')
  expect(
    (
      await origin
        .locator('[data-branch-name]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-branch-name')))
    )[0],
  ).toBe('origin/feature/dev10')
  await dev2.locator('.branch-main').click()
  await expect(dev2.locator('.branch-main')).toHaveAttribute('aria-pressed', 'true')
  await dev2.locator('.branch-main').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '创建本地跟踪分支…', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await settings.click()
  const grouping = page.getByRole('menuitemcheckbox', { name: /按目录分组/ })
  await expect(grouping).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menuitem', { name: /当前分支优先/ })).toHaveCount(0)
  await grouping.click()
  await expect(page.locator('.branch-tree-folder')).toHaveCount(0)
  await expect(
    local.locator('[data-branch-name="feature/team/local-task"] .branch-name'),
  ).toHaveText('feature/team/local-task')
  await expect(
    gitflow.locator('[data-branch-name="feature/team/local-task"] .branch-name'),
  ).toHaveText('feature/team/local-task')
  await expect(tags.locator('[data-branch-name="versions/v2"] .branch-name')).toHaveText(
    'versions/v2',
  )
  await expect(section.locator('[data-remote-name]')).toHaveCount(0)
  await expect(dev2.locator('.branch-name')).toHaveText('origin/feature/dev2')
  await expect(dev2.locator('.branch-main')).toHaveAttribute('aria-pressed', 'true')
  await reopen()
  await expect(settings).toBeVisible()
  await expect(section.locator('[data-remote-name]')).toHaveCount(0)
  await settings.click()
  await expect(grouping).toHaveAttribute('aria-checked', 'false')
  await grouping.click()
  await expect(section.locator('[data-remote-name]')).toHaveCount(4)
  await feature.click()
  await reopen()
  await expect(feature).toHaveAttribute('aria-expanded', 'false')
  await feature.click()
  return {
    settingsToggle: true,
    allNavigationSections: true,
    independentFolderState: true,
    perRepositoryPersistence: true,
    naturalOrder: true,
    favoriteUnique: true,
    searchRestoresCollapse: true,
    branchActionsPreserved: true,
    slashInRemoteName: true,
  }
}
