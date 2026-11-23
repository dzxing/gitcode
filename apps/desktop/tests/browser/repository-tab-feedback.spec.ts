import { test, expect } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const theme of ['dark', 'light', 'islands-dark', 'islands-light']) {
  test(`repository tabs use full surface feedback and an independent close target: ${theme}`, async ({
    page,
  }, info) => {
    await page.addInitScript((theme) => localStorage.setItem('gitcode.theme', theme), theme)
    await openFixtureRepository(page)
    await page.getByRole('button', { name: '新建标签页', exact: true }).click()
    const tabs = page.locator('.repo-tab')
    const first = tabs.first(),
      select = first.locator('.tab-select'),
      second = tabs.nth(1).locator('.tab-select')
    const box = await first.boundingBox()
    if (!box) throw Error('Repository tab missing')
    await select.hover()
    await page.mouse.down()
    try {
      await expect(select).toHaveCSS('box-shadow', 'none')
      await expect(select).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await page.locator('.titlebar').screenshot({ path: info.outputPath(`pressed-${theme}.png`) })
    } finally {
      await page.mouse.up()
    }
    for (const [x, y] of [
      [box.x + 1, box.y + box.height / 2],
      [box.x + box.width - 2, box.y + box.height / 2],
      [box.x + box.width / 2, box.y + 1],
      [box.x + box.width / 2, box.y + box.height - 1],
    ]) {
      await second.click()
      await page.mouse.click(x, y)
      await expect(select).toHaveAttribute('aria-current', 'page')
      // Active decoration must also let presses reach the actual button.
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('button')?.classList.contains('tab-select'),
          { x, y },
        ),
      ).toBe(true)
    }
    await second.click()
    await first.locator('.tab-close').click()
    await expect(tabs).toHaveCount(1)
    await expect(page.getByRole('main', { name: '新标签页', exact: true })).toBeVisible()
  })
}
