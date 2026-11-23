import { expect, test, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

const areas = {
  fileMenu: '[data-top-menu="file"]',
  editMenu: '[data-top-menu="edit"]',
  viewMenu: '[data-top-menu="view"]',
  brand: '.titlebar .brand-wordmark',
  repositoryTab: '.repo-tab.active .tab-select',
  repositoryName: '.repo-selector strong',
  navigationHeading: '.sidebar-heading > span',
  navigationBranch: '.branch-main .branch-name',
  changesHeading: '.inspector > .panel-header',
  changesGroup: '.staging-zone-title',
  changedFile: '.worktree-file-name',
  historyHeading: '.history-panel .panel-header',
  statusbar: '#operation-status',
}
async function readAreas(page: Page) {
  return page.evaluate(
    (areas) =>
      Object.fromEntries(
        Object.entries(areas).map(([name, selector]) => {
          const el = [...document.querySelectorAll(selector)].find(
            (el) => el.getClientRects().length,
          )
          if (!el) throw new Error(`Missing interface region: ${name}`)
          const style = getComputedStyle(el)
          return [name, { family: style.fontFamily, size: parseFloat(style.fontSize) }]
        }),
      ),
    areas,
  )
}
async function settings(page: Page, group: '界面' | '编辑器') {
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await dialog.getByRole('tab', { name: group, exact: true }).click()
  return dialog
}

test('界面字体覆盖菜单、导航、仓库、工作区变更和提交历史，编辑器修改不干扰任何界面区域', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.locator('.file-main').first().click()
  const code = page.locator('.diff-line code').first()
  await expect(code).toBeVisible()
  const original = await readAreas(page)
  const originalCode = await code.evaluate((el) => ({
    family: getComputedStyle(el).fontFamily,
    size: getComputedStyle(el).fontSize,
  }))
  let dialog = await settings(page, '界面')
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  await dialog.getByRole('combobox', { name: '界面主字体', exact: true }).fill('Roboto')
  await dialog.getByLabel('界面字号', { exact: true }).fill('16')
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  const updated = await readAreas(page)
  for (const [name, value] of Object.entries(updated)) {
    expect(value.family, name).toContain('Roboto')
    expect(value.size, `${name} follows UI size while preserving hierarchy`).toBe(
      original[name]!.size + 3,
    )
  }
  expect(
    await code.evaluate((el) => ({
      family: getComputedStyle(el).fontFamily,
      size: getComputedStyle(el).fontSize,
    })),
  ).toEqual(originalCode)
  dialog = await settings(page, '编辑器')
  await dialog.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await dialog.getByRole('combobox', { name: '编辑器主字体', exact: true }).fill('JetBrains Mono')
  await dialog.getByLabel('编辑器字号', { exact: true }).fill('20')
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(code).toHaveCSS('font-family', /JetBrains Mono/)
  await expect(code).toHaveCSS('font-size', '20px')
  expect(await readAreas(page)).toEqual(updated)
  for (const id of ['file', 'edit', 'view']) {
    await page.locator(`[data-top-menu="${id}"]`).click()
    const menu = page.locator('.application-dropdown')
    await expect(menu).toBeVisible()
    for (const item of await menu.getByRole('menuitem').all())
      await expect(item).toHaveCSS('font-family', /Roboto/)
    await page.keyboard.press('Escape')
  }
  await page.screenshot({ path: '.tmp/ui-font-scope.png' })
  dialog = await settings(page, '界面')
  await dialog.getByRole('button', { name: '恢复界面字体默认值', exact: true }).click()
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  expect(await readAreas(page)).toEqual(original)
  await expect(code).toHaveCSS('font-family', /JetBrains Mono/)
  await expect(code).toHaveCSS('font-size', '20px')
})

test('提交详情说明跟随编辑器，父提交等界面技术标签保持界面字体', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'gitcode.fonts',
      JSON.stringify({
        ui: { enabled: true, family: 'Roboto', fallback: 'Noto Sans SC', size: 16 },
        code: {
          enabled: true,
          family: 'JetBrains Mono',
          fallback: 'Noto Sans SC',
          size: 20,
          lineHeight: 1.75,
        },
      }),
    ),
  )
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.commit = async () => ({
      body: '提交标题\n\n这是提交说明正文 Commit description',
      files: [],
    })
  })
  await page.locator('.commit-row .commit-select').first().click()
  const body = page.locator('.commit-body')
  await expect(body).toBeVisible()
  await expect(body).toHaveCSS('font-family', /JetBrains Mono/)
  await expect(body).toHaveCSS('font-size', '20px')
  const hashes = page.locator('.parent-hashes code')
  await expect(hashes.first()).toBeVisible()
  await expect(hashes.first()).toHaveCSS('font-family', /Roboto/)
  await page.getByRole('button', { name: '新建标签页', exact: true }).click()
  const home = page.getByRole('main', { name: '新标签页', exact: true })
  await expect(home.getByRole('button', { name: '打开仓库', exact: true })).toHaveCSS(
    'font-family',
    /Roboto/,
  )
})
