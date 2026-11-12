import { openFixtureRepository } from './repository-fixture.ts'
import { expect, test } from '@playwright/test'

test('notices align the first line and close control without width jumps or Inspector overlap', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await expect(page.locator('.workbench')).toBeVisible()
  const notify = async (reset = false) =>
    page.evaluate(async (reset) => {
      const modulePath = '/src/stores/repository.ts'
      const store = (await import(modulePath)).useRepositoryStore()
      if (reset) {
        store.notices = []
        store.notify('已取消暂存')
      } else
        store.notify(
          '操作未完成，请刷新后重试。\n' + '很长的仓库路径与 Git 错误说明/'.repeat(18),
          true,
        )
    }, reset)
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 900, height: 700 },
    { width: 1100, height: 600 },
  ]) {
    await page.setViewportSize(viewport)
    if (viewport.width === 1100)
      await page.locator('.app-shell').evaluate((e) => {
        e.style.setProperty('--sidebar-width', '330px')
        e.style.setProperty('--inspector-width', '540px')
      })
    await notify(true)
    await expect(page.locator('.toast')).toHaveCount(1)
    const initial = await page.locator('.toast').boundingBox()
    await notify()
    await expect(page.locator('.toast')).toHaveCount(2)
    const geometry = await page.locator('.toast-stack').evaluate((stack) => {
      const inspector = document.querySelector('.inspector').getBoundingClientRect()
      return [...stack.querySelectorAll('.toast')].map((e) => {
        const r = e.getBoundingClientRect(),
          icon = e.querySelector(':scope > svg').getBoundingClientRect()
        const text = e.querySelector(':scope > .toast-content'),
          textBox = text.getBoundingClientRect(),
          style = getComputedStyle(text)
        const close = e.querySelector('button').getBoundingClientRect()
        return {
          x: r.x,
          right: r.right,
          width: r.width,
          iconY: icon.y + icon.height / 2,
          closeY: close.y + close.height / 2,
          lineY: textBox.y + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2,
          narrow: textBox.y >= close.bottom,
          textX: textBox.x,
          iconX: icon.x,
          textTop: textBox.y,
          closeBottom: close.bottom,
          inspectorX: inspector.x,
        }
      })
    })
    for (const item of geometry) {
      expect(Math.abs(item.width - initial.width)).toBeLessThan(0.01)
      expect(Math.abs(item.iconY - item.closeY)).toBeLessThan(0.01)
      expect(item.right).toBeLessThanOrEqual(item.inspectorX - 24)
      if (!item.narrow) expect(Math.abs(item.lineY - item.closeY)).toBeLessThan(0.01)
      else {
        expect(item.textX).toBe(item.iconX)
        expect(item.textTop).toBeGreaterThanOrEqual(item.closeBottom)
      }
    }
    await page.getByRole('button', { name: '关闭提示', exact: true }).last().click()
    await expect(page.locator('.toast')).toHaveCount(1)
    expect((await page.locator('.toast').boundingBox()).width).toBe(initial.width)
  }
})
