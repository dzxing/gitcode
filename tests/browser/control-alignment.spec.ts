import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const scale of [1, 1.25, 1.5, 2]) {
  test.describe(`control alignment at ${scale}`, () => {
    test.use({ deviceScaleFactor: scale })
    for (const palette of ['dark', 'islands-light']) {
      test(`${palette}: toolbar label baselines and row centers remain aligned`, async ({
        page,
      }) => {
        await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), palette)
        await openFixtureRepository(page)
        await page.evaluate(() => document.fonts.ready)
        const toolbar = await page.locator('.toolbar-actions > button').evaluateAll((buttons) => {
          const center = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.y + r.height / 2
          }
          return buttons.map((button) => {
            const icon = button.querySelector('.toolbar-action-icon')!
            const svg = icon.querySelector('svg')!
            const label = button.querySelector(':scope > span:last-child')!
            const top = icon.getBoundingClientRect().top
            const bottom = label.getBoundingClientRect().bottom
            return {
              label: label.textContent,
              labelCenter: center(label),
              stackOffset: (top + bottom) / 2 - center(button),
              iconOffset: center(svg) - center(icon),
              slot: icon.getBoundingClientRect().height,
              lineHeight: getComputedStyle(label).lineHeight,
            }
          })
        })
        expect(toolbar).toHaveLength(6)
        expect(
          Math.max(...toolbar.map((row) => row.labelCenter)) -
            Math.min(...toolbar.map((row) => row.labelCenter)),
        ).toBeLessThanOrEqual(0.1)
        for (const row of toolbar) {
          expect(Math.abs(row.stackOffset), row.label!).toBeLessThanOrEqual(0.1)
          expect(Math.abs(row.iconOffset), row.label!).toBeLessThanOrEqual(0.1)
          expect(row.slot).toBe(20)
          expect(row.lineHeight).toBe('16px')
        }
        const offsets = await page.evaluate(() => {
          const rows = document.querySelectorAll(
            '.workspace-nav > button, .section-toggle, .branch-main, .statusbar > div',
          )
          return Array.from(rows).flatMap((row) => {
            const r = row.getBoundingClientRect(),
              style = getComputedStyle(row)
            const center =
              (r.top +
                parseFloat(style.paddingTop) +
                parseFloat(style.borderTopWidth) +
                r.bottom -
                parseFloat(style.paddingBottom) -
                parseFloat(style.borderBottomWidth)) /
              2
            return Array.from(row.children)
              .filter((child) => ['svg', 'SPAN', 'SMALL', 'BUTTON'].includes(child.tagName))
              .map((child) => {
                const b = child.getBoundingClientRect()
                return {
                  label: child.textContent?.slice(0, 20) || child.tagName,
                  height: b.height,
                  // Branch kind icons intentionally follow the text's optical center.
                  opticalOffset: child.matches('.branch-kind-icon') ? 1 : 0,
                  offset: b.top + b.height / 2 - center,
                }
              })
              .filter((child) => child.height > 0)
          })
        })
        for (const row of offsets)
          expect(Math.abs(row.offset - row.opticalOffset), row.label).toBeLessThanOrEqual(0.5)
        await page.getByRole('menuitem', { name: '视图 View', exact: true }).click()
        const menu = page.getByRole('menu', { name: '视图', exact: true })
        const menuOffsets = await menu.locator(':scope > button').evaluateAll((buttons) =>
          buttons.flatMap((button) => {
            const r = button.getBoundingClientRect()
            return Array.from(button.children).map((child) => {
              const b = child.getBoundingClientRect()
              return b.y + b.height / 2 - r.y - r.height / 2
            })
          }),
        )
        for (const offset of menuOffsets) expect(Math.abs(offset)).toBeLessThanOrEqual(0.5)
        if (scale === 1) {
          await page.keyboard.press('Escape')
          await page
            .locator('.toolbar')
            .screenshot({ path: `design/alignment-audit/after-toolbar-${palette}.png` })
        }
      })
    }
  })
}
