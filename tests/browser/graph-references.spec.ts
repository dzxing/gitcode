import { expect, test } from '@playwright/test'
import type { Snapshot } from '../../src/types'
const [a, b, main, base, root] = ['a', 'b', 'c', 'd', 'e'].map((char) => char.repeat(40))
const snapshot: Snapshot = {
  path: '/graph-reference-check',
  name: 'graph-reference-check',
  head: main!,
  branch: 'main',
  total: 5,
  staged: [],
  unstaged: [],
  commits: [
    [a, [main], 'Feature with a long reference', ['feature/a-very-long-branch-name']],
    [b, [main], 'Second feature', ['feature/b']],
    [main, [base, root], 'Merge target', ['HEAD -> main', 'origin/main', 'tag: v1']],
    [base, [root], 'Commit without references', []],
    [root, [], 'Root with hidden alias', ['origin/HEAD']],
  ].map(([hash, parents, subject, refs]) => ({
    hash,
    parents,
    subject,
    refs,
    author: 'Test',
    email: 'test@example.com',
    date: '2026-10-29T00:00:00Z',
  })) as Snapshot['commits'],
  branches: [
    { name: 'main', kind: 'local', hash: main, current: true },
    { name: 'origin/main', kind: 'remote', hash: main },
    { name: 'v1', kind: 'tag', hash: main },
    { name: 'feature/a-very-long-branch-name', kind: 'local', hash: a },
    { name: 'feature/b', kind: 'local', hash: b },
    { name: 'origin/HEAD', kind: 'remote', hash: root },
  ].map((branch) => ({
    ...branch,
    current: !!branch.current,
    upstream: branch.kind === 'local' && branch.name === 'main' ? 'origin/main' : '',
    track: '',
  })) as Snapshot['branches'],
}

test('reference leaders connect the complete badge group to its node without adding ancestry or intercepting controls', async ({
  page,
}) => {
  await page.addInitScript((snapshot) => {
    const blocked = async () => {
      throw new Error('No writes in graph reference checks')
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      snapshot: async () => structuredClone(snapshot),
      commit: async () => ({ body: 'Merge target', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      action: blocked,
      create: blocked,
      chooseDirectory: async () => snapshot.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: blocked,
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, snapshot)
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await page.getByLabel('仓库路径', { exact: true }).fill(snapshot.path)
  await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
  const mergeRow = page.locator(`[data-commit-hash="${main}"]`)
  const mergeIcon = mergeRow.locator('.commit-message > svg')
  await expect(mergeIcon).toHaveAttribute('width', '13')
  await expect(mergeIcon).toHaveCSS('stroke-width', '2px')
  await expect(mergeIcon).toHaveCSS('color', 'rgb(158, 160, 163)')
  await mergeRow.locator('.commit-select').click()
  await expect(mergeRow).toHaveClass(/selected/)
  await expect(mergeIcon).toHaveCSS('color', 'rgb(158, 160, 163)')
  await expect(mergeRow.locator('.commit-message')).toHaveCSS('gap', '5px')
  const plainMessage = page.locator(`[data-commit-hash="${a}"] .commit-message`)
  await expect(plainMessage.locator('svg')).toHaveCount(0)
  expect(
    await plainMessage.evaluate((e) => {
      const text = e.querySelector('span')!.getBoundingClientRect()
      return Math.abs(
        text.x - e.getBoundingClientRect().x - parseFloat(getComputedStyle(e).paddingLeft),
      )
    }),
  ).toBeLessThan(0.01)
  const leaders = page.locator('.reference-connectors line')
  await expect(leaders).toHaveCount(3)
  await expect(page.locator('.commit-graph path[data-parent-hash]')).toHaveCount(5)
  const currentLeader = page.locator(`[data-reference-hash="${main}"]`)
  const featureLeader = page.locator(`[data-reference-hash="${a}"]`)
  await expect(currentLeader).toHaveCSS('stroke-width', '2px')
  await expect(currentLeader).toHaveCSS('opacity', '1')
  await expect(featureLeader).toHaveCSS('stroke-width', '1px')
  await expect(featureLeader).toHaveCSS('opacity', '0.25')
  await expect(featureLeader).toHaveCSS('stroke-dasharray', 'none')
  await expect(page.locator('.commit-graph path[data-parent-hash]').first()).toHaveCSS(
    'stroke-width',
    '2px',
  )
  await expect(page.locator(`[data-reference-hash="${root}"]`)).toHaveCount(0)
  const measure = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll<SVGLineElement>('.reference-connectors line')].map((line) => {
        const row = document.querySelector<HTMLElement>(
          `[data-commit-hash="${line.dataset.referenceHash}"]`,
        )!
        const cell = row.querySelector<HTMLElement>('.ref-cell')!,
          node = document.querySelector<SVGCircleElement>(
            `[data-node-hash="${line.dataset.referenceHash}"] > circle`,
          )!
        const badge = cell.querySelector('.ref-labels')!.getBoundingClientRect()
        const pseudo = getComputedStyle(cell, '::after'),
          cellBox = cell.getBoundingClientRect(),
          cellStyle = getComputedStyle(cell)
        const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(
          line.getScreenCTM()!,
        )
        const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(
          line.getScreenCTM()!,
        )
        const center = new DOMPoint(node.cx.baseVal.value, node.cy.baseVal.value).matrixTransform(
          node.getScreenCTM()!,
        )
        return {
          rasterOffset: line.classList.contains('is-current-reference') ? 0 : 0.5,
          startX: start.x,
          tailEnd: cellBox.right - parseFloat(cellStyle.paddingRight),
          tailStart: cellBox.right - parseFloat(cellStyle.paddingRight) - parseFloat(pseudo.width),
          badgeEnd: badge.right,
          badgeY: badge.top + badge.height / 2,
          pseudoY: cellBox.top + cellBox.height / 2,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          nodeX: center.x,
          nodeY: center.y,
          sameColor: line.getAttribute('stroke') === node.getAttribute('stroke'),
          pointerEvents: getComputedStyle(line).pointerEvents,
        }
      }),
    )
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const m of await measure()) {
      expect(Math.abs(m.startX - m.tailEnd)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(m.tailStart - m.badgeEnd)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(m.startY - m.pseudoY - m.rasterOffset)).toBeLessThan(0.01)
      expect(Math.abs(m.startY - m.badgeY - m.rasterOffset)).toBeLessThan(0.01)
      expect(Math.abs(m.endX - m.nodeX)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(m.endY - m.nodeY - m.rasterOffset)).toBeLessThan(0.01)
      expect(m.sameColor).toBe(true)
      expect(m.pointerEvents).toBe('none')
    }
  }
  await expect(page.locator('.wip-row')).toHaveCount(0)
  await expect(page.locator('.commit-graph > circle')).toHaveCount(0)
  const leaderPoint = await page
    .locator(`[data-reference-hash="${a}"]`)
    .evaluate((line: SVGLineElement) => {
      const point = new DOMPoint(line.x1.baseVal.value + 8, line.y1.baseVal.value).matrixTransform(
        line.getScreenCTM()!,
      )
      return { x: point.x, y: point.y }
    })
  await page.mouse.click(leaderPoint.x, leaderPoint.y)
  await expect(page.locator(`[data-commit-hash="${a}"]`)).toHaveClass(/selected/)
  // Selecting a commit must not promote its guide to the checked-out branch.
  await expect(featureLeader).toHaveCSS('opacity', '0.25')
  await expect(currentLeader).toHaveCSS('opacity', '1')
  const more = page.locator(`[data-commit-hash="${main}"] .ref-more`)
  await more.click()
  const dialog = page.getByRole('dialog', { name: '提交引用', exact: true })
  await expect(dialog.locator('li')).toHaveCount(3)
  await expect(more).toHaveText('+1')
  await expect(more).toHaveAccessibleName(/另有 1 组引用，查看全部 3 个引用/)
  await dialog.getByRole('button', { name: '关闭引用列表', exact: true }).click()
  await expect(more).toBeFocused()
  const endpoints = await page.evaluate(() =>
    [...document.querySelectorAll<SVGPathElement>('.commit-graph path[data-parent-hash]')].map(
      (path) => {
        const parent = document.querySelector<SVGCircleElement>(
          `[data-node-hash="${path.dataset.parentHash}"] > circle`,
        )
        if (!parent) return true
        const point = path.getPointAtLength(path.getTotalLength())
        return (
          Math.abs(point.x - parent.cx.baseVal.value) < 0.01 &&
          Math.abs(point.y - parent.cy.baseVal.value) < 0.01
        )
      },
    ),
  )
  expect(endpoints.every(Boolean)).toBe(true)
  await page.getByRole('textbox', { name: '搜索提交', exact: true }).fill('Merge target')
  await expect(leaders).toHaveCount(1)
  await expect(page.locator('.commit-graph path[stroke-dasharray]')).toHaveCount(2)
  await expect(leaders).not.toHaveAttribute('stroke-dasharray')
  await expect(page.locator('.branch-selector summary strong')).toHaveText('main')
})

test('refreshing a different HEAD leaves every rendered commit and ancestry track unchanged', async ({
  page,
}) => {
  await page.addInitScript((state) => {
    const blocked = async () => {
      throw new Error('No Git writes in HEAD layout checks')
    }
    const mutable = structuredClone(state)
    ;(window as any).__setGraphHead = (hash: string) => {
      mutable.head = hash
      const branch = mutable.branches.find((b) => b.kind === 'local' && b.hash === hash)!
      mutable.branch = branch.name
      for (const item of mutable.branches) item.current = item === branch
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      snapshot: async () => structuredClone(mutable),
      commit: async () => ({ body: 'read-only', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      action: blocked,
      create: blocked,
      chooseDirectory: async () => state.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: blocked,
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, snapshot)
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await page.getByLabel('仓库路径', { exact: true }).fill(snapshot.path)
  await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
  const layout = () =>
    page.evaluate(() => ({
      nodes: [...document.querySelectorAll('[data-node-hash]')].map((e) => ({
        hash: e.getAttribute('data-node-hash'),
        circle: e.querySelector('circle')!.outerHTML,
      })),
      edges: [...document.querySelectorAll('.commit-graph path[data-parent-hash]')]
        .filter((e) => e.getAttribute('data-child-hash') !== '__worktree__')
        .map((e) => e.outerHTML),
    }))
  const before = await layout()
  for (const head of [a!, b!, main!]) {
    await page.evaluate((head) => (window as any).__setGraphHead(head), head)
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(page.locator('.branch-selector summary strong')).toHaveText(
      snapshot.branches.find((b) => b.kind === 'local' && b.hash === head)!.name,
    )
    await expect(page.locator('.commit-graph path[data-child-hash="__worktree__"]')).toHaveCount(0)
    expect(await layout()).toEqual(before)
    await expect(page.locator('.commit-graph > circle')).toHaveCount(0)
    await expect(page.locator(`.reference-connectors .is-current-reference`)).toHaveAttribute(
      'data-reference-hash',
      head,
    )
  }
})

test('combined labels expand on hover and focus without moving the graph or hiding remote and extra-reference controls', async ({
  page,
}) => {
  const state = structuredClone(snapshot)
  const localName = 'feature/a-very-long-branch-name'
  const remoteName = `origin/${localName}`
  state.branch = localName
  state.head = a!
  for (const branch of state.branches)
    branch.current = branch.name === localName && branch.kind === 'local'
  state.branches.find((branch) => branch.current)!.upstream = remoteName
  state.branches.push(
    { name: remoteName, hash: a!, current: false, upstream: '', track: '', kind: 'remote' },
    { name: 'release-marker', hash: a!, current: false, upstream: '', track: '', kind: 'tag' },
  )
  state.commits.find((commit) => commit.hash === a)!.refs = [
    `HEAD -> ${localName}`,
    remoteName,
    'tag: release-marker',
  ]
  await page.addInitScript((state) => {
    const blocked = async () => {
      throw new Error('Reference inspection must not mutate Git')
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      snapshot: async () => structuredClone(state),
      commit: async () => ({ body: 'read-only', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      action: blocked,
      create: blocked,
      chooseDirectory: async () => state.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: blocked,
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, state)
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await page.getByLabel('仓库路径', { exact: true }).fill(state.path)
  await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
  await page.mouse.move(1200, 100)
  const row = page.locator(`[data-commit-hash="${a}"]`),
    group = row.locator('.ref-labels'),
    content = row.locator('.ref-labels-content')
  const badge = row.locator('.ref-tag'),
    primary = badge.getByRole('button', { name: `当前分支 ${localName}`, exact: true })
  const remote = badge.getByRole('button', {
    name: `查看远程引用 refs/remotes/${remoteName}`,
    exact: true,
  })
  await expect(badge.locator('.ref-current-mark')).toHaveCount(1)
  await expect(badge.locator('[data-reference-kind="local"]')).toHaveCount(1)
  await expect(badge.locator('[data-reference-kind="remote"]')).toHaveCount(1)
  const more = row.locator('.ref-more')
  await expect(more).toHaveText('+1')
  await expect(more).toHaveAccessibleName(/另有 1 组引用，查看全部 3 个引用/)
  const collapsed = (await content.boundingBox())!,
    groupBefore = (await group.boundingBox())!
  const node = page.locator(`[data-node-hash="${a}"] > circle`).first(),
    nodeBefore = (await node.boundingBox())!
  expect(
    await badge.locator('.ref-label-name').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true)
  // Directly entering the collapsed cloud/+N hit targets must not move them
  // under the pointer and turn a read-only click into a local checkout.
  for (const button of [remote, more]) {
    await page.mouse.move(1200, 100)
    await page.getByRole('textbox', { name: '搜索提交', exact: true }).focus()
    const box = (await button.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    expect((await content.boundingBox())!.width).toBeLessThanOrEqual(collapsed.width + 0.5)
    await page.mouse.down()
    await page.mouse.up()
    const inspect = page.getByRole('dialog', { name: '提交引用', exact: true })
    await expect(inspect).toBeVisible()
    await expect(inspect.locator('li')).toHaveCount(3)
    await inspect.getByRole('button', { name: '关闭引用列表', exact: true }).click()
  }
  await page.mouse.move(1200, 100)
  await page.getByRole('textbox', { name: '搜索提交', exact: true }).focus()
  await badge.hover()
  await expect
    .poll(async () => (await content.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 50)
  expect(
    await badge.locator('.ref-label-name').evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1)
  expect(Math.abs((await group.boundingBox())!.width - groupBefore.width)).toBeLessThanOrEqual(0.5)
  expect(Math.abs((await node.boundingBox())!.x - nodeBefore.x)).toBeLessThanOrEqual(0.5)
  await expect(row).toHaveCSS('height', '30px')
  await remote.hover()
  await more.hover()
  await expect
    .poll(async () => (await content.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 50)
  await remote.click()
  const refs = page.getByRole('dialog', { name: '提交引用', exact: true })
  await expect(refs.locator('li')).toHaveCount(3)
  await expect(refs.getByText(`refs/remotes/${remoteName}`, { exact: true })).toBeVisible()
  await refs.getByRole('button', { name: '关闭引用列表', exact: true }).click()
  await expect(remote).toBeFocused()
  await remote.click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveAccessibleName(`${remoteName} 右键菜单`)
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: '创建本地跟踪分支…', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(remote).toBeFocused()
  await primary.click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveAccessibleName(`${localName} 右键菜单`)
  await page.keyboard.press('Escape')
  await page.mouse.move(1200, 100)
  await page.getByRole('textbox', { name: '搜索提交', exact: true }).focus()
  await expect
    .poll(async () => (await content.boundingBox())!.width)
    .toBeLessThanOrEqual(collapsed.width + 0.5)
  for (let i = 0; i < 8 && !(await primary.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  await expect(primary).toBeFocused()
  await expect
    .poll(async () => (await content.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 50)
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect
    .poll(async () => (await content.boundingBox())!.x + (await content.boundingBox())!.width)
    .toBeLessThanOrEqual(
      (await page.locator('.history-panel').boundingBox())!.x +
        (await page.locator('.history-panel').boundingBox())!.width -
        7,
    )
  await page.locator('.history-scroll').evaluate((el) => {
    el.scrollLeft = 30
  })
  await expect
    .poll(async () => (await content.boundingBox())!.x + (await content.boundingBox())!.width)
    .toBeLessThanOrEqual(
      (await page.locator('.history-panel').boundingBox())!.x +
        (await page.locator('.history-panel').boundingBox())!.width -
        7,
    )
  expect((await remote.boundingBox())!.width).toBeGreaterThanOrEqual(17)
  expect((await more.boundingBox())!.width).toBeGreaterThanOrEqual(25)
  await expect(page.locator('.branch-selector summary strong')).toHaveText(localName)
})

test('WIP appears only for real changes and removing it keeps every graph node aligned', async ({
  page,
}) => {
  await page.addInitScript((snapshot) => {
    const blocked = async () => {
      throw new Error('No Git writes in WIP checks')
    }
    window.gitk = {
      runtime: async () => ({
        platform: 'windows',
        gitAvailable: true,
        gitVersion: 'test',
        gitPath: 'test',
        gitError: '',
      }),
      snapshot: async () => structuredClone(snapshot),
      commit: async () => ({ body: '', files: [] }),
      diff: async () => ({ diff: '', truncated: false }),
      action: blocked,
      create: blocked,
      chooseDirectory: async () => snapshot.path,
      cancel: async () => {},
      openResource: async () => {},
      syncPlan: blocked,
      gitflowPlan: blocked,
      listDirectory: blocked,
    }
  }, snapshot)
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await page.getByLabel('仓库路径', { exact: true }).fill(snapshot.path)
  await page.getByRole('dialog').getByRole('button', { name: '打开仓库', exact: true }).click()
  for (const mode of ['clean', 'unstaged', 'staged', 'untracked', 'clean']) {
    const next = structuredClone(snapshot)
    if (mode === 'staged') next.staged = [{ path: 'tracked.txt', status: 'M' }]
    if (mode === 'unstaged') next.unstaged = [{ path: 'tracked.txt', status: 'M' }]
    if (mode === 'untracked') next.unstaged = [{ path: 'new.txt', status: '?' }]
    await page.evaluate((next) => {
      window.gitk!.snapshot = async () => next
    }, next)
    await page
      .locator('.toolbar-actions')
      .getByRole('button', { name: '刷新', exact: true })
      .click()
    await expect(
      page.locator('.toolbar-actions').getByRole('button', { name: '刷新', exact: true }),
    ).toBeEnabled()
    const dirty = mode !== 'clean'
    await expect(page.locator('.wip-row')).toHaveCount(dirty ? 1 : 0)
    await expect(page.locator('.commit-graph > circle')).toHaveCount(dirty ? 1 : 0)
    await expect(page.locator('[data-node-hash] > circle').first()).toHaveAttribute(
      'cy',
      dirty ? '45' : '15',
    )
    const aligned = await page.evaluate(() =>
      [
        ...document.querySelectorAll<SVGCircleElement>('[data-node-hash] > circle:first-of-type'),
      ].every((circle) => {
        const hash = circle.parentElement!.getAttribute('data-node-hash')
        const row = document.querySelector(`[data-commit-hash="${hash}"]`)!.getBoundingClientRect()
        const point = new DOMPoint(
          circle.cx.baseVal.value,
          circle.cy.baseVal.value,
        ).matrixTransform(circle.getScreenCTM()!)
        return Math.abs(point.y - row.y - row.height / 2) < 0.6
      }),
    )
    expect(aligned).toBe(true)
  }
})
