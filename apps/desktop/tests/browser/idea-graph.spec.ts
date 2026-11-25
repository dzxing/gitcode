import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import { repositoryFixture } from '../fixtures/repository'
import type { Snapshot } from '../../src/shared/contracts'

const [feature, side, featureOld, main, root] = ['1', '2', '3', '4', '5'].map((x) => x.repeat(40))
const snapshot: Snapshot = {
  ...structuredClone(repositoryFixture),
  name: 'IDEA graph layout',
  branch: 'main',
  head: main,
  staged: [],
  unstaged: [],
  stashes: [],
  total: 5,
  commits: [
    [feature, [featureOld], 'Feature tip'],
    [side, [main], 'Side tip'],
    [featureOld, [root], 'Feature history'],
    [main, [root], 'Main history'],
    [root, [], 'Shared root'],
  ].map(([hash, parents, subject]) => ({
    hash,
    parents,
    subject,
    refs: [],
    author: 'Graph test',
    email: 'graph@example.invalid',
    date: '2026-11-09T00:00:00Z',
  })) as Snapshot['commits'],
  branches: [
    { name: 'feature/10', hash: feature, kind: 'local' },
    { name: 'feature/2', hash: side, kind: 'local' },
    { name: 'main', hash: main, kind: 'local', current: true },
    { name: 'origin/main', hash: main, kind: 'remote' },
  ].map((branch) => ({
    ...branch,
    current: !!branch.current,
    upstream: '',
    track: '',
  })) as Snapshot['branches'],
}

test('IDEA layout keeps main ancestry left, connects row-compacted paths and does not move on selection', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openFixtureRepository(page, false, snapshot)
  const circles = page.locator('[data-node-hash] > circle:first-child')
  await expect(circles).toHaveCount(5)
  await expect(page.locator(`[data-node-hash="${main}"] > circle:first-child`)).toHaveAttribute(
    'cx',
    '24',
  )
  const geometry = () =>
    circles.evaluateAll((nodes) =>
      nodes.map((node) => [
        node.parentElement?.getAttribute('data-node-hash'),
        node.getAttribute('cx'),
        node.getAttribute('cy'),
        node.getAttribute('fill'),
      ]),
    )
  const baseline = await geometry()
  for (const hash of [side, feature, main]) {
    await page.locator(`[data-commit-hash="${hash}"] .commit-select`).click()
    expect(await geometry()).toEqual(baseline)
  }
  const ancestry = page.locator('.commit-graph > path[data-child-hash]')
  for (const path of await ancestry.all()) {
    await expect(path).toHaveAttribute('stroke-linecap', 'round')
    await expect(path).toHaveAttribute('stroke-linejoin', 'round')
    expect(await path.getAttribute('d')).not.toMatch(/[HQC]/)
  }
  expect(
    await ancestry.evaluateAll((paths) =>
      paths.some((path) => path.getAttribute('d')?.includes(' L')),
    ),
  ).toBe(true)
  const endpoints = await page
    .locator('.commit-graph > path[data-child-hash]')
    .evaluateAll((paths) =>
      paths.map((element) => {
        const path = element as SVGPathElement
        const svg = path.ownerSVGElement!
        const child = svg.querySelector(`[data-node-hash="${path.dataset.childHash}"] > circle`)!
        const parent = svg.querySelector(`[data-node-hash="${path.dataset.parentHash}"] > circle`)!
        const start = path.getPointAtLength(0),
          end = path.getPointAtLength(path.getTotalLength())
        return {
          start: [start.x, start.y],
          end: [end.x, end.y],
          child: [Number(child.getAttribute('cx')), Number(child.getAttribute('cy'))],
          parent: [Number(parent.getAttribute('cx')), Number(parent.getAttribute('cy'))],
        }
      }),
    )
  expect(endpoints).toHaveLength(4)
  for (const edge of endpoints) {
    expect(edge.start).toEqual(edge.child)
    expect(edge.end[0]).toBeCloseTo(edge.parent[0], 3)
    expect(edge.end[1]).toBeCloseTo(edge.parent[1], 3)
  }
  expect(errors).toEqual([])
  await page.screenshot({ path: 'design/idea-graph-layout/browser-verified.png' })
})
