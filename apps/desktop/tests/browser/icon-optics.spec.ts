import { expect, test } from '@playwright/test'
import fs from 'node:fs'

import { openFixtureRepository } from './repository-fixture'

const names = Object.keys(
  JSON.parse(fs.readFileSync('src/assets/icons/material-symbols/manifest.json', 'utf8')).mapping,
)

for (const ratio of [1, 1.25, 1.5, 2]) {
  test.describe(`icon optics at DPR ${ratio}`, () => {
    test.use({ deviceScaleFactor: ratio })
    test('all Google glyphs keep their geometry inside the viewBox at small sizes', async ({
      page,
    }) => {
      await openFixtureRepository(page)
      const measurements = await page.evaluate(async (names) => {
        const vuePath = '/node_modules/.vite/deps/vue.js'
        const iconPath = '/src/shared/ui/Icon.vue'
        const [{ createApp, h }, { default: Icon }] = await Promise.all([
          import(vuePath),
          import(iconPath),
        ])
        const host = document.createElement('div')
        host.style.cssText =
          'position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bg);padding:20px;display:grid;grid-template-columns:repeat(6,1fr);gap:12px'
        document.body.append(host)
        createApp({
          render: () =>
            names.map((name) =>
              h('div', { style: 'display:flex;align-items:center;gap:12px;min-height:80px' }, [
                name,
                ...[11, 12, 14, 16, 19, 24].map((size) => h(Icon, { name, size })),
              ]),
            ),
        }).mount(host)
        return [...host.querySelectorAll<SVGSVGElement>('svg')].map((svg) => {
          const path = svg.querySelector('path')!
          const box = path.getBBox()
          const style = getComputedStyle(svg)
          const stroke = style.stroke === 'none' ? 0 : parseFloat(style.strokeWidth)
          const view = svg.viewBox.baseVal
          const matrix = svg.getScreenCTM()!
          const sx = Math.hypot(matrix.a, matrix.b)
          const sy = Math.hypot(matrix.c, matrix.d)
          return {
            name: svg.dataset.icon,
            size: svg.getAttribute('width'),
            sx,
            sy,
            physicalStroke: stroke * sx * devicePixelRatio,
            painted: style.fill !== 'none' && box.width > 0 && box.height > 0,
            margin: Math.min(
              box.x - view.x - stroke / 2,
              box.y - view.y - stroke / 2,
              view.x + view.width - box.x - box.width - stroke / 2,
              view.y + view.height - box.y - box.height - stroke / 2,
            ),
          }
        })
      }, names)
      expect(measurements).toHaveLength(names.length * 6)
      for (const m of measurements) {
        expect(Math.abs(m.sx - m.sy), `${m.name} ${m.size}: distorted`).toBeLessThan(0.001)
        expect(m.painted, `${m.name} ${m.size}: missing filled geometry`).toBe(true)
        expect(m.margin, `${m.name} ${m.size}: clipped stroke`).toBeGreaterThanOrEqual(0)
      }
    })
  })
}

test('compact history fits visible columns and preserves complete reference icons', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.setViewportSize({ width: 1000, height: 720 })
  const scroll = page.locator('.history-scroll')
  expect(await scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  const visibleIcons = page.locator('.commit-row .ref-labels-content .ref-kind-icon:visible')
  const bounds = (await scroll.boundingBox())!
  const icons = await visibleIcons.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }),
  )
  expect(icons.length).toBeGreaterThan(1)
  for (const icon of icons) {
    expect(icon.left).toBeGreaterThanOrEqual(bounds.x)
    expect(icon.right).toBeLessThanOrEqual(bounds.x + bounds.width)
  }
  // Columns that genuinely exceed the pane still use horizontal scrolling.
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '显示作者', exact: true }).click()
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '显示时间', exact: true }).click()
  await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '显示提交 SHA', exact: true }).click()
  expect(await scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
})
