import { expect, test, type Page, type Locator } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'

async function readSystemFonts(dialog: Locator) {
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  const expand = dialog.getByRole('button', { name: '展开界面主字体列表', exact: true })
  await expand.click()
  const popup = dialog.getByRole('dialog', { name: '选择界面主字体', exact: true })
  if (await popup.isVisible())
    await popup.getByRole('combobox', { name: '搜索界面主字体', exact: true }).press('Escape')
}

async function openFonts(page: Page, group: 'ui' | 'code' = 'ui') {
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await dialog.getByRole('tab', { name: group === 'ui' ? '界面' : '编辑器', exact: true }).click()
  return dialog
}

test('界面字体与编辑器字体独立，字号边界不改变图谱坐标，重载保留且恢复默认互不干扰', async ({
  page,
}) => {
  await openFixtureRepository(page)
  await page.locator('.file-main').first().click()
  const line = page
    .locator('.diff-line')
    .filter({ has: page.locator('code') })
    .first()
  await expect(line).toBeVisible()
  const before = await line.evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    size: getComputedStyle(el).fontSize,
    height: getComputedStyle(el).lineHeight,
  }))
  const rows = await page
    .locator('.commit-row')
    .evaluateAll((rows) => rows.map((el) => el.getBoundingClientRect().height))
  const dialog = await openFonts(page)
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  await dialog.getByRole('combobox', { name: '界面主字体', exact: true }).fill('Inter')
  await dialog.getByLabel('界面字号', { exact: true }).fill('16')
  await expect(page.locator('.commit-row').first()).toHaveCSS('height', '30px')
  expect(
    await page
      .locator('.commit-row')
      .evaluateAll((rows) => rows.map((el) => el.getBoundingClientRect().height)),
  ).toEqual(rows)
  const alignment = await page.locator('.commit-row').evaluateAll((rows) =>
    rows.map((row) => {
      const node = document.querySelector(
        `[data-node-hash="${(row as HTMLElement).dataset.commitHash}"] circle`,
      )
      if (!node) throw new Error('Visible commit must have a graph node')
      const a = row.getBoundingClientRect(),
        b = node.getBoundingClientRect()
      return Math.abs(a.y + a.height / 2 - b.y - b.height / 2)
    }),
  )
  expect(Math.max(...alignment)).toBeLessThanOrEqual(0.5)
  expect(
    await line.evaluate((el) => ({
      font: getComputedStyle(el).fontFamily,
      size: getComputedStyle(el).fontSize,
      height: getComputedStyle(el).lineHeight,
    })),
  ).toEqual(before)
  await dialog.getByRole('tab', { name: '编辑器', exact: true }).click()
  await dialog.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await dialog.getByLabel('编辑器字号', { exact: true }).fill('20')
  await dialog.getByLabel('编辑器行高', { exact: true }).fill('2')
  await dialog.getByLabel('编辑器行高', { exact: true }).blur()
  await expect(line).toHaveCSS('font-size', '20px')
  await expect(line).toHaveCSS('line-height', '40px')
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await openFixtureRepository(page)
  const restored = await openFonts(page)
  await expect(restored.getByLabel('界面字号', { exact: true })).toHaveValue('16')
  await expect(restored.getByLabel('编辑器字号', { exact: true })).toHaveValue('20')
  await restored.getByRole('button', { name: '恢复界面字体默认值', exact: true }).click()
  await expect(restored.getByLabel('使用自定义界面字体', { exact: true })).not.toBeChecked()
  await expect(restored.getByLabel('使用自定义编辑器字体', { exact: true })).toBeChecked()
  await expect(restored.getByLabel('编辑器字号', { exact: true })).toHaveValue('20')
  await restored.getByRole('tab', { name: '编辑器', exact: true }).click()
  await restored.getByRole('button', { name: '恢复编辑器字体默认值', exact: true }).click()
  await expect(restored.getByLabel('使用自定义编辑器字体', { exact: true })).not.toBeChecked()
  await restored.getByRole('tab', { name: '界面', exact: true }).click()
  await restored.getByLabel('使用自定义界面字体', { exact: true }).check()
  await restored.getByLabel('界面字号', { exact: true }).fill('11')
  await expect(page.locator('.commit-row').first()).toHaveCSS('height', '30px')
  await expect(page.locator('.titlebar')).toHaveCSS('height', '38px')
})

test('系统字体读取失败可重试；缺失字体给出回退说明，非法名称和超范围字号不写入设置', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let calls = 0
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => {
        if (++calls === 1) throw new Error('permission denied')
        return [{ family: 'Consolas' }, { family: 'Microsoft YaHei' }]
      },
    })
  })
  await openFixtureRepository(page)
  const dialog = await openFonts(page)
  await readSystemFonts(dialog)
  await expect(
    dialog.getByText('系统字体暂不可用，可选择内置字体或输入名称。', { exact: true }),
  ).toBeVisible()
  await readSystemFonts(dialog)
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  const family = dialog.getByRole('combobox', { name: '界面主字体', exact: true })
  await family.fill('')
  await family.pressSequentially('Missing Font For Test')
  await family.blur()
  await expect(dialog.getByText(/读取的字体列表中未包含所选主字体/)).toBeVisible()
  await family.fill('bad; font')
  await family.blur()
  await expect(dialog.getByRole('alert')).toContainText('有效的字体名称')
  const size = dialog.getByLabel('界面字号', { exact: true })
  await size.fill('99')
  await size.blur()
  await expect(size).toHaveValue('13')
  await family.fill('Missing Font For Test')
  await family.blur()
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!))
  expect(saved.ui.family).toBe('Missing Font For Test')
  expect(saved.ui.size).toBe(13)
})

for (const reason of ['NotAllowedError', 'SecurityError', 'AbortError'] as const) {
  test(`浏览器字体读取 ${reason} 显示对应的处理方法`, async ({ page }) => {
    await page.addInitScript((name) => {
      let calls = 0
      Object.defineProperty(window, 'queryLocalFonts', {
        configurable: true,
        value: async () => {
          document.documentElement.dataset.fontReads = String(++calls)
          throw new DOMException('font access failure', name)
        },
      })
    }, reason)
    await openFixtureRepository(page)
    const dialog = await openFonts(page)
    await readSystemFonts(dialog)
    await expect(dialog.getByRole('status')).toContainText(
      reason === 'NotAllowedError'
        ? '未获准读取系统字体'
        : reason === 'SecurityError'
          ? '系统字体暂不可用'
          : '已取消读取系统字体',
    )
    await expect(dialog.getByRole('combobox', { name: '界面主字体', exact: true })).toBeEnabled()
    await readSystemFonts(dialog)
    await expect(page.locator('html')).toHaveAttribute(
      'data-font-reads',
      reason === 'NotAllowedError' ? '1' : '2',
    )
  })
}

for (const reason of ['unsupported', 'insecure', 'policy'] as const) {
  test(`浏览器字体读取不可用 ${reason} 静默使用内置列表，保留手动配置`, async ({ page }) => {
    await page.addInitScript((reason) => {
      Object.defineProperty(window, 'queryLocalFonts', {
        configurable: true,
        value: reason === 'unsupported' ? undefined : async () => [],
      })
      if (reason === 'insecure')
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
      if (reason === 'policy')
        Object.defineProperty(document, 'permissionsPolicy', {
          configurable: true,
          value: { allowsFeature: () => false },
        })
    }, reason)
    await openFixtureRepository(page)
    const dialog = await openFonts(page)
    await expect(dialog.getByRole('button', { name: '读取本机字体', exact: true })).toHaveCount(0)
    await expect(dialog.locator('.font-settings > .font-hint')).toHaveCount(0)
    await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
    await expect(dialog.getByRole('combobox', { name: '界面主字体', exact: true })).toBeEnabled()
  })
}

test('字体保存失败仍即时应用并明确提示，不显示保存成功', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gitcode.fonts') throw new DOMException('quota exceeded', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  const dialog = await openFonts(page)
  await dialog.getByLabel('使用自定义界面字体', { exact: true }).check()
  await dialog.getByLabel('界面字号', { exact: true }).fill('15')
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法保存设置')
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-font-delta')),
  ).toBe('2px')
  expect(await page.evaluate(() => localStorage.getItem('gitcode.fonts'))).toBeNull()
})

test('损坏的保存值不会注入样式或破坏设置；主题切换保留字体；窄窗大字号可访问恢复按钮', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'gitcode.fonts',
      JSON.stringify({
        ui: { enabled: true, family: 'bad; font', size: 1000 },
        code: { enabled: true, size: -10, lineHeight: 'bad' },
      }),
    )
  })
  await openFixtureRepository(page)
  const dialog = await openFonts(page)
  await expect(dialog.getByLabel('界面字号', { exact: true })).toHaveValue('13')
  await expect(dialog.getByRole('combobox', { name: '界面主字体', exact: true })).toHaveValue(
    'Cascadia Mono',
  )
  await dialog.getByLabel('界面字号', { exact: true }).fill('16')
  await dialog.getByLabel('界面字号', { exact: true }).blur()
  await dialog.getByRole('tab', { name: '外观', exact: true }).click()
  await dialog.getByLabel('主题', { exact: true }).selectOption('islands-light')
  await dialog.getByRole('tab', { name: '字体', exact: true }).click()
  await expect(dialog.getByLabel('界面字号', { exact: true })).toHaveValue('16')
  await page.setViewportSize({ width: 720, height: 600 })
  await dialog.getByRole('tab', { name: '编辑器', exact: true }).click()
  await dialog.getByRole('button', { name: '恢复编辑器字体默认值', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: '字体', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: '确定', exact: true })).toBeInViewport()
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720)
})

test('旧 code 配置保留：禁用时不显示误导预览，再启用和重载恢复个人行高，两组重置独立', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('gitcode.fonts'))
      localStorage.setItem(
        'gitcode.fonts',
        JSON.stringify({
          ui: { enabled: true, family: 'Inter', fallback: 'Noto Sans SC', size: 14 },
          code: {
            enabled: false,
            family: 'JetBrains Mono',
            fallback: 'Noto Sans SC',
            size: 18,
            lineHeight: 2.2,
            ligatures: true,
          },
        }),
      )
  })
  await openFixtureRepository(page)
  await page.locator('.file-main').first().click()
  const line = page
    .locator('.diff-line')
    .filter({ has: page.locator('code') })
    .first()
  await expect(line).toBeVisible()
  const defaults = await line.evaluate((el) => ({
    size: getComputedStyle(el).fontSize,
    line: getComputedStyle(el).lineHeight,
  }))
  expect(defaults).toEqual({ size: '12px', line: '21px' })
  let dialog = await openFonts(page, 'code')
  const preview = () => dialog.getByLabel('编辑器字体预览', { exact: true })
  const toggle = () => dialog.getByLabel('使用自定义编辑器字体', { exact: true })
  await expect(toggle()).not.toBeChecked()
  await expect(preview()).toHaveCount(0)
  await expect(
    dialog.getByText('当前沿用各区域默认显示。启用自定义编辑器字体后，可统一设置并预览。', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(dialog.getByLabel('编辑器行高', { exact: true })).toHaveValue('2.2')
  await toggle().check()
  await expect(line).toHaveCSS('font-size', '18px')
  await expect(line).toHaveCSS('line-height', '39.6px')
  await expect(preview()).toHaveCSS('font-size', '18px')
  await expect(preview()).toHaveCSS('line-height', '39.6px')
  await expect(preview()).toHaveCSS('font-variant-ligatures', 'normal')
  await toggle().uncheck()
  await expect(preview()).toHaveCount(0)
  await expect(line).toHaveCSS('font-size', defaults.size)
  await expect(line).toHaveCSS('line-height', defaults.line)
  await expect(dialog.getByLabel('界面字号', { exact: true })).toHaveValue('14')
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await openFixtureRepository(page)
  dialog = await openFonts(page, 'code')
  await expect(toggle()).not.toBeChecked()
  await expect(preview()).toHaveCount(0)
  await toggle().check()
  await expect(dialog.getByRole('combobox', { name: '编辑器主字体', exact: true })).toHaveValue(
    'JetBrains Mono',
  )
  await expect(dialog.getByLabel('编辑器字号', { exact: true })).toHaveValue('18')
  await expect(dialog.getByLabel('编辑器行高', { exact: true })).toHaveValue('2.2')
  await expect(dialog.getByLabel('启用编辑器连字', { exact: true })).toBeChecked()
  await expect(preview()).toHaveCSS('line-height', '39.6px')
  await dialog.getByRole('tab', { name: '编辑器', exact: true }).click()
  await dialog.getByRole('button', { name: '恢复编辑器字体默认值', exact: true }).click()
  await expect(preview()).toHaveCount(0)
  await expect(dialog.getByLabel('界面字号', { exact: true })).toHaveValue('14')
  await dialog.getByRole('tab', { name: '界面', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '界面主字体', exact: true })).toHaveValue(
    'Inter',
  )
  await dialog.getByRole('button', { name: '应用', exact: true }).click()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gitcode.fonts')!))
  expect(stored.code).toMatchObject({
    enabled: false,
    family: 'Cascadia Mono',
    size: 12,
    lineHeight: 1.75,
    ligatures: false,
  })
  expect(stored.editor).toBeUndefined()
})

test('编辑器配置覆盖历史文件与补丁正文，禁用时分别恢复原有默认', async ({ page }) => {
  await openFixtureRepository(page)
  for (const enabled of [true, false]) {
    const settings = await openFonts(page, 'code')
    await settings.getByLabel('使用自定义编辑器字体', { exact: true }).setChecked(enabled)
    if (enabled) {
      await settings
        .getByRole('combobox', { name: '编辑器主字体', exact: true })
        .fill('JetBrains Mono')
      await settings.getByLabel('编辑器字号', { exact: true }).fill('18')
      await settings.getByLabel('编辑器行高', { exact: true }).fill('2.2')
      await settings.getByLabel('编辑器行高', { exact: true }).blur()
    }
    await settings.getByRole('button', { name: '确定', exact: true }).click()
    for (const mode of ['history', 'patch']) {
      await page.locator('[data-commit-hash]').nth(2).click({ button: 'right' })
      await page
        .getByRole('menuitem', {
          name: mode === 'history' ? '在修订版中显示仓库' : '创建补丁…',
          exact: true,
        })
        .click()
      const dialog = page.getByRole('dialog', {
        name: mode === 'history' ? '在修订版中显示仓库' : '创建补丁',
        exact: true,
      })
      if (mode === 'history')
        await dialog.getByRole('button', { name: 'README.md', exact: true }).click()
      const content = dialog.locator(
        mode === 'history' ? '.commit-history-content' : '.commit-patch-preview',
      )
      await expect(content).toBeVisible()
      await expect(content).toHaveCSS('font-family', enabled ? /JetBrains Mono/ : /Cascadia Mono/)
      await expect(content).toHaveCSS('font-size', enabled ? '18px' : '12px')
      await expect(content).toHaveCSS('line-height', enabled ? '39.6px' : '21px')
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    }
  }
})

test('冲突三方正文跟随编辑器字体，标题保持界面字体，关闭后恢复统一编辑器默认', async ({ page }) => {
  const state = structuredClone(repositoryFixture)
  state.merge = {
    active: true,
    head: state.head,
    incoming: state.commits[2]!.hash,
    branch: 'main',
    signature: 'font-conflict',
    unsupported: false,
    staged: [],
    message: 'merge fixture',
    files: [
      {
        path: 'README.md',
        type: 'UU',
        stages: {
          '2': { mode: '100644', oid: state.head },
          '3': { mode: '100644', oid: state.commits[2]!.hash },
        },
      },
    ],
  }
  state.unstaged = [{ path: 'README.md', status: 'U' }]
  await openFixtureRepository(page, false, state)
  await page.evaluate((state) => {
    window.gitk!.mergeRead = async () => ({
      state: state.merge!,
      file: {
        path: 'README.md',
        token: 'font-conflict',
        branch: 'main',
        incoming: state.merge!.incoming,
        base: { exists: true, text: 'base\n', binary: false },
        ours: { exists: true, text: 'local 中文\n', binary: false },
        theirs: { exists: true, text: 'remote 中文\n', binary: false },
        working: '<<<<<<< HEAD\nlocal 中文\n=======\nremote 中文\n>>>>>>> topic\n',
        editable: true,
        supported: true,
      },
    })
  }, state)
  const message = page.getByLabel('合并提交说明', { exact: true })
  await expect(message).toHaveCSS('font-size', '12px')
  await page.locator('.conflict-file-name').click()
  const panes = page.locator('.merge-pane > pre, .merge-result-input > textarea')
  await expect(panes).toHaveCount(3)
  const title = page.locator('.merge-pane h3').first()
  const before = await title.evaluate((el) => ({
    size: getComputedStyle(el).fontSize,
    family: getComputedStyle(el).fontFamily,
  }))
  for (const pane of await panes.all()) {
    await expect(pane).toHaveCSS('font-size', '12px')
    await expect(pane).toHaveCSS('line-height', '21px')
  }
  const settings = await openFonts(page, 'code')
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await settings.getByRole('combobox', { name: '编辑器主字体', exact: true }).fill('JetBrains Mono')
  await settings.getByLabel('编辑器字号', { exact: true }).fill('18')
  await settings.getByLabel('编辑器行高', { exact: true }).fill('2.2')
  await settings.getByLabel('编辑器行高', { exact: true }).blur()
  for (const pane of await panes.all()) {
    await expect(pane).toHaveCSS('font-family', /JetBrains Mono/)
    await expect(pane).toHaveCSS('font-size', '18px')
    await expect(pane).toHaveCSS('line-height', '39.6px')
  }
  expect(
    await title.evaluate((el) => ({
      size: getComputedStyle(el).fontSize,
      family: getComputedStyle(el).fontFamily,
    })),
  ).toEqual(before)
  await settings.getByLabel('使用自定义编辑器字体', { exact: true }).uncheck()
  for (const pane of await panes.all()) {
    await expect(pane).toHaveCSS('font-family', /Cascadia Mono/)
    await expect(pane).toHaveCSS('font-size', '12px')
    await expect(pane).toHaveCSS('line-height', '21px')
  }
  await settings.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('button', { name: '返回冲突列表', exact: true }).click()
  await expect(message).toHaveCSS('font-size', '12px')
  const messageSettings = await openFonts(page, 'code')
  await messageSettings.getByLabel('使用自定义编辑器字体', { exact: true }).check()
  await messageSettings.getByRole('button', { name: '确定', exact: true }).click()
  await expect(message).toHaveCSS('font-size', '18px')
  await expect(message).toHaveCSS('font-family', /JetBrains Mono/)
})
