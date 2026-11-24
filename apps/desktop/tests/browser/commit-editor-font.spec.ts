import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

for (const after of [false, true])
  test(`提交说明和分支标签跟随编辑器，24px 字号保持图线对齐（标签${after ? '右置' : '左置'}）`, async ({
    page,
  }) => {
    await page.addInitScript((after) => {
      localStorage.setItem('gitcode.graph-labels-after-message', String(after))
      localStorage.setItem('gitcode.theme', after ? 'islands-light' : 'dark')
      localStorage.setItem(
        'gitcode.fonts',
        JSON.stringify({
          ui: { enabled: true, family: 'Roboto', fallback: 'Noto Sans SC', size: 16 },
          code: {
            enabled: true,
            family: 'Fira Code',
            fallback: 'Noto Sans SC',
            size: 24,
            lineHeight: 2.2,
            ligatures: false,
          },
        }),
      )
    }, after)
    const snapshot = structuredClone(repositoryFixture)
    snapshot.branches.push({
      name: 'dev',
      hash: snapshot.head,
      current: false,
      upstream: '',
      track: '',
      kind: 'local',
    })
    await openFixtureRepository(page, false, snapshot)
    await page.evaluate(() => {
      window.gitcode!.commit = async () => ({ body: '提交标题\n\n提交详细说明', files: [] })
    })
    const content = page.locator('.commit-row .commit-message').first()
    const label = page.locator('.ref-tag .ref-primary').first()
    const input = page.getByLabel('提交说明', { exact: true })
    for (const el of [content, label, input]) {
      await expect(el).toHaveCSS('font-family', /Fira Code/)
      await expect(el).toHaveCSS('font-size', '24px')
    }
    await expect(page.locator('.branch-main .branch-name').first()).toHaveCSS(
      'font-family',
      /Roboto/,
    )
    await expect(page.locator('[data-top-menu="file"]')).toHaveCSS('font-family', /Roboto/)
    const geometry = await page
      .locator('.ref-tag')
      .first()
      .evaluate((el) => {
        const badge = el.getBoundingClientRect(),
          row = el.closest('.commit-row')!.getBoundingClientRect()
        return {
          height: badge.height,
          rowHeight: row.height,
          center: Math.abs(badge.y + badge.height / 2 - row.y - row.height / 2),
          line: parseFloat(getComputedStyle(el).lineHeight),
        }
      })
    expect(geometry.rowHeight).toBe(30)
    expect(geometry.center).toBeLessThan(0.6)
    expect(geometry.line + 2).toBeLessThanOrEqual(geometry.height)
    const more = page.locator(`[data-commit-hash="${snapshot.head}"] .ref-more`)
    await more.click()
    const popup = page.getByRole('dialog', { name: '提交引用', exact: true })
    await expect(popup.locator('.reference-popup-action > span').first()).toHaveCSS(
      'font-family',
      /Fira Code/,
    )
    await expect(popup.locator('.reference-popup-action > span').first()).toHaveCSS(
      'font-size',
      '24px',
    )
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await settings.getByLabel('界面字号', { exact: true }).fill('11')
    await settings.getByRole('button', { name: '确定', exact: true }).click()
    for (const el of [content, label, input]) await expect(el).toHaveCSS('font-size', '24px')
    await page.keyboard.press('Control+,')
    await settings.getByRole('tab', { name: '字体', exact: true }).click()
    await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
    await settings
      .getByRole('combobox', { name: '编辑器主字体', exact: true })
      .fill('JetBrains Mono')
    await settings.getByLabel('编辑器字号', { exact: true }).fill('20')
    await settings.getByRole('button', { name: '确定', exact: true }).click()
    for (const el of [content, label, input]) {
      await expect(el).toHaveCSS('font-size', '20px')
      await expect(el).toHaveCSS('font-family', /JetBrains Mono/)
    }
    await page.screenshot({ path: `.tmp/commit-editor-font-${after ? 'right' : 'left'}.png` })
    await page.locator('.commit-row .commit-select').first().click()
    await expect(page.locator('.commit-body')).toHaveCSS('font-family', /JetBrains Mono/)
    await expect(page.locator('.commit-body')).toHaveCSS('font-size', '20px')
    await expect(page.locator('.commit-detail h2')).toHaveCSS('font-size', '20px')
    await expect(page.locator('.parent-hashes code').first()).toHaveCSS('font-family', /Roboto/)
  })
