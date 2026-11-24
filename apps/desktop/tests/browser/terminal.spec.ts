import { test, expect, type Page } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import type { TerminalRequest } from '../../src/terminalTypes'

async function fixture(page: Page) {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const sessions = new Map<string, { output: string; repo: string }>()
    let next = 0
    const events: TerminalRequest[] = []
    Object.assign(window, { terminalEvents: events })
    window.gitcode!.gitConsole = async () => ({
      epoch: 'test-console',
      cursor: 0,
      entries: [],
      running: [],
      more: false,
      reset: false,
      dropped: false,
    })
    window.gitcode!.terminal = async (repo, request) => {
      events.push(request)
      if (request.action === 'shells') return { shells: [{ id: 'default', label: 'Bash' }] }
      if (request.action === 'create') {
        const id = `terminal-${++next}`
        sessions.set(id, { output: `Session ${next}\r\n$ `, repo })
        return { id, shell: request.shell === 'powershell' ? 'PowerShell' : 'Bash' }
      }
      const session = sessions.get(request.id)
      if (!session || session.repo !== repo) throw Error('Unexpected terminal owner')
      if (request.action === 'close') {
        sessions.delete(request.id)
        return
      }
      if (request.action === 'read')
        return {
          data: session.output.slice(request.cursor),
          cursor: session.output.length,
          state: 'running',
          more: false,
        }
      if (request.action === 'write') session.output += request.data
      return undefined
    }
  })
}
async function events(page: Page, action: string) {
  return page.evaluate(
    (action) =>
      (window as unknown as { terminalEvents: TerminalRequest[] }).terminalEvents.filter(
        (event) => event.action === action,
      ),
    action,
  )
}

test('terminal hides without killing, reuses sessions and preserves Shell shortcut input', async ({
  page,
}) => {
  await fixture(page)
  const panel = page.getByRole('region', { name: '终端面板', exact: true })
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await page.locator('.terminal-screen textarea').press('Control+r')
  await expect.poll(async () => (await events(page, 'write')).length).toBeGreaterThan(0)
  expect(await events(page, 'create')).toHaveLength(1)
  await page.keyboard.press('Control+Backquote')
  await expect(panel).not.toBeVisible()
  expect(await events(page, 'close')).toHaveLength(0)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(panel).toBeVisible()
  expect(await events(page, 'create')).toHaveLength(1)
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(3)
  await panel.getByRole('button', { name: '关闭终端 2', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  expect(await events(page, 'close')).toHaveLength(1)
})

test('bulk terminal close asks once and cancellation keeps all sessions', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.getByRole('region', { name: '终端面板', exact: true })
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(3)
  await panel.getByRole('button', { name: '关闭当前仓库的所有终端', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '关闭终端', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(await events(page, 'close')).toHaveLength(0)
  await panel.getByRole('button', { name: '关闭当前仓库的所有终端', exact: true }).click()
  await dialog.getByRole('button', { name: '关闭终端', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Git 控制台面板', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Git 控制台', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await events(page, 'close')).toHaveLength(2)
})

test('closing a repository tab ends its terminal sessions', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  await expect(page.getByRole('region', { name: '终端面板', exact: true })).toBeVisible()
  await page.locator('.tab-close').click()
  await expect.poll(async () => (await events(page, 'close')).length).toBe(1)
  await expect(page.getByRole('region', { name: '终端面板', exact: true })).not.toBeVisible()
})

test('console and numbered terminals remain peers; switching never closes or recreates shells', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  const consoleTab = panel.getByRole('tab', { name: 'Git 控制台', exact: true })
  const first = panel.getByRole('tab', { name: /终端 1/ })
  await expect(consoleTab).toBeVisible()
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await consoleTab.click()
  await expect(first).toBeVisible()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('.terminal-screen')).not.toBeVisible()
  await first.click()
  await expect(panel.locator('.terminal-screen')).toBeVisible()
  expect(await events(page, 'create')).toHaveLength(1)
  expect(await events(page, 'close')).toHaveLength(0)
  await consoleTab.click()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab')).toHaveCount(4)
  await expect(panel.getByRole('tab', { name: /终端 3/ })).toHaveAttribute('aria-selected', 'true')
  await consoleTab.click()
  await panel.getByRole('button', { name: '关闭终端 2', exact: true }).click()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: /终端 3/ })).toBeVisible()
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  const fourth = panel.getByRole('tab', { name: /终端 4/ })
  await expect(fourth).toHaveAttribute('aria-selected', 'true')
  await fourth.press('Home')
  await expect(consoleTab).toBeFocused()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await consoleTab.press('End')
  await expect(fourth).toHaveAttribute('aria-selected', 'true')
  await expect(fourth).toBeFocused()
  expect(await events(page, 'create')).toHaveLength(4)
  expect(await events(page, 'close')).toHaveLength(1)
})

test('whole tab surface selects and hovers; close remains an independent target', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  const consoleTab = panel.getByRole('tab', { name: 'Git 控制台', exact: true })
  const first = panel.getByRole('tab', { name: /终端 1/ })
  const firstBox = await first.locator('..').boundingBox()
  if (!firstBox) throw Error('Terminal tab missing')
  for (const [x, y] of [
    [firstBox.x + firstBox.width / 2, firstBox.y + 1],
    [firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height - 1],
    [firstBox.x + 1, firstBox.y + firstBox.height / 2],
    [firstBox.x + firstBox.width - 1, firstBox.y + firstBox.height / 2],
  ]) {
    await consoleTab.click()
    await page.mouse.click(x, y)
    await expect(first).toHaveAttribute('aria-selected', 'true')
  }
  await consoleTab.click()
  await page.mouse.move(firstBox.x + firstBox.width - 1, firstBox.y + firstBox.height / 2)
  await expect.poll(() => first.evaluate((button) => button.matches(':hover'))).toBe(true)
  const consoleBox = await consoleTab.locator('..').boundingBox()
  if (!consoleBox) throw Error('Console tab missing')
  await first.click()
  await page.mouse.click(consoleBox.x + consoleBox.width / 2, consoleBox.y + consoleBox.height - 1)
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  expect(await events(page, 'close')).toHaveLength(0)
  await panel.getByRole('button', { name: '关闭终端 1', exact: true }).click()
  await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: /终端 2/ })).toBeVisible()
  expect(await events(page, 'close')).toHaveLength(1)
  const height = await panel.evaluate((node) => node.getBoundingClientRect().height)
  const handle = await panel.getByRole('separator', { name: '调整工具窗口高度' }).boundingBox()
  if (!handle) throw Error('Resize handle missing')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 30)
  await page.mouse.up()
  await expect
    .poll(() => panel.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(height + 20)
})

test('shell uses fixed monospace metrics while tabs and Git Console follow their own font settings', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  const rows = panel.locator('.terminal-session-view:visible .xterm-rows')
  const shellFont = async () => {
    await expect(rows).toHaveCSS('font-family', /Cascadia Mono/)
    await expect(rows).toHaveCSS('font-size', '13px')
  }
  await shellFont()
  const initialHeight = await rows
    .locator(':scope > div')
    .first()
    .evaluate((e) => e.getBoundingClientRect().height)
  async function code(patch: Record<string, unknown>) {
    await page.evaluate(async (patch) => {
      const name = '/src/stores/fonts.ts'
      ;(await import(name)).useFontStore().set('code', patch, false)
    }, patch)
  }
  await code({ enabled: true, family: 'JetBrains Mono', size: 24, lineHeight: 2.2 })
  await page.evaluate(async () => {
    const name = '/src/stores/fonts.ts'
    ;(await import(name))
      .useFontStore()
      .set('ui', { enabled: true, family: 'Roboto', size: 16 }, false)
  })
  await expect(panel.getByRole('tab').first()).toHaveCSS('font-family', /Roboto/)
  await shellFont()
  await expect
    .poll(() =>
      rows
        .locator(':scope > div')
        .first()
        .evaluate((e) => e.getBoundingClientRect().height),
    )
    .toBe(initialHeight)
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(panel.getByRole('tab', { name: /终端 2/ })).toHaveAttribute('aria-selected', 'true')
  await shellFont()
  await panel.getByRole('tab', { name: 'Git 控制台', exact: true }).click()
  const output = panel.locator('.git-console-output')
  await expect(output).toHaveCSS('font-family', /JetBrains Mono/)
  await expect(output).toHaveCSS('font-size', '24px')
  await code({ family: 'Fira Code', size: 16, lineHeight: 1.5 })
  await expect(output).toHaveCSS('font-family', /Fira Code/)
  await expect(output).toHaveCSS('font-size', '16px')
  await expect(output).toHaveCSS('line-height', '24px')
  await page.locator('[data-top-menu="file"]').focus()
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '字体', exact: true }).click()
  await settings.getByRole('tab', { name: '编辑器', exact: true }).click()
  await settings.getByLabel('编辑器字号', { exact: true }).fill('20')
  await settings.getByLabel('编辑器字号', { exact: true }).blur()
  await expect(output).toHaveCSS('font-size', '20px')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await expect(output).toHaveCSS('font-size', '16px')
  await code({ enabled: false })
  await expect(output).toHaveCSS('font-size', '12px')
  await panel.getByRole('tab', { name: /终端 1/ }).click()
  await shellFont()
  await expect
    .poll(() =>
      rows
        .locator(':scope > div')
        .first()
        .evaluate((e) => e.getBoundingClientRect().height),
    )
    .toBe(initialHeight)
  expect(await events(page, 'create')).toHaveLength(2)
  expect(await events(page, 'close')).toHaveLength(0)
  await expect.poll(async () => (await events(page, 'resize')).length).toBeGreaterThan(0)
})

test('cold bundled font loads before measuring shell cells and editor changes cannot override it', async ({
  page,
}) => {
  await fixture(page)
  let unblock!: () => void, requested!: () => void
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const request = new Promise<void>((resolve) => {
    requested = resolve
  })
  await page.route('**/CascadiaMono.woff2?terminal-cold-test', async (route) => {
    requested()
    await gate
    await route.continue()
  })
  await page.evaluate(() => {
    for (const face of document.fonts)
      if (face.family.replaceAll('"', '') === 'Cascadia Mono') document.fonts.delete(face)
    document.fonts.add(
      new FontFace('Cascadia Mono', 'url("/fonts/CascadiaMono.woff2?terminal-cold-test")', {
        weight: '200 700',
      }),
    )
  })
  try {
    await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
    await request
    await page.evaluate(async () => {
      const name = '/src/stores/fonts.ts'
      ;(await import(name))
        .useFontStore()
        .set('code', { enabled: true, family: 'Roboto', size: 24, lineHeight: 2.2 }, false)
    })
  } finally {
    unblock()
  }
  const rows = page.locator('.terminal-session-view:visible .xterm-rows')
  await expect(rows).toHaveCSS('font-family', /Cascadia Mono/)
  await expect(rows).toHaveCSS('font-size', '13px')
  await expect.poll(async () => (await events(page, 'resize')).length).toBeGreaterThan(0)
  const resizes = await events(page, 'resize')
  const last = resizes.at(-1)!
  if (last.action !== 'resize') throw Error('Missing resize')
  const cell = await rows.evaluate((element, cols) => {
    const c = document.createElement('canvas').getContext('2d')!
    c.font = '13px "Cascadia Mono"'
    return {
      rendered: element.getBoundingClientRect().width / cols,
      expected: c.measureText('W').width,
      loaded: document.fonts.check('13px "Cascadia Mono"'),
    }
  }, last.cols)
  expect(cell.loaded).toBe(true)
  expect(Math.abs(cell.rendered - cell.expected)).toBeLessThan(0.15)
  expect(await events(page, 'create')).toHaveLength(1)
  expect(await events(page, 'close')).toHaveLength(0)
})

test('compact shell tabs align all targets and the new-session menu selects a shell only for that session', async ({
  page,
}) => {
  await fixture(page)
  await page.getByRole('button', { name: '显示或隐藏终端', exact: true }).click()
  const panel = page.locator('.terminal-workbench')
  const first = panel.getByRole('tab', { name: /终端 1/ })
  await expect(first.locator('.terminal-tab-label')).toHaveText('Bash 1')
  await expect(first.locator('small')).toHaveCount(0)
  await expect(panel.locator('select')).toHaveCount(0)
  await page.evaluate(async () => {
    const name = '/src/stores/terminal.ts'
    ;(await import(name)).useTerminalStore().shells = [
      { id: 'default', label: 'Bash' },
      { id: 'bash', label: 'Bash' },
      { id: 'powershell', label: 'PowerShell' },
    ]
  })
  const button = panel.getByRole('button', { name: '选择 Shell 新建终端', exact: true })
  const menu = page.getByRole('menu', { name: '新建终端类型', exact: true })
  await button.click()
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText([
    '新建默认终端',
    '新建 Bash',
    '新建 PowerShell',
  ])
  await button.click()
  await expect(menu).toHaveCount(0)
  await button.press('ArrowDown')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  await expect(menu).toHaveCount(0)
  await button.click()
  await menu.getByRole('menuitem', { name: '新建 PowerShell', exact: true }).click()
  await expect(
    panel.getByRole('tab', { name: /终端 2/ }).locator('.terminal-tab-label'),
  ).toHaveText('PowerShell 2')
  const chosen = await events(page, 'create')
  expect(chosen.at(-1)).toMatchObject({ shell: 'powershell' })
  await panel.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(
    panel.getByRole('tab', { name: /终端 3/ }).locator('.terminal-tab-label'),
  ).toHaveText('Bash 3')
  expect((await events(page, 'create')).at(-1)).not.toHaveProperty('shell')
  for (const size of [11, 13, 16]) {
    await page.evaluate(async (size) => {
      const name = '/src/stores/fonts.ts'
      ;(await import(name))
        .useFontStore()
        .set('ui', { enabled: true, family: 'Roboto', size }, false)
    }, size)
    const offsets = await panel
      .locator('.terminal-tab:not(.terminal-console-tab)')
      .evaluateAll((tabs) =>
        tabs.map((tab) => {
          const nodes = [
            tab.querySelector('[role=tab]'),
            tab.querySelector('[role=tab] svg'),
            tab.querySelector('.terminal-tab-label'),
            tab.querySelector('.icon-button'),
          ]
          const centers = nodes.map((node) => {
            const r = node!.getBoundingClientRect()
            return r.top + r.height / 2
          })
          return Math.max(...centers) - Math.min(...centers)
        }),
      )
    expect(Math.max(...offsets)).toBeLessThan(0.6)
  }
  await page.evaluate(async () => {
    const name = '/src/stores/terminal.ts',
      store = (await import(name)).useTerminalStore()
    store.sessions[1].shell = 'Very long shell name '.repeat(20)
    store.update(store.sessions[1].id, { state: 'exited', exitCode: 0 })
  })
  const long = panel.getByRole('tab', { name: /终端 2/ })
  await expect(long.locator('.terminal-tab-label')).toContainText('已退出')
  const geometry = await long.evaluate((tab) => {
    const label = tab.querySelector('.terminal-tab-label')!,
      close = tab.parentElement!.querySelector('.icon-button')!
    return {
      clipped: label.scrollWidth > label.clientWidth,
      overlap: label.getBoundingClientRect().right > close.getBoundingClientRect().left,
    }
  })
  expect(geometry).toEqual({ clipped: true, overlap: false })
  expect(await events(page, 'close')).toHaveLength(0)
})
