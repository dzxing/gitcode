import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const theme of ['dark', 'islands-light']) {
  test(`${theme}: Search menu moves focus from commit editor and exposes its full-history scope`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await openFixtureRepository(page)
    const editor = page.getByRole('textbox', { name: '提交说明', exact: true })
    await editor.fill('keep commit draft')
    await editor.focus()
    const input = page.getByRole('textbox', { name: '搜索提交', exact: true })
    const firstRow = page.locator('.commit-row').first()
    const rowTop = (await firstRow.boundingBox())!.y
    await expect(input).not.toBeFocused()
    await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
    await page.getByRole('menuitem', { name: /^搜索提交/ }).click()
    await expect(input).toBeFocused()
    await expect(page.getByRole('button', { name: '清除搜索', exact: true })).not.toBeVisible()
    await expect(page.locator('.commit-search-hint')).toHaveText('搜索本地已有的全部提交历史')
    expect((await firstRow.boundingBox())!.y).toBe(rowTop)
    await expect(page.locator('.commit-search')).toHaveCSS('outline-style', 'solid')
    await expect(page.locator('.commit-search')).toHaveCSS('outline-width', '2px')
    await expect(page.locator('.commit-search kbd')).toHaveText('Ctrl K')
    await input.fill('新增文件差异预览面板')
    await expect(page.locator('.commit-row')).toHaveCount(1)
    await expect(page.locator('.commit-subject')).toHaveText('feat: 新增文件差异预览面板')
    await editor.focus()
    await page.keyboard.press('Control+k')
    await expect(input).toBeFocused()
    expect(
      await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, '新增文件差异预览面板'.length])
    await page.keyboard.type('no-matching-commit-qa-456732')
    await expect(page.locator('.commit-row')).toHaveCount(0)
    await expect(page.getByText('没有匹配的提交', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(page.locator('.commit-row')).toHaveCount(16)
    await expect(page.getByRole('button', { name: '清除搜索', exact: true })).not.toBeVisible()
    await expect(editor).toHaveValue('keep commit draft')
  })
}
