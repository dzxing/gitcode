import type { Page } from '@playwright/test'
import { repositoryFixture } from '../fixtures/repository'

// Test-only preload bridge. No fixture data is imported by the application.
export async function openFixtureRepository(
  page: Page,
  gitflow = false,
  initialSnapshot = repositoryFixture,
) {
  const snapshot = structuredClone(initialSnapshot)
  snapshot.path = '/test-fixtures/repository'
  if (gitflow)
    snapshot.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: '',
      },
      signature: 'fixture-config',
      configured: false,
      ready: false,
      missing: [],
      error: '',
      writeError: '',
    }
  await page.addInitScript((state) => {
    const unavailable = async () => {
      throw new Error('Unexpected write in a read-only UI fixture')
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'git version 2.53.0',
        gitPath: 'test fixture',
        gitError: '',
      }),
      snapshot: async () => structuredClone(state),
      commit: async () => ({
        body: state.commits[0].subject,
        files: [{ path: 'README.md', status: 'M' }],
      }),
      diff: async () => ({
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n',
        truncated: false,
      }),
      chooseDirectory: async () => state.path,
      cancel: async () => {},
      openResource: async () => {},
      action: unavailable,
      create: unavailable,
      syncPlan: unavailable,
      gitflowPlan: unavailable,
      listDirectory: unavailable,
    }
  }, snapshot)
  await page.goto('/')
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await dialog.getByLabel('仓库路径', { exact: true }).fill(snapshot.path)
  await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}
