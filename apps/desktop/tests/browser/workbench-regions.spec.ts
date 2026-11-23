import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

for (const width of [720, 1280]) {
  for (const palette of ['dark', 'islands-light']) {
    test(`长名称和多分支保持状态栏、工具菜单与 Windows 标题栏可用 ${width}/${palette}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.addInitScript((theme) => {
        localStorage.setItem('gitcode.theme', theme)
        window.gitkWindow = {
          nativeControls: true,
          minimize: async () => {},
          toggleMaximize: async () => {},
          close: async () => {},
          isMaximized: async () => false,
          isFullscreen: async () => false,
          isFocused: async () => true,
          onResized: async () => () => {},
          onFocusChanged: async () => () => {},
        }
      }, palette)
      const state = structuredClone(repositoryFixture)
      state.name = 'GitCode-' + 'long-project-'.repeat(20)
      state.branch = 'feature/' + 'long-branch-'.repeat(25)
      const current = state.branches.find((branch) => branch.kind === 'local' && branch.current)!
      current.name = state.branch
      for (let i = 0; i < 80; i++)
        state.branches.push({ ...current, name: `feature/test-${i}`, current: false })
      await openFixtureRepository(page, false, state)
      const status = page.locator('.status-branch')
      await status.hover()
      await expect(status).toHaveAttribute('title', state.branch)
      const dimensions = await page.evaluate(() => {
        const footer = document.querySelector('.statusbar')!
        const left = footer.querySelector('.statusbar-primary')!,
          right = footer.querySelector('.statusbar-secondary')!
        const branch = footer.querySelector('.status-branch')!
        const help = document.querySelector('.titlebar-right')!.getBoundingClientRect()
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          left: left.getBoundingClientRect().right,
          right: right.getBoundingClientRect().left,
          leftOverflow: left.scrollWidth > left.clientWidth + 1,
          rightOverflow: right.scrollWidth > right.clientWidth + 1,
          branchWidth: branch.clientWidth,
          branchContent: (branch.querySelector('span') || branch).scrollWidth,
          titleRight: help.right,
        }
      })
      expect(dimensions.document).toBeLessThanOrEqual(width)
      expect(dimensions.left).toBeLessThan(dimensions.right)
      expect(dimensions.leftOverflow).toBe(false)
      expect(dimensions.rightOverflow).toBe(false)
      expect(dimensions.branchWidth).toBeLessThan(dimensions.branchContent)
      expect(dimensions.titleRight).toBeLessThanOrEqual(width - 144)
      const trigger = page.locator('.branch-selector summary')
      await trigger.click()
      const popup = page.locator('.branch-dropdown')
      const box = await popup.boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(800)
      await popup.getByRole('button', { name: state.branch, exact: true }).hover()
      await expect(popup.getByRole('button', { name: state.branch, exact: true })).toHaveAttribute(
        'title',
        state.branch,
      )
      const last = popup.getByRole('button', { name: 'feature/test-79', exact: true })
      await last.scrollIntoViewIfNeeded()
      await expect(last).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await expect(popup).not.toBeVisible()
      await page.screenshot({ path: `design/region-audit/after-${width}-${palette}.png` })
    })
  }
}

test('侧栏筛选快捷键不劫持文本输入，同步菜单关闭后恢复焦点且失焦收起', async ({ page }) => {
  await openFixtureRepository(page)
  await page.getByRole('button', { name: 'GitCode 首页', exact: true }).focus()
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: '筛选分支', exact: true })).toBeFocused()
  const message = page.getByRole('textbox', { name: '提交说明', exact: true })
  await message.fill('feature')
  await message.press('End')
  await page.keyboard.type('/task')
  await expect(message).toHaveValue('feature/task')
  await expect(message).toBeFocused()
  await page.getByLabel('同步选项', { exact: true }).click()
  await page.getByRole('button', { name: '仅快进拉取', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('同步选项', { exact: true })).toBeFocused()
  await expect(page.locator('.sync-options')).not.toHaveAttribute('open')
  await page.getByLabel('同步选项', { exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('.sync-options')).not.toHaveAttribute('open')
  await page.locator('.branch-selector summary').click()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('.branch-selector')).not.toHaveAttribute('open')
})
