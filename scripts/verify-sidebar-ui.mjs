import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

const order = ['gitflow', 'local', 'remote', 'tag']
const hash = 'a'.repeat(40)
const config = {
  production: 'main',
  develop: 'develop',
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  versionTag: '',
}
const fixture = {
  remotes: ['origin'],
  path: '/ui-verification/gitcode',
  name: 'UI verification',
  head: hash,
  branch: 'main',
  staged: [],
  unstaged: [{ path: 'draft.txt', status: 'M' }],
  total: 1,
  commits: [
    {
      hash,
      parents: [],
      subject: 'UI verification fixture',
      author: 'Test',
      email: 'test@example.com',
      date: '2026-10-27T10:00:00Z',
      refs: ['HEAD -> main'],
    },
  ],
  branches: [
    ['local', 'feature/task10'],
    ['tag', 'v10'],
    ['local', 'main'],
    ['remote', 'origin/main'],
    ['local', 'feature/task2'],
    ['tag', 'v2'],
    ['local', 'develop'],
    ['remote', 'origin/develop'],
  ].map(([kind, name]) => ({
    kind,
    name,
    fullRef: `refs/${kind === 'local' ? 'heads' : kind === 'remote' ? 'remotes' : 'tags'}/${name}`,
    hash,
    commitHash: hash,
    current: kind === 'local' && name === 'main',
    upstream: kind === 'local' ? `origin/${name}` : '',
    track: '',
  })),
  gitflow: {
    config,
    signature: 'ui-fixture',
    ready: true,
    configured: true,
    missing: [],
    error: '',
    writeError: '',
  },
}

// Real renderer and layout, isolated mock repository: no filesystem Git writes.
export async function verifySidebar(page, { url, screenshotPath } = {}) {
  await page.addInitScript((state) => {
    const unavailable = async () => {
      throw new Error('This UI check must not mutate Git')
    }
    window.__uiGitWrites = 0
    window.__uiSyncPlans = []
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'git version 2.53.0',
        gitPath: 'UI fixture',
        gitError: '',
      }),
      snapshot: async () => structuredClone(state),
      commit: async () => ({ body: 'UI verification fixture', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      cancel: async () => {},
      openResource: async () => {},
      chooseDirectory: async () => state.path,
      action: async () => {
        window.__uiGitWrites++
        return unavailable()
      },
      create: unavailable,
      syncPlan: async (repo, kind, expected) => {
        if (kind !== 'push') return unavailable()
        window.__uiSyncPlans.push(structuredClone(expected))
        return {
          id: 'ui-selected-push',
          kind,
          head: expected.sourceOid,
          branch: expected.sourceRef.slice('refs/heads/'.length),
          worktreeBranch: expected.expectedBranch,
          sourceRef: expected.sourceRef,
          destinationRef: expected.sourceRef,
          expiresAt: Date.now() + 60000,
          remotes: [{ name: 'origin', address: 'UI fixture' }],
        }
      },
      gitflowPlan: unavailable,
      listDirectory: unavailable,
    }
  }, fixture)
  await page.goto(url || 'http://localhost:43187/')
  const sectionOrder = () =>
    page
      .locator('[data-sidebar-section]')
      .evaluateAll((elements) => elements.map((element) => element.dataset.sidebarSection))
  const openFixture = async () => {
    await page.keyboard.press('Control+o')
    const dialog = page.getByRole('dialog', { name: '打开本地仓库' })
    await dialog.getByLabel('仓库路径', { exact: true }).fill(fixture.path)
    await dialog.getByRole('button', { name: '打开仓库', exact: true }).click()
    await expect(
      page.locator('[data-sidebar-section="gitflow"] [data-flow-group="feature"]'),
    ).toBeVisible()
  }
  await openFixture()
  await expect.poll(sectionOrder).toEqual(order)
  const flowToggle = page.locator('[data-sidebar-section="gitflow"] .section-toggle')
  const flowAction = page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true })
  await flowToggle.locator('.section-title').click()
  await expect(flowToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.gitflow-panel')).toHaveCount(0)
  await flowAction.click()
  await expect(page.locator('.gitflow-panel')).toBeVisible()
  await expect(flowToggle).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
  await flowToggle.click()
  const chooser = page.locator('.branch-selector')
  const chooserTrigger = chooser.locator('summary')
  await chooserTrigger.click()
  await expect(chooser).toHaveAttribute('open', '')
  await expect
    .poll(() =>
      chooser.locator('.disclosure-chevron').evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        return Math.abs(matrix.a + 1) < 0.01 && Math.abs(matrix.d + 1) < 0.01
      }),
    )
    .toBe(true)
  await chooser.locator('.branch-dropdown button').first().focus()
  await page.keyboard.press('Escape')
  await expect(chooser).not.toHaveAttribute('open', '')
  await expect(chooserTrigger).toBeFocused()
  await chooserTrigger.click()
  await page.locator('.sidebar-heading').click()
  await expect(chooser).not.toHaveAttribute('open', '')
  await chooserTrigger.click()
  await page.getByRole('textbox', { name: '搜索提交', exact: true }).focus()
  await expect(chooser).not.toHaveAttribute('open', '')
  await expect(page.locator('.repo-selector')).toHaveAttribute('aria-haspopup', 'dialog')

  const refresh = page
    .locator('.toolbar-actions')
    .getByRole('button', { name: '刷新', exact: true })
  await page.evaluate(() => {
    const original = window.gitk.snapshot
    window.gitk.snapshot = () =>
      new Promise((resolve) => {
        window.__uiResumeSnapshot = async () => {
          window.gitk.snapshot = original
          resolve(await original())
        }
      })
  })
  await refresh.click()
  const fileAction = page.locator('.file-action').first()
  try {
    await expect(fileAction).toBeDisabled()
    await expect(flowToggle).toBeEnabled()
    await expect(flowAction).toBeDisabled()
    // Resolve the target token rather than sampling a color-transition frame.
    const disabledColor = await fileAction.evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.color = getComputedStyle(element).getPropertyValue('--control-disabled-color')
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await expect(fileAction).toHaveCSS('color', disabledColor)
    const disabledOpacity = await fileAction.evaluate(
      (element) => getComputedStyle(element).opacity,
    )
    await page.locator('.file-row').first().hover()
    await expect(fileAction).toHaveCSS('color', disabledColor)
    await expect(fileAction).toHaveCSS('opacity', disabledOpacity)
    await expect(refresh).toHaveCSS('color', disabledColor)
  } finally {
    await page.evaluate(() => window.__uiResumeSnapshot())
  }
  await expect(refresh).toBeEnabled()
  const checkDisclosure = async (button, content) => {
    const expandedHeight = (await content.boundingBox()).height
    assert.ok(expandedHeight > 0)
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(content).toHaveAttribute('inert', '')
    // Hidden branch actions must be excluded from keyboard focus during closing too.
    assert.equal(
      await content.evaluate((element) => {
        element.querySelector('button')?.focus()
        return element.contains(document.activeElement)
      }),
      false,
    )
    await expect.poll(async () => (await content.boundingBox())?.height || 0).toBeLessThan(1)
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(async () => Math.abs((await content.boundingBox()).height - expandedHeight))
      .toBeLessThan(1)
    // Reverse a transition before it finishes; no stale inline height may remain.
    await button.evaluate((element) => {
      element.click()
      element.click()
      element.click()
    })
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await content.boundingBox())?.height || 0).toBeLessThan(1)
    await button.click()
    await expect
      .poll(async () => Math.abs((await content.boundingBox()).height - expandedHeight))
      .toBeLessThan(1)
  }
  for (const id of order) {
    const button = page.locator(`[data-sidebar-section="${id}"] .section-toggle`)
    await checkDisclosure(button, page.locator(`#sidebar-group-${id}`))
  }
  await checkDisclosure(
    page.locator('[data-flow-group="feature"]'),
    page.locator('#sidebar-flow-feature'),
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#sidebar-group-local')).toHaveCSS('transition-duration', '0s')
  await expect(
    page.locator('[data-sidebar-section="local"] .section-toggle .disclosure-chevron'),
  ).toHaveCSS('transition-duration', '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const targetBranch = page.locator(
    '[data-sidebar-section="local"] [data-branch-name="feature/task2"] .branch-main',
  )
  const originalHead = await page.locator('.branch-selector summary strong').textContent()
  await expect(targetBranch).toHaveCSS('cursor', 'default')
  await expect(page.getByRole('textbox', { name: '搜索提交', exact: true })).toHaveCSS(
    'cursor',
    'text',
  )
  await expect(page.getByRole('separator', { name: '调整侧栏宽度' })).toHaveCSS(
    'cursor',
    'col-resize',
  )
  const commitButton = page.locator('.commit-button')
  await expect(commitButton).toBeDisabled()
  await expect(commitButton).toHaveCSS('cursor', 'default')
  await expect(page.locator('#commit-hint')).toContainText('先将需要提交的文件加入暂存区')
  await targetBranch.hover()
  const restingShadow = await targetBranch.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  )
  await page.mouse.down()
  try {
    await expect(targetBranch).not.toHaveCSS('box-shadow', restingShadow)
  } finally {
    await page.mouse.up()
  }
  // A real double-click includes both click events, but attempts checkout only once.
  await targetBranch.dblclick()
  await expect.poll(() => page.evaluate(() => window.__uiGitWrites)).toBe(1)
  await expect(page.getByRole('dialog', { name: '切换分支', exact: true })).toHaveCount(0)
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'true')
  // This read-only mock rejects the request; branch selection must remain unchanged.
  await expect(page.locator('.branch-selector summary strong')).toHaveText(originalHead)
  // Single-click can still clear the history filter after a double-click.
  await targetBranch.click()
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'false')
  // Duplicate GitFlow/local entries share a history filter, but only the clicked
  // navigation entry is selected. Moving between entries must retain the filter.
  const flowBranch = page.locator(
    '[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"] .branch-main',
  )
  await targetBranch.click()
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'true')
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'false')
  await flowBranch.click()
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'false')
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.history-panel .filter-banner')).toContainText('feature/task2')
  await flowBranch.click()
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.history-panel .filter-banner')).toHaveCount(0)
  await targetBranch.click()
  await flowBranch.click({ button: 'right' })
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('menuitem', { name: '筛选已加载历史', exact: true })).toHaveCount(0)
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  await flowBranch.click()
  await expect(targetBranch).toHaveAttribute('aria-pressed', 'false')
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'true')
  await page.locator('.filter-banner button').click()
  await expect(flowBranch).toHaveAttribute('aria-pressed', 'false')
  await targetBranch.click({ button: 'right' })
  const branchMenu = page.getByRole('menu')
  await expect(branchMenu).toHaveAccessibleName('feature/task2 右键菜单')
  await expect(branchMenu.getByRole('menuitem', { name: '拉取' })).toBeEnabled()
  await expect(branchMenu.getByRole('menuitem', { name: /^完成 feature\// })).toBeVisible()
  await branchMenu.getByRole('menuitem', { name: '推送', exact: true }).click()
  const pushDialog = page.getByRole('dialog', { name: '推送指定分支', exact: true })
  await expect(pushDialog).toBeVisible()
  await expect(pushDialog.locator('.push-check details')).toContainText('refs/heads/feature/task2')
  await expect(pushDialog.locator('.push-check details')).toContainText('工作区保留在 main')
  const selectedPlan = await page.evaluate(() => window.__uiSyncPlans.at(-1))
  assert.equal(selectedPlan.sourceRef, 'refs/heads/feature/task2')
  assert.equal(selectedPlan.expectedBranch, 'main')
  await pushDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(pushDialog).not.toBeVisible()
  assert.equal(await page.evaluate(() => window.__uiGitWrites), 1)
  await expect(page.locator('.branch-selector summary strong')).toHaveText(originalHead)
  const splitter = page.getByRole('separator', { name: '调整侧栏宽度' })
  const splitterBox = await splitter.boundingBox()
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 40)
  await page.mouse.down()
  try {
    await page.mouse.move(500, splitterBox.y + 40)
    await expect(targetBranch).toHaveCSS('cursor', 'col-resize')
  } finally {
    await page.mouse.up()
  }
  await expect(targetBranch).toHaveCSS('cursor', 'default')
  const names = (section) =>
    page
      .locator(`[data-sidebar-section="${section}"] .branch-row`)
      .evaluateAll((elements) => elements.map((element) => element.dataset.branchName))
  assert.deepEqual(await names('local'), ['develop', 'feature/task2', 'feature/task10', 'main'])
  assert.deepEqual(await names('tag'), ['v2', 'v10'])
  assert.deepEqual(await names('remote'), ['origin/develop', 'origin/main'])
  const bounds = async (locator) => {
    const box = await locator.boundingBox()
    assert.ok(box)
    return box
  }
  const headerX = []
  for (const id of order)
    headerX.push((await bounds(page.locator(`[data-sidebar-section="${id}"] .section-title`))).x)
  assert.ok(Math.max(...headerX) - Math.min(...headerX) <= 1, `Header title alignment: ${headerX}`)
  const collapse = page.locator('[data-sidebar-section="gitflow"] .section-toggle')
  const collapseBox = await bounds(collapse)
  const collapseIcon = await bounds(collapse.locator('.disclosure-chevron'))
  const panelButton = await bounds(flowAction)
  assert.equal(panelButton.width, 40)
  assert.equal(panelButton.height, 26)
  const createBranchButton = await bounds(
    page.locator('[data-sidebar-section="local"] .section-action'),
  )
  assert.equal(createBranchButton.width, 26)
  assert.equal(createBranchButton.height, panelButton.height)
  assert.equal(createBranchButton.x + createBranchButton.width, panelButton.x + panelButton.width)
  assert.ok(
    Math.abs(panelButton.x - collapseBox.x - collapseBox.width - 6) <= 0.5,
    'Commands are separated from counts',
  )
  const remoteSettingsBox = await bounds(
    page.getByRole('button', { name: '仓库导航显示设置', exact: true }),
  )
  assert.equal(remoteSettingsBox.width, createBranchButton.width)
  assert.equal(remoteSettingsBox.height, createBranchButton.height)
  for (const id of ['remote', 'tag']) {
    const head = page.locator(`[data-sidebar-section="${id}"] .section-head`)
    const toggle = head.locator('.section-toggle')
    const headBox = await bounds(head),
      toggleBox = await bounds(toggle)
    assert.ok(
      Math.abs(headBox.x + headBox.width - toggleBox.x - toggleBox.width - 2) <= 0.5,
      'No empty action column without an action',
    )
    const wasExpanded = await toggle.getAttribute('aria-expanded')
    await page.mouse.click(toggleBox.x + toggleBox.width - 2, toggleBox.y + toggleBox.height / 2)
    await expect(toggle).toHaveAttribute('aria-expanded', wasExpanded === 'true' ? 'false' : 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', wasExpanded)
  }
  assert.ok(
    Math.abs(
      (await bounds(page.locator('[data-sidebar-section="local"] .section-toggle'))).width -
        collapseBox.width -
        14,
    ) <= 1,
    'Compact plus returns space to the title',
  )
  const localHead = page.locator('[data-sidebar-section="local"] .section-head')
  await localHead.locator('.section-toggle').hover()
  await expect(localHead.locator('.section-toggle')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(localHead).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.03)')
  await localHead.locator('.section-action').hover()
  await expect(localHead).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.03)')
  assert.ok(
    collapseBox.x + collapseBox.width <= panelButton.x + 0.5,
    'Fold and panel targets must not overlap',
  )
  assert.ok(
    collapseIcon.x >= collapseBox.x &&
      collapseIcon.x + collapseIcon.width <= collapseBox.x + collapseBox.width,
  )
  await page.locator('[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"]').hover()
  await expect(page.locator('[data-sidebar-section="gitflow"] .branch-row-action')).toHaveCount(0)
  const actionBox = await bounds(
    page.locator(
      '[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"] .branch-favorite',
    ),
  )
  const mainBox = await bounds(
    page.locator(
      '[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"] .branch-main',
    ),
  )
  assert.ok(
    mainBox.x + mainBox.width <= actionBox.x + 0.5,
    'Branch and favorite targets must not overlap',
  )
  const localLabel = await bounds(
    page.locator('[data-sidebar-section="local"] .branch-main > span').first(),
  )
  const baseLabel = await bounds(
    page.locator('[data-sidebar-section="gitflow"] [data-branch-name="main"] .branch-main > span'),
  )
  const folderLabel = await bounds(page.locator('[data-flow-group="feature"] > span'))
  const childLabel = await bounds(
    page.locator(
      '[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"] .branch-main > span',
    ),
  )
  assert.ok(Math.abs(localLabel.x - baseLabel.x) <= 1)
  assert.ok(Math.abs(localLabel.x - folderLabel.x) <= 1)
  assert.ok(Math.abs(localLabel.x - headerX[0] - 16) <= 1)
  assert.ok(Math.abs(childLabel.x - folderLabel.x - 16) <= 1)
  const row = page.locator('[data-sidebar-section="local"] .branch-row').first()
  const text = row.locator('.branch-main > span')
  const before = await bounds(text)
  await row.hover()
  const after = await bounds(text)
  assert.ok(
    Math.abs(before.x - after.x) <= 1 && Math.abs(before.width - after.width) <= 1,
    'Hover must not shift the label',
  )
  const activeNav = page.locator('.workspace-nav button.active')
  const selectedColor = await activeNav.evaluate((element) => getComputedStyle(element).color)
  await activeNav.hover()
  await expect(activeNav).toHaveCSS('color', selectedColor)
  const currentBranch = page.locator(
    '[data-sidebar-section="local"] .branch-row.current .branch-main',
  )
  const currentColor = await currentBranch.evaluate((element) => getComputedStyle(element).color)
  await currentBranch.hover()
  await expect(currentBranch).toHaveCSS('color', currentColor)
  assert.notEqual(
    selectedColor,
    currentColor,
    'Current Git branch and selected view have distinct roles',
  )
  const branchBefore = await page.locator('.branch-selector summary strong').textContent()
  const tag = page.locator('[data-sidebar-section="tag"] .section-toggle')
  await tag.focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: /^下移分组/ })).toBeDisabled()
  await page.getByRole('menuitem', { name: '上移分组', exact: true }).click()
  await expect.poll(sectionOrder).toEqual(['gitflow', 'local', 'tag', 'remote'])
  await page.reload()
  await openFixture()
  await expect.poll(sectionOrder).toEqual(['gitflow', 'local', 'tag', 'remote'])
  await page.locator('[data-sidebar-section="tag"] .section-toggle').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '恢复默认分组顺序', exact: true }).click()
  await expect.poll(sectionOrder).toEqual(order)
  assert.equal(await page.locator('.branch-selector summary strong').textContent(), branchBefore)
  // Favorites are repository preferences, shared by duplicate entries only.
  const localDevelop = page.locator('[data-sidebar-section="local"] [data-branch-name="develop"]')
  const flowDevelop = page.locator('[data-sidebar-section="gitflow"] [data-branch-name="develop"]')
  await page.locator('[data-sidebar-section="local"] .section-toggle').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: /^名称降序/ }).click()
  await expect
    .poll(() => names('local'))
    .toEqual(['main', 'feature/task10', 'feature/task2', 'develop'])
  await localDevelop.hover()
  await localDevelop.getByRole('button', { name: '收藏 develop', exact: true }).click()
  await expect
    .poll(() => names('local'))
    .toEqual(['develop', 'main', 'feature/task10', 'feature/task2'])
  await expect(
    flowDevelop.getByRole('button', { name: '取消收藏 develop', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await names('gitflow'))[0]).toBe('develop')
  await expect(localDevelop.locator('.branch-favorite svg')).toHaveCSS('fill', 'rgb(228, 188, 124)')
  await expect(page.locator('.filter-banner')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.branch-selector summary strong')).toHaveText(branchBefore)
  await page.locator('[data-sidebar-section="remote"] .section-toggle').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: /^名称降序/ }).click()
  await expect.poll(() => names('remote')).toEqual(['origin/main', 'origin/develop'])
  await expect
    .poll(() => names('local'))
    .toEqual(['develop', 'main', 'feature/task10', 'feature/task2'])
  await page.reload()
  await openFixture()
  await expect
    .poll(() => names('local'))
    .toEqual(['develop', 'main', 'feature/task10', 'feature/task2'])
  await expect(localDevelop.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'true')
  await expect(flowDevelop.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'true')
  await localDevelop.locator('.branch-favorite').focus()
  await page.keyboard.press('Space')
  await expect(localDevelop.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'false')
  await expect(flowDevelop.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => names('local'))
    .toEqual(['main', 'feature/task10', 'feature/task2', 'develop'])
  await flowDevelop.hover()
  await flowDevelop.locator('.branch-favorite').click()
  await expect(flowDevelop.locator('.branch-favorite')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(flowDevelop.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'false')
  await expect(flowDevelop.locator('.branch-favorite')).toBeFocused()
  // Returning a pinned workflow branch to a collapsed category focuses its disclosure.
  await targetBranch.hover()
  await targetBranch
    .locator('..')
    .getByRole('button', { name: '收藏 feature/task2', exact: true })
    .click()
  const pinnedFeature = page.locator(
    '[data-sidebar-section="gitflow"] [data-branch-name="feature/task2"]',
  )
  const featureToggle = page.locator('[data-flow-group="feature"]')
  if ((await featureToggle.getAttribute('aria-expanded')) === 'true') await featureToggle.click()
  await pinnedFeature.locator('.branch-favorite').focus()
  await page.keyboard.press('Space')
  await expect(featureToggle).toBeFocused()
  await expect(pinnedFeature.locator('.branch-favorite')).toHaveAttribute('aria-pressed', 'false')
  await featureToggle.click()
  await expect(page.locator('.filter-banner')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.__uiGitWrites), 0)
  await page.getByRole('textbox', { name: '筛选分支', exact: true }).fill('does-not-exist')
  await expect(
    page.locator('[data-sidebar-section="local"]').getByText('无匹配分支', { exact: true }),
  ).toBeVisible()
  await page.getByRole('textbox', { name: '筛选分支', exact: true }).fill('')
  // Check gutter ownership and real hit-target geometry at the supported extremes.
  const originalViewport = page.viewportSize()
  const originalSidebarWidth = await page
    .locator('.app-shell')
    .evaluate((e) => e.style.getPropertyValue('--sidebar-width'))
  const spacingChecks = []
  try {
    for (const width of [190, 220, 330]) {
      await page.setViewportSize({ width: 1440, height: 480 })
      await page
        .locator('.app-shell')
        .evaluate((e, width) => e.style.setProperty('--sidebar-width', `${width}px`), width)
      const geometry = await page.locator('.sidebar').evaluate((sidebar) => {
        const box = (e) => {
          const r = e.getBoundingClientRect()
          return { x: r.x, right: r.right, top: r.top, bottom: r.bottom }
        }
        const sections = sidebar.querySelector('.branch-sections'),
          footer = sidebar.querySelector('.sidebar-bottom')
        const rows = [...sidebar.querySelectorAll('.branch-row')]
        return {
          sidebar: box(sidebar),
          sections: box(sections),
          footer: box(footer),
          overflow: sections.scrollWidth - sections.clientWidth,
          outerEdges: [
            ...sidebar.querySelectorAll(
              '.workspace-nav button, .branch-search, .section-head, .branch-row, .gitflow-group-label',
            ),
          ].map(box),
          titleX: [
            ...sidebar.querySelectorAll(
              '.section-title, .workspace-nav button > span:first-of-type',
            ),
          ].map((e) => e.getBoundingClientRect().x),
          actionsFit: rows.every((row) => {
            const text = row.querySelector('.branch-main').getBoundingClientRect()
            const star = row.querySelector('.branch-favorite').getBoundingClientRect()
            return (
              text.right <= star.x + 0.5 &&
              star.width === 22 &&
              row.getBoundingClientRect().right >= star.right
            )
          }),
          scrollable: sections.scrollHeight > sections.clientHeight,
        }
      })
      assert.ok(
        geometry.outerEdges.every((r) => Math.abs(r.x - geometry.sidebar.x - 8) <= 0.5),
        'All navigation surfaces share the container gutter',
      )
      assert.ok(
        geometry.outerEdges.every((r) => r.right <= geometry.sidebar.right - 8),
        'Right gutter survives narrow layout',
      )
      assert.ok(
        Math.max(...geometry.titleX) - Math.min(...geometry.titleX) <= 0.5,
        'Root navigation labels align',
      )
      assert.ok(
        geometry.sections.bottom <= geometry.footer.top + 0.5,
        'Only the branch area scrolls above the fixed footer',
      )
      assert.ok(
        geometry.overflow <= 1 && geometry.actionsFit && geometry.scrollable,
        'Narrow layout keeps actions and vertical scrolling',
      )
      spacingChecks.push({ width, ...geometry })
    }
  } finally {
    await page.setViewportSize(originalViewport)
    await page
      .locator('.app-shell')
      .evaluate((e, value) => e.style.setProperty('--sidebar-width', value), originalSidebarWidth)
  }
  await page.evaluate((value) => {
    window.__navigationSpacingChecks = value
  }, spacingChecks)
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })
  return {
    uiFixture: true,
    gitWrites: false,
    order: await sectionOrder(),
    headerX,
    labelX: { local: localLabel.x, base: baseLabel.x, folder: folderLabel.x, child: childLabel.x },
    checks: [
      'reference-filter-entry-isolation',
      'context-filter-source',
      'favorite-sync-and-toggle',
      'favorite-no-filter-or-checkout',
      'favorite-keyboard',
      'gitflow-pin-focus-and-collapsed-return',
      'sort-independent-sections',
      'favorite-sort-reload',
      'uniform-whole-header-disclosure',
      'panel-access-while-collapsed',
      'busy-keeps-disclosure-enabled',
      '40px-panel-action-without-overlap',
      'dropdown-open-arrow',
      'dropdown-dismiss-and-focus',
      'disabled-hover-invariance',
      '24px-branch-action-targets',
      'selected-hover-color',
      'selected-push-confirmation',
      'non-current-pull-reason',
      'finish-plan-label',
      'collapse-keyboard-and-inert',
      'collapse-reversal',
      'reduced-motion',
      'desktop-cursors',
      'pressed-feedback',
      'disabled-reason',
      'double-click-one-checkout-attempt',
      'resize-cursor-restored',
      'natural-sort',
      'header-alignment',
      '16px-levels',
      'stable-hover',
      'keyboard-menu',
      'move-boundary',
      'persist-on-reload',
      'restore-default',
      'filter-empty-state',
    ],
  }
}
