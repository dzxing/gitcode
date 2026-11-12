import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { openFixtureRepository, openRepositoryFallback } from './repository-fixture'
import { measureThemeContrast } from './theme-audit-metrics'
import { repositoryFixture } from '../fixtures/repository'
const presets = createRequire(import.meta.url)('../../electron/theme-presets.json')
const states = [
  ...Object.keys(presets).map((id) => ({ id, theme: id, mode: presets[id].mode })),
  ...['dark', 'light'].map((mode) => ({ id: `system-${mode}`, theme: 'system', mode })),
]
const root = '.tmp/ui-theme-audit'
for (const state of states)
  test(`${state.id}: 模块截图、对齐和颜色审查`, async ({ page }) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: state.mode as 'dark' | 'light' })
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), state.theme)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: 'v',
      },
      signature: 'theme-audit',
      configured: true,
      ready: true,
      missing: [],
      error: '',
      writeError: '',
    }
    await openFixtureRepository(page, false, snapshot)
    await page.evaluate(() => {
      window.gitk!.commit = async () => ({
        body: 'feat: 优化仓库工作台的交互体验\n\n提交说明 Commit details\n核对字体、行距与边框层级。',
        files: [{ path: 'README.md', status: 'M' }],
      })
    })
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('html')).toHaveAttribute('data-theme', state.mode)
    await page.evaluate(() => {
      window.gitk!.operationLog = async () => ({
        records: [
          {
            id: 'audit-fetch',
            operation: 'fetch',
            repo: '/test-fixtures/repository',
            target: 'origin',
            background: false,
            startedAt: Date.parse('2026-11-11T08:00:00Z'),
            finishedAt: Date.parse('2026-11-11T08:00:01Z'),
            duration: 1000,
            state: 'succeeded',
            message: '已获取远端更新',
            output: 'Fetching origin',
            commands: 'git fetch --all --prune',
            truncated: false,
          },
        ],
        settings: { autoFetchInterval: 0, extended: false },
        storageError: '',
      })
    })
    const dir = `${root}/${state.id}`
    await mkdir(dir, { recursive: true })
    const images: Record<string, string> = {}
    const moduleColors: Record<string, Awaited<ReturnType<typeof measureThemeContrast>>> = {}
    const probes: Record<string, Record<string, string>> = {
      'file-menu': {
        item: '.application-dropdown > button',
        shortcut: '.application-dropdown kbd',
      },
      'view-menu': {
        item: '.application-dropdown > button',
        shortcut: '.application-dropdown kbd',
      },
      'branch-context': { item: '.context-menu-label' },
      settings: {
        title: '.preferences-dialog h2',
        intro: '.preferences-intro',
        hint: '.preferences-hint',
        saved: '.preferences-save-state',
        confirm: '.preferences-dialog footer .primary-button',
        description: '.theme-description',
      },
      'font-settings': {
        intro: '.font-intro',
        scope: '.font-controls > p',
        hint: '.font-hint',
        label: '.font-controls label',
      },
      gitflow: {
        title: '.gitflow-panel h2',
        paragraph: '.gitflow-panel p',
        location: '.gitflow-location',
        footer: '.gitflow-panel-footer',
        link: '.gitflow-panel-footer button',
      },
      'commit-details': {
        title: '.commit-detail h2',
        body: '.commit-body',
        date: '.detail-date',
        email: '.detail-author small',
      },
      diff: {
        added: '.diff-line.add code',
        removed: '.diff-line.remove code',
        lineNumber: '.line-number',
      },
      'open-repository': {
        title: 'dialog[open] h2',
        text: 'dialog[open] p',
        input: 'dialog[open] .form-input',
        primary: 'dialog[open] .primary-button',
        help: 'dialog[open] .form-help',
      },
    }
    const shot = async (name: string, selector?: string) => {
      const path = `${dir}/${name}.png`
      if (selector)
        await page.locator(selector).first().screenshot({ path, animations: 'disabled' })
      else await page.screenshot({ path, animations: 'disabled' })
      images[name] = `${state.id}/${name}.png`
      if (probes[name]) moduleColors[name] = await measureThemeContrast(page, probes[name])
    }
    // Dismiss the fixture's opening notification to keep module captures unobstructed.
    for (const notice of await page.getByRole('button', { name: '关闭提示', exact: true }).all())
      await notice.click()
    const layoutMetrics = await page.evaluate(() => {
      const alignment = [
        ...document.querySelectorAll<HTMLElement>(
          '.workspace-nav > button,.section-toggle,.branch-main',
        ),
      ]
        .filter((e) => e.getClientRects().length)
        .flatMap((e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e)
          const center =
            (r.top +
              parseFloat(s.paddingTop) +
              parseFloat(s.borderTopWidth) +
              r.bottom -
              parseFloat(s.paddingBottom) -
              parseFloat(s.borderBottomWidth)) /
            2
          return [...e.children]
            .filter((c) => ['svg', 'SPAN', 'SMALL', 'BUTTON'].includes(c.tagName))
            .map((c) => {
              const b = c.getBoundingClientRect()
              return {
                label: c.textContent?.trim().slice(0, 40) || c.tagName,
                offset: Math.round(Math.abs(b.y + b.height / 2 - center) * 100) / 100,
                height: b.height,
              }
            })
            .filter((c) => c.height > 0)
        })
      const actions = [
        ...document.querySelectorAll<HTMLElement>(
          '.section-head .section-action,.primary-button,.secondary-button,.commit-button',
        ),
      ]
        .filter((e) => e.getClientRects().length)
        .map((e) => ({ text: e.textContent?.trim(), overflow: e.scrollWidth > e.clientWidth + 1 }))
      return { alignment, actions }
    })
    const metrics = {
      ...layoutMetrics,
      colors: await measureThemeContrast(page, {
        menu: '[data-top-menu="file"]',
        navigation: '.branch-main .branch-name',
        currentBranch: '.branch-row.current .branch-name',
        history: '.commit-message',
        author: '.author-cell',
        file: '.worktree-file-name',
        status: '#operation-status',
        secondary: '.section-empty',
        submit: '.commit-button',
      }),
    }
    for (const item of metrics.alignment)
      expect.soft(item.offset, item.label).toBeLessThanOrEqual(0.6)
    for (const item of metrics.actions) expect.soft(item.overflow, item.text).toBe(false)
    await shot('workbench')
    for (const [name, selector] of Object.entries({
      titlebar: '.titlebar',
      toolbar: '.toolbar',
      navigation: '.sidebar',
      history: '.history-panel',
      changes: '.inspector',
      statusbar: '.statusbar',
    }))
      await shot(name, selector)
    await page.locator('.branch-main').first().hover()
    await shot('navigation-hover', '.sidebar')
    await page.getByLabel('同步选项', { exact: true }).click()
    await shot('sync-options', '.sync-options-menu')
    await page.keyboard.press('Escape')
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await shot('worktree-options', '.worktree-menu-content')
    await page.getByLabel('工作区视图选项', { exact: true }).click()
    await page.locator('[data-top-menu="file"]').click()
    await shot('file-menu', '.application-dropdown')
    await page.keyboard.press('Escape')
    await page.locator('[data-top-menu="view"]').click()
    await shot('view-menu', '.application-dropdown')
    await page.keyboard.press('Escape')
    await page
      .locator('[data-sidebar-section="local"] [data-branch-name="develop"] .branch-main')
      .click({ button: 'right' })
    await shot('branch-context', '.context-menu')
    await page.keyboard.press('Escape')
    await page.locator('.commit-row .commit-select').first().click({ button: 'right' })
    await shot('commit-context', '.context-menu')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await shot('settings', '.preferences-dialog')
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await shot('font-settings', '.preferences-dialog')
    await settings.getByLabel('使用自定义界面字体', { exact: true }).check()
    await settings.getByRole('button', { name: '展开界面主字体列表', exact: true }).click()
    await shot('font-picker', '.font-picker-popup')
    await page.keyboard.press('Escape')
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
    await shot('gitflow', '.gitflow-panel')
    await page
      .locator('.gitflow-panel')
      .getByRole('button', { name: '开始新分支…', exact: true })
      .first()
      .click()
    await shot('gitflow-start', '.gitflow-panel')
    await page.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
    await page.locator('.commit-row .commit-select').first().click()
    await expect(page.locator('.commit-body')).toBeVisible()
    await shot('commit-details', '.inspector')
    await page.getByRole('button', { name: '返回工作区', exact: true }).click()
    await page.locator('[data-top-menu="view"]').click()
    await page.getByRole('menuitem', { name: '活动日志', exact: true }).click()
    await expect(page.locator('.activity-log-row').first()).toBeVisible()
    await shot('activity-log', '.activity-log-dialog')
    await page.getByRole('button', { name: '关闭活动日志', exact: true }).click()
    await page.locator('.file-main').first().click()
    await expect(page.getByRole('region', { name: '文件差异', exact: true })).toBeVisible()
    await shot('diff', '.diff-panel')
    await page.getByRole('button', { name: '关闭差异预览', exact: true }).click()
    await openRepositoryFallback(page)
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill('/test-fixtures/repository')
    await open.getByRole('button', { name: '打开仓库', exact: true }).hover()
    await shot('open-repository', 'dialog[open]')
    await writeFile(
      `${dir}/metrics.json`,
      JSON.stringify({ state, images, metrics, moduleColors }, null, 2),
    )
  })
