import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import { measureThemeContrast } from './theme-audit-metrics'
const presets = createRequire(import.meta.url)('../../electron/theme-presets.json')
const states = [
  ...Object.keys(presets).map((id) => ({ id, theme: id, mode: presets[id].mode })),
  ...['dark', 'light'].map((mode) => ({ id: 'system-' + mode, theme: 'system', mode })),
]
for (const state of states)
  test(`${state.id}: 冲突列表、三方编辑器和首页样式审查`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: state.mode as 'dark' | 'light' })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), state.theme)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.merge = {
      active: true,
      head: snapshot.head,
      incoming: snapshot.commits[2]!.hash,
      branch: 'main',
      signature: 'theme-conflict',
      unsupported: false,
      staged: [],
      message: 'merge audit',
      files: [
        {
          path: 'README.md',
          type: 'UU',
          stages: {
            '2': { mode: '100644', oid: snapshot.head },
            '3': { mode: '100644', oid: snapshot.commits[2]!.hash },
          },
        },
      ],
    }
    snapshot.unstaged = [{ path: 'README.md', status: 'U' }]
    await openFixtureRepository(page, false, snapshot)
    await page.evaluate((state) => {
      window.gitcode!.mergeRead = async () => ({
        state: state.merge!,
        file: {
          path: 'README.md',
          token: 'theme-conflict',
          branch: 'main',
          incoming: state.merge!.incoming,
          base: { exists: true, text: 'base\n', binary: false },
          ours: { exists: true, text: 'local 中文\n', binary: false },
          theirs: { exists: true, text: 'remote 中文\n', binary: false },
          working: '<<<<<<< HEAD\nlocal 中文\n=======\nremote 中文\n>>>>>>> topic\n',
          editable: true,
          supported: true,
        },
      })
    }, snapshot)
    const dir = '.tmp/ui-theme-audit/' + state.id,
      report = JSON.parse(await readFile(dir + '/metrics.json', 'utf8'))
    await page
      .locator('.inspector')
      .screenshot({ path: dir + '/conflicts.png', animations: 'disabled' })
    report.images.conflicts = state.id + '/conflicts.png'
    await page.locator('.conflict-file-name').click()
    await expect(page.locator('.merge-pane')).toHaveCount(3)
    await page
      .locator('.merge-editor')
      .screenshot({ path: dir + '/merge-editor.png', animations: 'disabled' })
    report.images['merge-editor'] = state.id + '/merge-editor.png'
    report.moduleColors['merge-editor'] = await measureThemeContrast(page, {
      title: '.merge-editor-heading h2',
      help: '.merge-editor-warning',
      ours: '.merge-pane pre',
      working: '.merge-pane textarea',
      button: '.merge-editor .secondary-button',
    })
    for (const c of report.moduleColors['merge-editor'])
      if (!c.disabled) expect.soft(c.ratio, c.role).toBeGreaterThanOrEqual(4.5)
    await page.getByRole('button', { name: '返回冲突列表', exact: true }).click()
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    await page.screenshot({ path: dir + '/new-tab.png', animations: 'disabled' })
    report.images['new-tab'] = state.id + '/new-tab.png'
    report.moduleColors['new-tab'] = await measureThemeContrast(page, {
      heading: '.new-tab h1',
      description: '.new-tab-description',
      open: '.open-repo-button',
      hint: '.new-tab-tips p',
    })
    await writeFile(dir + '/metrics.json', JSON.stringify(report, null, 2))
  })
