import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
try {
  const { buildCommitMenu } = await vite.ssrLoadModule('/src/app/commitMenu.ts')
  const { repositoryFixture } = await vite.ssrLoadModule('/tests/fixtures/repository.ts')
  const state = {
    connected: true,
    busy: false,
    rebasePlanning: false,
    historyLoading: false,
    flowPanel: false,
    conflictDraft: false,
    interactive: true,
  }
  const repo = structuredClone(repositoryFixture)
  const get = (r, c, s = state) => new Map(buildCommitMenu(r, c, s).map((item) => [item.id, item]))
  await test('IDEA screenshot order: 21 fixed items, 7 groups across root/merge/HEAD/detached', () => {
    const expected = [
      'copy-sha',
      'commit-patch',
      'commit-cherry',
      'commit-checkout',
      'commit-browse',
      'compare-working',
      'commit-reset',
      'commit-revert',
      'commit-undo',
      'commit-reword',
      'commit-fixup',
      'commit-squash-into',
      'commit-drop',
      'commit-squash',
      'commit-interactive',
      'commit-push',
      'create-branch',
      'create-tag',
      'jump-child',
      'jump-parent',
      'commit-browser',
    ]
    for (const c of repo.commits)
      for (const branch of [repo.branch, 'detached HEAD']) {
        const menu = buildCommitMenu({ ...repo, branch }, c, state)
        assert.deepEqual(
          menu.map((i) => i.id),
          expected,
        )
        assert.equal(menu.filter((i) => i.separator).length, 6)
      }
  })
  await test('single/multi selection, merge, root and dirty-state restrictions are independent', () => {
    const head = repo.commits[0],
      root = repo.commits.at(-1)
    assert.equal(get(repo, head).get('commit-undo').disabled, false)
    assert.equal(get(repo, root).get('commit-undo').disabled, true)
    assert.equal(get(repo, root).get('jump-parent').disabled, true)
    assert.equal(get(repo, head).get('commit-squash').disabled, true)
    const multi = get(repo, head, { ...state, commits: [repo.commits[2], repo.commits[3]] })
    assert.equal(multi.get('commit-checkout').disabled, true)
    assert.equal(multi.get('commit-squash').disabled, false)
    assert.equal(
      get({ ...repo, staged: [], unstaged: [] }, head).get('commit-fixup').disabled,
      true,
    )
    assert.equal(get(repo, repo.commits[1]).get('commit-revert').disabled, true)
    assert.equal(
      get({ ...repo, head: repo.commits[1].hash }, repo.commits[1]).get('commit-reword').disabled,
      false,
    )
  })
  await test('unknown complete-history conditions defer to invocation; disconnected and busy writes are blocked', () => {
    assert.equal(
      get(repo, repo.commits.at(-1), { ...state, interactive: null }).get('commit-interactive')
        .disabled,
      false,
    )
    assert.equal(
      get(repo, repo.commits[0], { ...state, busy: true }).get('commit-reset').disabled,
      true,
    )
    assert.equal(
      get(repo, repo.commits[0], { ...state, busy: true }).get('copy-sha').disabled,
      false,
    )
    assert.equal(
      get(repo, repo.commits[0], { ...state, connected: false }).get('commit-browse').disabled,
      true,
    )
    assert.equal(
      get({ ...repo, branch: 'detached HEAD' }, repo.commits[0]).get('commit-reset').disabled,
      false,
    )
    assert.equal(
      get({ ...repo, branch: 'detached HEAD' }, repo.commits[0]).get('commit-reword').disabled,
      true,
    )
  })
} finally {
  await vite.close()
}
