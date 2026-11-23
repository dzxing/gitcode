import type { Page } from '@playwright/test'
import { repositoryFixture } from '../fixtures/repository'
import type { RuntimeInfo } from '../../src/types'

// Exercise the manual fallback when a system picker is unavailable.
export async function openRepositoryFallback(page: Page) {
  await page.evaluate(() => {
    window.gitk!.chooseDirectory = async () => {
      throw new Error('系统目录选择器不可用')
    }
  })
  await page.keyboard.press('Control+o')
}

// Test-only preload bridge. No fixture data is imported by the application.
export async function openFixtureRepository(
  page: Page,
  gitflow = false,
  initialSnapshot = repositoryFixture,
  restoreSession = false,
  runtime: RuntimeInfo = {
    platform: 'windows',
    gitAvailable: true,
    gitVersion: 'git version 2.53.0',
    gitPath: 'test fixture',
    gitError: '',
  },
) {
  const snapshot = structuredClone(initialSnapshot)
  if (!restoreSession)
    await page.addInitScript(() => localStorage.removeItem('gitcode.workspaceSession.v1'))
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
  await page.addInitScript(
    ({ state, runtime }) => {
      const unavailable = async () => {
        throw new Error('Unexpected write in a read-only UI fixture')
      }
      window.gitk = {
        runtime: async () => runtime,
        repositoryTrust: async (path: string) => ({
          path,
          gitDir: path + '/.git',
          trusted: true,
          token: '',
        }),
        snapshot: async () => structuredClone(state),
        commitOperationRead: async (_repo, request) => {
          const commit = state.commits.find((c) => c.hash === request.oids[0])!
          if (request.kind === 'relations')
            return {
              parents: commit.parents,
              children: state.commits
                .filter((c) => c.parents.includes(commit.hash))
                .map((c) => c.hash),
            }
          if (request.kind === 'browse')
            return {
              entries: [{ mode: '100644', type: 'blob', oid: commit.hash, path: 'README.md' }],
            }
          if (request.kind === 'blob') return { content: '# historical fixture\n' }
          if (request.kind === 'patch')
            return { content: 'From fixture\nSubject: [PATCH] fixture\n' }
          if (request.kind === 'hosting') return { urls: [] }
          throw new Error('Read-only fixture confirms preflight was requested')
        },
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
    },
    { state: snapshot, runtime },
  )
  await page.goto('/')
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  await page.locator('.history-panel').waitFor({ state: 'visible' })
}
