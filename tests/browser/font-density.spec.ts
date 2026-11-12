import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const scale of [1.25, 1.5, 2]) {
  test.describe(`font density ${scale}`, () => {
    test.use({ deviceScaleFactor: scale })
    for (const size of [13, 16])
      for (const width of [720, 1280]) {
        test(`字号 ${size}，窗口 ${width}，文字留白和图谱对齐`, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 })
          await page.addInitScript(
            (size) =>
              localStorage.setItem(
                'gitcode.fonts',
                JSON.stringify({
                  ui: { enabled: true, family: 'Cascadia Mono', fallback: 'Microsoft YaHei', size },
                }),
              ),
            size,
          )
          await page.addInitScript(() => {
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
          })
          await openFixtureRepository(page)
          await page.evaluate(() => document.fonts.ready)
          const metrics = await page.evaluate(() => {
            const primary = document.querySelector('.statusbar-primary')!.getBoundingClientRect()
            const secondary = document
              .querySelector('.statusbar-secondary')!
              .getBoundingClientRect()
            const messages = Array.from(document.querySelectorAll<HTMLElement>('.commit-row')).map(
              (row) => {
                const circle = document.querySelector(
                  `[data-node-hash="${row.dataset.commitHash}"] circle`,
                )!
                const a = row.getBoundingClientRect(),
                  b = circle.getBoundingClientRect()
                const text = row.querySelector('.commit-subject')!,
                  c = text.getBoundingClientRect()
                return {
                  offset: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
                  height: a.height,
                  textHeight: c.height,
                  line: parseFloat(getComputedStyle(text).lineHeight),
                  size: parseFloat(getComputedStyle(text).fontSize),
                }
              },
            )
            const header = document.querySelector('.table-head')!.getBoundingClientRect()
            const title = document.querySelector('.titlebar-right')!.getBoundingClientRect()
            const labels = Array.from(
              document.querySelectorAll('.toolbar-actions > button > span:last-child'),
            ).map((el) => el.getBoundingClientRect())
            return {
              width: innerWidth,
              scroll: document.documentElement.scrollWidth,
              footerOverlap: primary.right > secondary.left,
              messages,
              headerFits: Array.from(document.querySelectorAll('.table-head > span')).every(
                (el) => {
                  const r = el.getBoundingClientRect()
                  return r.height === 0 || (r.top >= header.top && r.bottom <= header.bottom)
                },
              ),
              minLabelGap: Math.min(
                ...labels.slice(1).map((label, index) => label.left - labels[index].right),
              ),
              titleRight: title.right,
            }
          })
          expect(metrics.scroll).toBeLessThanOrEqual(metrics.width)
          expect(metrics.footerOverlap).toBe(false)
          expect(metrics.headerFits).toBe(true)
          // Allow Chromium’s 1/64 CSS-pixel layout rounding.
          expect(metrics.minLabelGap).toBeGreaterThanOrEqual(8 - 1 / 32)
          expect(metrics.titleRight).toBeLessThanOrEqual(metrics.width - 144)
          for (const row of metrics.messages) {
            expect(row.offset).toBeLessThanOrEqual(0.6)
            expect(row.textHeight).toBeLessThanOrEqual(row.height - 4)
            // Graph subjects keep a compact single line inside the fixed 30px row.
            expect(row.line / row.size).toBeCloseTo(1.2, 2)
          }
          await page.keyboard.press('Control+,')
          const settings = page.getByRole('dialog', { name: '设置', exact: true })
          await settings.getByRole('tab', { name: '字体', exact: true }).click()
          await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
          await settings.getByRole('button', { name: '恢复编辑器字体默认值', exact: true }).click()
          await expect(
            settings.getByRole('button', { name: '关闭设置', exact: true }),
          ).toBeInViewport()
        })
      }
  })
}
