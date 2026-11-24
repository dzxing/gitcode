import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const palette of ['dark', 'light', 'islands-dark', 'islands-light']) {
  for (const size of [13, 16]) {
    test(`${palette} ${size}px：按钮等宽、大字号不裁切，键盘焦点与按下不跳动`, async ({ page }) => {
      await page.setViewportSize({ width: 720, height: 600 })
      await page.addInitScript(
        ({ palette, size }) => {
          localStorage.setItem('gitcode.theme', palette)
          localStorage.setItem(
            'gitcode.fonts',
            JSON.stringify({
              ui: { enabled: true, family: 'Cascadia Mono', fallback: 'Microsoft YaHei', size },
            }),
          )
        },
        { palette, size },
      )
      await openFixtureRepository(page)
      await page.evaluate(() => {
        const info = {
          selection: { mode: 'auto' as const },
          runtime: {
            platform: 'windows',
            gitAvailable: false,
            gitVersion: '',
            gitPath: '',
            gitError: 'Git 未找到',
          },
        }
        window.gitcode!.gitSettings = async () => info
        window.gitcode!.refreshGitRuntime = async () => info
      })
      const compact = page.locator('.sidebar-heading-actions .icon-button').first()
      await expect(compact).toHaveCSS('width', '24px')
      await expect(compact).toHaveCSS('height', '24px')
      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      const buttons = settings.locator('footer > button')
      const dimensions = await buttons.evaluateAll((elements) =>
        elements.map((el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el)
          return {
            width: r.width,
            height: r.height,
            left: r.left,
            right: r.right,
            top: r.top,
            font: s.fontSize,
            line: parseFloat(s.lineHeight),
            padding:
              parseFloat(s.paddingTop) +
              parseFloat(s.paddingBottom) +
              parseFloat(s.borderTopWidth) +
              parseFloat(s.borderBottomWidth),
            radius: s.borderRadius,
          }
        }),
      )
      expect(dimensions).toHaveLength(3)
      for (const b of dimensions) {
        expect(b.width).toBe(72)
        expect(b.height).toBe(size === 13 ? 28 : 32)
        expect(b.font).toBe(`${size}px`)
        expect(b.line + b.padding).toBeLessThanOrEqual(b.height + 0.1)
        expect(b.radius).toBe('4px')
      }
      expect(dimensions[1]!.left - dimensions[0]!.right).toBe(8)
      expect(dimensions[2]!.left - dimensions[1]!.right).toBe(8)
      const confirm = settings.getByRole('button', { name: '确定', exact: true })
      const apply = settings.getByRole('button', { name: '应用', exact: true })
      await expect(apply).toBeDisabled()
      await expect(settings.locator('.preferences-header .icon-button')).toHaveCSS('width', '28px')
      await expect(settings.locator('.preferences-header svg')).toHaveAttribute('width', '16')
      await confirm.focus()
      await page.keyboard.press('Tab')
      const cancel = settings.getByRole('button', { name: '取消', exact: true })
      await expect(cancel).toBeFocused()
      await expect(cancel).toHaveCSS('outline-width', '2px')
      await expect(cancel).toHaveCSS('outline-offset', '2px')
      const before = await confirm.boundingBox()
      await confirm.hover()
      await page.mouse.down()
      expect(await confirm.boundingBox()).toEqual(before)
      await expect(confirm).toHaveCSS('transform', 'none')
      await page.mouse.move(before!.x - 12, before!.y + 4)
      await page.mouse.up()
      await expect(settings).toBeVisible()
      await settings.getByRole('tab', { name: 'Git', exact: true }).click()
      const long = settings.getByRole('button', { name: '重新检测 Git', exact: true })
      const fit = await long.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          range = document.createRange()
        range.selectNodeContents(el)
        const text = range.getBoundingClientRect()
        return {
          width: r.width,
          left: text.left - r.left,
          right: r.right - text.right,
          overflow: el.scrollWidth > el.clientWidth,
        }
      })
      expect(fit.width).toBeGreaterThan(72)
      expect(fit.left).toBeGreaterThanOrEqual(12)
      expect(fit.right).toBeGreaterThanOrEqual(12)
      expect(fit.overflow).toBe(false)
      for (const button of await buttons.all()) await expect(button).toBeInViewport({ ratio: 1 })
      if (size === 13) await settings.screenshot({ path: `.tmp/buttons-${palette}.png` })
    })
  }
}
