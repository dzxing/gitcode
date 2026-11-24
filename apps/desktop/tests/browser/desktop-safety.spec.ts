import { expect, test } from '@playwright/test'
import { openFixtureRepository, openRepositoryFallback } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

for (const theme of ['dark', 'light']) {
  test(`${theme} 桌面弹窗不模糊背景，设置透明而危险确认保持可辨识`, async ({ page }) => {
    await openFixtureRepository(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByLabel('主题', { exact: true }).selectOption(theme)
    const settingBackdrop = await settings.evaluate((el) => {
      const style = getComputedStyle(el, '::backdrop')
      return { background: style.backgroundColor, filter: style.backdropFilter }
    })
    expect(settingBackdrop).toEqual({ background: 'rgba(0, 0, 0, 0)', filter: 'none' })
    await settings.getByRole('button', { name: '确定', exact: true }).click()
    await openRepositoryFallback(page)
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    const normal = await open.evaluate((el) => {
      const style = getComputedStyle(el, '::backdrop')
      return {
        alpha: Number(style.backgroundColor.match(/, ([\d.]+)\)$/)?.[1]),
        filter: style.backdropFilter,
      }
    })
    expect(normal.filter).toBe('none')
    expect(normal.alpha).toBe(0)
    await page.keyboard.press('Escape')
    await page.getByLabel('提交说明', { exact: true }).fill('keep this draft')
    await page.keyboard.press('Control+F4')
    const confirm = page.getByRole('dialog', { name: '关闭这个仓库标签？', exact: true })
    await expect(confirm).toHaveClass(/dialog-confirmation/)
    const danger = await confirm.evaluate((el) => {
      const style = getComputedStyle(el, '::backdrop')
      return {
        alpha: Number(style.backgroundColor.match(/, ([\d.]+)\)$/)?.[1]),
        filter: style.backdropFilter,
      }
    })
    expect(danger.filter).toBe('none')
    expect(danger.alpha).toBeGreaterThan(normal.alpha)
    expect(danger.alpha).toBeLessThan(0.35)
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('提交说明', { exact: true })).toHaveValue('keep this draft')
  })
}

test('中文组合输入期间不提交、不关闭标签或打开菜单，结束后提交快捷键仍正常', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate((initial) => {
    const state = structuredClone(initial)
    state.path = '/test-fixtures/repository'
    Object.assign(window, { compositionActions: [] })
    window.gitcode!.action = async (_repo, request) => {
      ;(window as unknown as { compositionActions: string[] }).compositionActions.push(
        request.action,
      )
      return { outcome: 'succeeded', output: '', snapshot: state }
    }
  }, repositoryFixture)
  const input = page.getByLabel('提交说明', { exact: true })
  await input.fill('输入中文说明')
  const prevented = await input.evaluate((el) => {
    const keys = [
      { key: 'Enter', ctrlKey: true, isComposing: true },
      { key: 'Enter', ctrlKey: true, keyCode: 229 },
      { key: 'w', ctrlKey: true, isComposing: true },
      { key: ',', ctrlKey: true, isComposing: true },
      { key: 'F10', isComposing: true },
    ]
    return keys.map((options) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })
      el.dispatchEvent(event)
      return event.defaultPrevented
    })
  })
  expect(prevented).toEqual([false, false, false, false, false])
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => (window as unknown as { compositionActions: string[] }).compositionActions,
    ),
  ).toEqual([])
  await expect(input).toHaveValue('输入中文说明')
  await input.press('Control+Enter')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { compositionActions: string[] }).compositionActions,
      ),
    )
    .toEqual(['commit'])
})
