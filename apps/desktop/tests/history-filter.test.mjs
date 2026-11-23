import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const previousStorage = globalThis.localStorage,
  previousWindow = globalThis.window
const saved = new Map()
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: (key) => saved.delete(key),
}
globalThis.window = {}
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
try {
  const {
    historyFilterKey,
    historyFilterPreference,
    readHistoryFilter,
    writeHistoryFilter,
    restoreHistoryFilter,
  } = await vite.ssrLoadModule('/src/services/historyFilter.ts')
  const { repositoryFixture } = await vite.ssrLoadModule('/tests/fixtures/repository.ts')
  const repo = { ...structuredClone(repositoryFixture), path: '/repo/one' }
  await test('repository keys normalize Windows spelling without merging case-sensitive repositories or UNC paths', () => {
    assert.equal(historyFilterKey('C:\\Repo\\中文\\'), historyFilterKey('c:/Repo/中文'))
    assert.notEqual(historyFilterKey('/repo/A'), historyFilterKey('/repo/a'))
    assert.notEqual(historyFilterKey('/'), historyFilterKey(''))
    assert.notEqual(historyFilterKey('C:\\Repo'), historyFilterKey('C:\\repo'))
    assert.equal(
      historyFilterKey('\\\\server\\share\\repo'),
      historyFilterKey('//server/share/repo'),
    )
    assert.notEqual(historyFilterKey('/repo/back\\slash'), historyFilterKey('/repo/back/slash'))
  })
  await test('only reference and matching entry section are stored; same-named tags and branches remain distinct', async () => {
    const ref = 'refs/heads/develop'
    await writeHistoryFilter(
      repo.path,
      historyFilterPreference({ fullRef: ref, source: JSON.stringify(['local', ref]) }),
    )
    assert.deepEqual(JSON.parse(saved.get(historyFilterKey(repo.path))), {
      version: 1,
      fullRef: ref,
      section: 'local',
    })
    assert.deepEqual(restoreHistoryFilter(repo, readHistoryFilter(repo.path)).filter, {
      fullRef: ref,
      source: JSON.stringify(['local', ref]),
    })
    const tag = { ...repo.branches[0], kind: 'tag', name: 'develop', fullRef: 'refs/tags/develop' }
    const restored = restoreHistoryFilter(
      { ...repo, branches: [...repo.branches, tag] },
      { fullRef: tag.fullRef, section: 'tag' },
    )
    assert.equal(restored.filter.fullRef, tag.fullRef)
    assert.equal(restored.filter.source, JSON.stringify(['tag', tag.fullRef]))
    assert.equal(readHistoryFilter('/repo/two'), null)
  })
  await test('invalid or mismatched selection sources cannot highlight another sidebar row', () => {
    for (const source of [
      'arbitrary-entry',
      '["__proto__","refs/heads/develop"]',
      '[42,"refs/heads/develop"]',
      '["gitflow","refs/heads/other"]',
    ])
      assert.equal(historyFilterPreference({ fullRef: 'refs/heads/develop', source }).section, null)
  })
  await test('a removed full ref never falls back to a same-named tag', () => {
    const tag = { ...repo.branches[0], kind: 'tag', name: 'gone', fullRef: 'refs/tags/gone' }
    assert.deepEqual(
      restoreHistoryFilter(
        { ...repo, branches: [tag] },
        { fullRef: 'refs/heads/gone', section: 'local' },
      ),
      { filter: null, missing: true },
    )
  })
  await test('GitFlow entry is retained only while that branch still belongs to a ready GitFlow group', () => {
    const flow = {
      ready: true,
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: 'v',
      },
    }
    const pref = { fullRef: 'refs/heads/develop', section: 'gitflow' }
    assert.equal(
      restoreHistoryFilter({ ...repo, gitflow: flow }, pref).filter.source,
      JSON.stringify(['gitflow', pref.fullRef]),
    )
    assert.equal(
      restoreHistoryFilter({ ...repo, gitflow: { ...flow, ready: false } }, pref).filter.source,
      JSON.stringify(['local', pref.fullRef]),
    )
    assert.equal(
      restoreHistoryFilter(
        { ...repo, gitflow: { ...flow, config: { ...flow.config, develop: 'integration' } } },
        pref,
      ).filter.source,
      JSON.stringify(['local', pref.fullRef]),
    )
  })
  await test('malformed, oversized and unsupported preferences fall back safely; clear removes only this repository', async () => {
    const key = historyFilterKey(repo.path)
    for (const value of [
      '{',
      '[]',
      JSON.stringify({ version: 2, fullRef: 'refs/heads/develop' }),
      JSON.stringify({ version: 1, fullRef: 'HEAD' }),
      JSON.stringify({ version: 1, fullRef: 'refs/heads/bad\nname' }),
      'x'.repeat(16001),
    ]) {
      saved.set(key, value)
      assert.equal(readHistoryFilter(repo.path), null)
    }
    await writeHistoryFilter('/repo/two', { fullRef: 'refs/heads/main', section: 'local' })
    await writeHistoryFilter(repo.path, null)
    assert.equal(readHistoryFilter(repo.path), null)
    assert.equal(readHistoryFilter('/repo/two').fullRef, 'refs/heads/main')
  })
  await test('storage denial does not break reading; desktop flush errors remain observable to the store', async () => {
    const original = globalThis.localStorage
    globalThis.localStorage = {
      getItem() {
        throw Error('denied')
      },
      setItem() {
        throw Error('quota')
      },
    }
    assert.equal(readHistoryFilter(repo.path), null)
    assert.throws(
      () => writeHistoryFilter(repo.path, { fullRef: 'refs/heads/main', section: null }),
      /quota/,
    )
    globalThis.localStorage = original
    window.gitkApp = { flushDraftStorage: () => Promise.reject(Error('flush failed')) }
    await assert.rejects(
      writeHistoryFilter(repo.path, { fullRef: 'refs/heads/main', section: null }),
      /flush failed/,
    )
    delete window.gitkApp
  })
} finally {
  await vite.close()
  if (previousStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previousStorage
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}
