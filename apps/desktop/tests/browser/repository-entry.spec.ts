import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { openFixtureRepository } from './repository-fixture'

const themes = createRequire(import.meta.url)('../../electron/theme-presets.json')
async function openEntry(page: Page, label: string) {
  await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

test('desktop Open goes straight to picker; cancellation stays quiet; errors retain path for retry', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const state = window as unknown as { picks: unknown[][] }
    state.picks = []
    window.gitcode!.chooseDirectory = async (...args) => {
      state.picks.push(args)
      return null
    }
  })
  await page.keyboard.press('Control+o')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { picks: unknown[][] }).picks.length))
    .toBe(1)
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.evaluate(() => {
    window.gitcode!.chooseDirectory = async () => '/not-a-repository'
    window.gitcode!.snapshot = async () => {
      throw new Error('所选目录不是 Git 仓库')
    }
  })
  await page.keyboard.press('Control+o')
  const dialog = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText('所选目录不是 Git 仓库')
  await expect(dialog.getByLabel('仓库路径', { exact: true })).toHaveValue('/not-a-repository')
  await dialog.getByLabel('仓库路径', { exact: true }).fill('/corrected')
  await expect(dialog.getByRole('alert')).not.toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => {
    window.gitcode!.chooseDirectory = async () => {
      throw new Error('系统选择器不可用')
    }
  })
  await page.keyboard.press('Control+o')
  await expect(dialog.getByRole('alert')).toHaveText('系统选择器不可用')
  await expect(dialog.getByRole('button', { name: '打开仓库', exact: true })).toBeEnabled()
})

test('clone suggests name after parent selection, respects edits and restores failed draft', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.chooseDirectory = async (_initial, purpose) => {
      if (purpose !== 'parent') throw new Error('wrong purpose')
      return '/projects'
    }
    window.gitcode!.create = async () => {
      throw new Error('目标目录已存在')
    }
  })
  await openEntry(page, '克隆仓库…')
  const dialog = page.getByRole('dialog', { name: '克隆仓库', exact: true })
  await dialog.getByRole('button', { name: '浏览…', exact: true }).click()
  await dialog.getByLabel('仓库地址', { exact: true }).fill('git@example.com:team/project.git')
  await expect(dialog.getByLabel('仓库名称', { exact: true })).toHaveValue('project')
  await expect(dialog.getByLabel('目标路径', { exact: true })).toHaveText('/projects/project')
  await dialog.getByLabel('仓库名称', { exact: true }).fill('personal-copy')
  await dialog.getByLabel('仓库地址', { exact: true }).fill('https://example.com/other.git')
  await expect(dialog.getByLabel('仓库名称', { exact: true })).toHaveValue('personal-copy')
  await dialog.getByRole('button', { name: '克隆并打开', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('目标目录已存在')
  await expect(dialog.getByLabel('目标路径', { exact: true })).toHaveText('/projects/personal-copy')
  await expect(dialog.getByLabel('仓库地址', { exact: true })).toHaveValue(
    'https://example.com/other.git',
  )
  await dialog.getByLabel('仓库名称', { exact: true }).fill('..')
  await dialog.getByRole('button', { name: '克隆并打开', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('不能是 . 或 ..')
  await dialog.getByLabel('仓库名称', { exact: true }).fill('retry-copy')
  await expect(dialog.getByRole('alert')).not.toBeVisible()
  await page.evaluate(() => {
    window.gitcode!.create = async (kind, path, url) => {
      ;(window as unknown as { creation: unknown[] }).creation = [kind, path, url]
      throw new Error('验证重试参数')
    }
  })
  await dialog.getByRole('button', { name: '克隆并打开', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { creation: unknown[] }).creation))
    .toEqual(['clone', '/projects/retry-copy', 'https://example.com/other.git'])
})

test('create uses parent and folder name; native picker errors keep manual input usable', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.chooseDirectory = async () => {
      throw new Error('选择目录失败')
    }
    window.gitcode!.create = async (kind, path) => {
      ;(window as unknown as { creation: unknown[] }).creation = [kind, path]
      throw new Error('创建失败')
    }
  })
  await openEntry(page, '新建本地仓库…')
  const dialog = page.getByRole('dialog', { name: '创建本地仓库', exact: true })
  await dialog.getByRole('button', { name: '浏览…', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('选择目录失败')
  await dialog.getByLabel('父目录', { exact: true }).fill('C:\\Projects')
  await dialog.getByLabel('仓库名称', { exact: true }).fill('my-project')
  await expect(dialog.getByLabel('目标路径', { exact: true })).toHaveText(
    'C:\\Projects\\my-project',
  )
  await dialog.getByRole('button', { name: '创建并打开', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('创建失败')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { creation: unknown[] }).creation))
    .toEqual(['init', 'C:\\Projects\\my-project'])
})

for (const theme of Object.keys(themes)) {
  test(`${theme}: desktop form keeps header/footer visible at enlarged font and short viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 320 })
    await page.addInitScript((theme) => {
      localStorage.setItem('gitcode.theme', theme)
      localStorage.setItem(
        'gitcode.fonts',
        JSON.stringify({
          ui: { enabled: true, family: 'Cascadia Mono', fallback: 'Noto Sans SC', size: 16 },
        }),
      )
    }, theme)
    await openFixtureRepository(page)
    await openEntry(page, '克隆仓库…')
    const dialog = page.getByRole('dialog', { name: '克隆仓库', exact: true })
    await dialog.getByLabel('仓库地址', { exact: true }).fill('https://example.com/repo.git')
    const metrics = await dialog.evaluate((el) => {
      const head = el.querySelector('header')!.getBoundingClientRect()
      const foot = el.querySelector('footer')!.getBoundingClientRect()
      const body = el.querySelector('.repository-entry-body')!
      const input = el.querySelector('input')!.getBoundingClientRect()
      return {
        head: head.top,
        foot: foot.bottom,
        viewport: innerHeight,
        input: input.height,
        scrolling: body.scrollHeight > body.clientHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(metrics.head).toBeGreaterThanOrEqual(38)
    expect(metrics.foot).toBeLessThanOrEqual(metrics.viewport)
    expect(metrics.input).toBeGreaterThanOrEqual(28)
    expect(metrics.input).toBeLessThanOrEqual(34)
    expect(metrics.scrolling).toBe(true)
    expect(metrics.overflow).toBe(false)
    await page.screenshot({ path: `.tmp/repository-entry-${theme}.png` })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).not.toBeVisible()
  })
}

test('macOS form orders Cancel before primary; Escape closes and returns focus', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { platform: 'macOS' },
    }),
  )
  await openFixtureRepository(page)
  await openEntry(page, '克隆仓库…')
  const dialog = page.getByRole('dialog', { name: '克隆仓库', exact: true })
  await expect(dialog.locator('footer button')).toHaveText(['取消', '克隆并打开'])
  await expect(dialog.getByLabel('仓库地址', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('menuitem', { name: '文件 File', exact: true })).toBeFocused()
})

test('compatibility directory browser selects parent without submitting or closing the form', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitcode!.listDirectory = async () => ({
      path: '/projects',
      parent: '/',
      home: '/home/test',
      root: '/',
      folders: [],
      truncated: false,
    })
  })
  await openEntry(page, '新建本地仓库…')
  const dialog = page.getByRole('dialog', { name: '创建本地仓库', exact: true })
  await dialog.getByText('更多选项', { exact: true }).click()
  await dialog.getByRole('button', { name: '使用内置目录浏览器…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择父目录', exact: true })
  await picker.getByRole('button', { name: '选择父目录', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('父目录', { exact: true })).toHaveValue('/projects')
  await expect(dialog.getByRole('button', { name: '创建并打开', exact: true })).toBeDisabled()
})
