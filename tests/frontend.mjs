import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { createSSRApp, nextTick } from 'vue'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { renderToString } from '@vue/server-renderer'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { GitService } = createRequire(import.meta.url)('../electron/git.cjs')

// Compile actual .vue components and stores without listening on any port.
const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
})
const originalWindow = globalThis.window
const nativeRuntime = {
  platform: 'windows',
  gitAvailable: true,
  gitVersion: 'git version 2.53.0',
  gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
  gitError: '',
}
let nativeHandler = async () => nativeRuntime
globalThis.window = {
  gitk: {
    runtime: () => nativeHandler('runtime'),
    syncPlan: (repo, kind, expected) => nativeHandler('sync-plan', { repo, kind, expected }),
    selectedCommitPlan: (repo, request) => nativeHandler('selected-commit-plan', { repo, request }),
    gitflowPlan: (repo, request) => nativeHandler('gitflow-plan', { repo, request }),
    snapshot: (repo) => nativeHandler('snapshot', { repo }),
    commit: (repo, commit) => nativeHandler('commit', { repo, commit }),
    diff: (repo, path, staged, commit) => nativeHandler('diff', { repo, path, staged, commit }),
    action: (repo, request) => nativeHandler('action', { repo, request }),
    create: (kind, path, url) => nativeHandler('create', { request: { kind, path, url } }),
    chooseDirectory: () => nativeHandler('chooseDirectory'),
    listDirectory: (path) => nativeHandler('listDirectory', { path }),
    cancel: () => nativeHandler('cancel'),
    openResource: (resource) => nativeHandler('openResource', { resource }),
  },
}
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
}

try {
  const { default: App } = await vite.ssrLoadModule('/src/App.vue')
  const { useRepositoryStore } = await vite.ssrLoadModule('/src/stores/repository.ts')
  const { useGitFlowStore } = await vite.ssrLoadModule('/src/stores/gitflow.ts')
  const { default: GitFlowPanel } = await vite.ssrLoadModule('/src/components/GitFlowPanel.vue')
  const { default: Sidebar } = await vite.ssrLoadModule('/src/components/Sidebar.vue')
  const { default: Inspector } = await vite.ssrLoadModule('/src/components/Inspector.vue')
  const { default: ContextMenu } = await vite.ssrLoadModule('/src/components/ContextMenu.vue')
  const { useSidebarStore } = await vite.ssrLoadModule('/src/stores/sidebar.ts')
  const { useWorktreeStore } = await vite.ssrLoadModule('/src/stores/worktree.ts')
  const { normalizeSidebarOrder, sortSidebarBranches, remoteBranchGroups, branchDirectoryTree } =
    await vite.ssrLoadModule('/src/sidebar.ts')
  const { branchTracking } = await vite.ssrLoadModule('/src/branchTracking.ts')
  const { buildGraph, buildHistoryGraph } = await vite.ssrLoadModule('/src/graph.ts')
  const { resolveCommitReferences, groupCommitReferences } =
    await vite.ssrLoadModule('/src/referenceLabels.ts')
  const { buildMenus } = await vite.ssrLoadModule('/src/menu.ts')
  const { repositoryFixture: fixture } = await vite.ssrLoadModule('/tests/fixtures/repository.ts')
  const { useContextMenuStore, referenceBranch } = await vite.ssrLoadModule(
    '/src/stores/contextMenu.ts',
  )
  const { desktop, pathName, joinPath } = await vite.ssrLoadModule('/src/services/desktop.ts')
  const { createLocalCoreClient, LocalConnectionError } = await vite.ssrLoadModule(
    '/src/services/localCore.ts',
  )
  const { useDesktopWindow } = await vite.ssrLoadModule('/src/composables/useDesktopWindow.ts')
  const seedRepository = (store) => {
    store.repo = structuredClone(fixture)
    store.tabs = [{ id: 1, kind: 'repository', name: fixture.name, path: fixture.path }]
    return store
  }
  const freshStore = () => {
    nativeHandler = async (command) =>
      command === 'commit'
        ? { files: [{ path: 'README.md', status: 'M' }], body: 'Fixture commit' }
        : command === 'diff'
          ? { diff: '+fixture', truncated: false }
          : nativeRuntime
    setActivePinia(createPinia())
    return seedRepository(useRepositoryStore())
  }
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  await test('Branch tracking keeps ahead and behind independent from current selection and explains local freshness', () => {
    const branch = {
      kind: 'local',
      current: true,
      name: 'main',
      upstream: 'origin/main',
      track: '[ahead 2, behind 3]',
    }
    for (const current of [true, false]) {
      const value = branchTracking({ ...branch, current })
      assert.equal(value.ahead, 2)
      assert.equal(value.behind, 3)
      assert.equal(value.label, '↑2 ↓3')
      assert.equal(value.state, 'diverged')
      assert.match(value.description, /获取后才会获知/)
    }
    assert.equal(branchTracking({ ...branch, track: '[ahead 4]' }).label, '↑4')
    assert.equal(branchTracking({ ...branch, track: '[behind 5]' }).label, '↓5')
    assert.equal(branchTracking({ ...branch, track: '' }).state, 'synced')
  })
  await test('Unconfigured tracking stays quiet; missing configured refs and unknown states remain explicit', () => {
    const branch = {
      kind: 'local',
      current: true,
      name: 'main',
      upstream: 'origin/main',
      track: '',
    }
    const untracked = branchTracking({ ...branch, upstream: '' })
    assert.equal(untracked.label, '')
    assert.equal(untracked.description, '')
    assert.equal(branchTracking({ ...branch, track: '[gone]' }).label, '上游不存在')
    assert.equal(branchTracking({ ...branch, track: '[unexpected]' }).state, 'unknown')
    for (const kind of ['remote', 'tag'])
      assert.equal(branchTracking({ ...branch, kind, upstream: '' }).label, '')
  })

  await test('Browser bridge rejects non-object JSON envelopes before sending Git requests', async () => {
    for (const payload of [null, [], 'unexpected']) {
      let requests = 0
      const client = createLocalCoreClient(
        async () => {
          requests++
          return new Response(JSON.stringify(payload))
        },
        'http://localhost:43187',
        () => {},
      )
      await assert.rejects(client.bridge.runtime(), /无效响应/)
      assert.equal(requests, 1)
    }
  })

  await test('Browser bridge shares a session handshake and sends narrow authenticated operations', async () => {
    const calls = [],
      token = 'a'.repeat(64)
    const client = createLocalCoreClient(
      async (url, options) => {
        calls.push({ url, options, data: JSON.parse(options.body) })
        if (url.endsWith('/session')) return new Response(JSON.stringify({ token, protocol: 1 }))
        return new Response(JSON.stringify({ result: { ok: true } }))
      },
      'http://localhost:43187',
      () => {},
    )
    await Promise.all([client.bridge.runtime(), client.bridge.listDirectory('/home')])
    assert.equal(calls.filter((call) => call.url.endsWith('/session')).length, 1)
    const actual = calls.filter((call) => call.url.endsWith('/rpc'))
    assert.deepEqual(actual.map((call) => call.data.method).sort(), ['directory', 'runtime'])
    for (const call of actual) {
      assert.equal(call.options.headers['X-GitCode-Token'], token)
      assert.equal(call.options.mode, 'same-origin')
      assert.equal(call.options.credentials, 'omit')
      assert.equal(call.options.redirect, 'error')
      assert.ok(!call.url.includes(token))
    }
    client.close()
    assert.equal(calls.at(-1).options.keepalive, true)
    assert.ok(calls.at(-1).url.endsWith('/close'))
  })

  await test('Browser transport never replays mutations after a network failure', async () => {
    let actions = 0,
      disconnects = 0
    const client = createLocalCoreClient(
      async (url, options) => {
        if (url.endsWith('/session'))
          return new Response(JSON.stringify({ token: 'b'.repeat(64), protocol: 1 }))
        const { method } = JSON.parse(options.body)
        if (method === 'action') {
          actions++
          throw new TypeError('connection reset after Git accepted request')
        }
        return new Response(JSON.stringify({ result: nativeRuntime }))
      },
      'http://localhost:43187',
      () => {
        disconnects++
      },
    )
    await assert.rejects(
      client.bridge.action('/repo', { action: 'push', planId: 'once' }),
      (error) => error instanceof LocalConnectionError && /可能已经生效/.test(error.message),
    )
    assert.equal(actions, 1)
    assert.equal(disconnects, 1)
    await client.bridge.runtime()
    assert.equal(actions, 1)
  })

  await test('Browser cancellation waits for acknowledgement before aborting pending snapshot and sync reads without disconnecting', async () => {
    const readStarted = deferred(),
      snapshotStarted = deferred(),
      cancelStarted = deferred(),
      acknowledgement = deferred()
    const methods = []
    let sessions = 0,
      disconnects = 0
    const readSignals = new Map()
    const client = createLocalCoreClient(
      async (url, options) => {
        if (url.endsWith('/session')) {
          sessions++
          return new Response(JSON.stringify({ token: 'd'.repeat(64), protocol: 1 }))
        }
        const { method } = JSON.parse(options.body)
        methods.push(method)
        if (method === 'sync-plan' || method === 'snapshot') {
          const signal = options.signal
          readSignals.set(method, signal)
          if (method === 'sync-plan') readStarted.resolve()
          else snapshotStarted.resolve()
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        if (method === 'cancel') {
          cancelStarted.resolve()
          return acknowledgement.promise
        }
        if (method === 'runtime') return new Response(JSON.stringify({ result: nativeRuntime }))
        throw new Error(`Unexpected browser RPC ${method}`)
      },
      'http://localhost:43187',
      () => {
        disconnects++
      },
    )
    const read = client.bridge.syncPlan('/repo', 'push', {
      expectedHead: 'a'.repeat(40),
      expectedBranch: 'main',
    })
    const snapshot = client.bridge.snapshot('/repo')
    const stopped = assert.rejects(read, /停止读取操作/)
    const snapshotStopped = assert.rejects(snapshot, /停止读取操作/)
    await Promise.all([readStarted.promise, snapshotStarted.promise])
    const cancellation = client.bridge.cancel()
    await cancelStarted.promise
    assert.equal(
      readSignals.get('sync-plan').aborted,
      false,
      'The plan must not abort before the core confirms cancellation',
    )
    assert.equal(
      readSignals.get('snapshot').aborted,
      false,
      'The snapshot must not abort before the core confirms cancellation',
    )
    assert.equal(disconnects, 0)
    acknowledgement.resolve(new Response(JSON.stringify({ result: null })))
    await cancellation
    await Promise.all([stopped, snapshotStopped])
    assert.equal(readSignals.get('sync-plan').aborted, true)
    assert.equal(readSignals.get('snapshot').aborted, true)
    assert.equal(disconnects, 0, 'An intentional read abort is not a broken local-core connection')
    assert.deepEqual(await client.bridge.runtime(), nativeRuntime)
    assert.equal(sessions, 1, 'Cancellation must keep the existing authenticated session usable')
    assert.deepEqual(methods.slice(0, 2).sort(), ['snapshot', 'sync-plan'])
    assert.deepEqual(
      methods.slice(2),
      ['cancel', 'runtime'],
      'Cancelled reads must never be replayed or executed',
    )
  })

  await test('Expired browser sessions require a fresh connection and Git validation errors keep the session', async () => {
    let sessions = 0,
      requests = 0,
      disconnects = 0
    const client = createLocalCoreClient(
      async (url) => {
        if (url.endsWith('/session')) {
          sessions++
          return new Response(JSON.stringify({ token: 'c'.repeat(64), protocol: 1 }))
        }
        requests++
        if (requests === 1)
          return new Response(JSON.stringify({ error: 'expired' }), { status: 401 })
        if (requests === 2)
          return new Response(JSON.stringify({ error: '请选择本地分支' }), { status: 400 })
        return new Response(JSON.stringify({ result: nativeRuntime }))
      },
      'http://localhost:43187',
      () => {
        disconnects++
      },
    )
    await assert.rejects(client.bridge.runtime(), /连接已失效/)
    assert.equal(requests, 1)
    await assert.rejects(client.bridge.runtime(), /请选择本地分支/)
    assert.equal(sessions, 2)
    assert.equal(disconnects, 1)
    await client.bridge.runtime()
    assert.equal(sessions, 2)
  })

  await test('Commit availability explains empty workspace, staged files, missing message and operation lock', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore())
    store.selectedCommit = null
    store.commitMessage = 'A useful commit'
    store.repo.staged = [{ path: 'readme.md', status: 'M' }]
    useWorktreeStore().update(store.repo.path, { mode: 'staging' })
    const render = () => renderToString(createSSRApp(Inspector).use(pinia))
    const check = async (reason, disabled = true) => {
      const html = await render()
      const button = html.match(/<button[^>]*class="primary-button commit-button"[^>]*>/)[0]
      assert.equal(/\bdisabled\b/.test(button), disabled)
      assert.match(button, /aria-describedby="commit-hint"/)
      assert.ok(html.includes(reason), reason)
    }
    store.tabs[0].kind = 'new'
    await check('请先打开仓库工作区')
    store.tabs[0].kind = 'repository'
    store.repo.staged = []
    await check('先将需要提交的文件加入暂存区')
    store.repo.staged = [{ path: 'readme.md', status: 'M' }]
    store.commitMessage = '  '
    await check('填写提交说明后即可提交')
    store.commitMessage = 'A useful commit'
    await check('提交全部已暂存内容，不受勾选或筛选影响', false)
    const previousUnstaged = store.repo.unstaged
    store.repo.unstaged = [{ path: 'conflict.txt', status: 'U' }]
    await check('请先解决冲突并暂存，再创建提交')
    store.repo.unstaged = previousUnstaged
    store.busy = true
    await check('请等待当前操作完成')
    useWorktreeStore().update(store.repo.path, { mode: 'selection' })
  })

  await test('Commit commands reject hidden history, every GitFlow panel and modal before reaching Git', async () => {
    const store = freshStore(),
      live = { ...structuredClone(fixture), path: '/tmp/visible-commit', name: 'visible-commit' }
    const writes = []
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'action') {
        writes.push(args.request)
        return { outcome: 'succeeded', output: 'committed', snapshot: structuredClone(live) }
      }
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    store.commitMessage = 'Keep this draft until visible submission'
    store.selectedCommit = store.repo.commits[0]
    assert.equal(await store.run('commit', { message: store.commitMessage }), false)
    assert.match(store.commitContextBlocked, /工作区/)
    store.selectedCommit = null
    store.selectedStash = {
      oid: 'b'.repeat(40),
      ref: 'stash@{0}',
      message: 'On main: Draft',
      branch: 'main',
      date: '',
      base: live.head,
    }
    assert.equal(await store.run('commit', { message: store.commitMessage }), false)
    assert.match(store.commitContextBlocked, /工作区/)
    store.selectedStash = null
    for (const panel of ['overview', 'settings', 'start', 'finish']) {
      store.gitflowPanel = panel
      assert.equal(await store.run('commit', { message: store.commitMessage }), false, panel)
      assert.match(store.commitContextBlocked, /GitFlow/)
    }
    store.gitflowPanel = null
    store.modal = 'help'
    assert.equal(await store.run('commit', { message: store.commitMessage }), false)
    assert.equal(writes.length, 0)
    assert.equal(store.commitMessage, 'Keep this draft until visible submission')
    store.modal = null
    assert.equal(await store.run('commit', { message: store.commitMessage }), true)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].action, 'commit')
  })

  await test('Notification bursts remain bounded and successful feedback cannot replace all errors', () => {
    const store = freshStore()
    store.notify('error one', true)
    store.notify('error two', true)
    store.notify('error three', true)
    store.notify('success must not erase errors')
    assert.deepEqual(
      store.notices.map((notice) => notice.text),
      ['error one', 'error two', 'error three'],
    )
    store.notify('error four', true)
    assert.equal(store.notices.length, 3)
    assert.ok(store.notices.every((notice) => notice.error))
    assert.equal(store.notices.at(-1).text, 'error four')
    store.notices = []
    store.notify('important error', true)
    for (let i = 0; i < 8; i++) store.notify(`success ${i}`)
    assert.equal(store.notices.length, 3)
    assert.ok(store.notices.some((notice) => notice.error && notice.text === 'important error'))
  })

  await test('Sidebar group order can move, persists, respects bounds and repairs malformed preferences', () => {
    const key = 'gitcode.sidebar-sections',
      previous = storage.get(key)
    try {
      storage.delete(key)
      freshStore()
      const prefs = useSidebarStore()
      assert.deepEqual([...prefs.order], ['gitflow', 'local', 'remote', 'tag'])
      assert.equal(prefs.move('gitflow', -1), false)
      assert.equal(prefs.move('tag', 1), false)
      assert.equal(prefs.move('tag', -1), true)
      freshStore()
      assert.deepEqual([...useSidebarStore().order], ['gitflow', 'local', 'tag', 'remote'])
      useSidebarStore().reset()
      assert.deepEqual(JSON.parse(storage.get(key)), ['gitflow', 'local', 'remote', 'tag'])
      assert.deepEqual(normalizeSidebarOrder(['tag', 'unknown', 'tag', null, 'local']), [
        'tag',
        'local',
        'gitflow',
        'remote',
      ])
      storage.set(key, '{invalid-json')
      freshStore()
      assert.deepEqual([...useSidebarStore().order], ['gitflow', 'local', 'remote', 'tag'])
    } finally {
      if (previous === undefined) storage.delete(key)
      else storage.set(key, previous)
    }
  })

  await test('Sidebar natural sorting is independent of Git enumeration and current-branch changes', () => {
    const source = ['feature/task10', 'feature/task2', 'feature/task1'].map((name, index) => ({
      name,
      current: index === 0,
    }))
    assert.deepEqual(
      sortSidebarBranches(source).map((branch) => branch.name),
      ['feature/task1', 'feature/task2', 'feature/task10'],
    )
    assert.deepEqual(
      source.map((branch) => branch.name),
      ['feature/task10', 'feature/task2', 'feature/task1'],
    )
    source.forEach((branch) => {
      branch.current = !branch.current
    })
    assert.deepEqual(
      sortSidebarBranches([...source].reverse()).map((branch) => branch.name),
      ['feature/task1', 'feature/task2', 'feature/task10'],
    )
    assert.deepEqual(
      sortSidebarBranches([{ name: 'v10' }, { name: 'v2' }]).map((branch) => branch.name),
      ['v2', 'v10'],
    )
  })

  await test('Remote tree groups remotes, pins once, sorts numeric paths and preserves full branch identities', () => {
    const names = [
      'upstream/main',
      'origin/feature/dev10',
      'origin/feature/dev2',
      'origin/feature/team/task',
      'origin/main',
      'team/company/topic',
    ]
    const branches = names.map((name) => ({
      name,
      fullRef: `refs/remotes/${name}`,
      kind: 'remote',
      current: false,
    }))
    const pinned = 'refs/remotes/origin/feature/dev10'
    const groups = remoteBranchGroups(
      branches,
      ['upstream', 'origin', 'empty', 'team/company'],
      [pinned],
    )
    assert.deepEqual(
      groups.map((group) => group.remote),
      ['origin', 'empty', 'team/company', 'upstream'],
    )
    assert.equal(groups[0].favorites[0].branch, branches[1])
    assert.equal(groups[0].favorites[0].label, 'feature/dev10')
    const feature = groups[0].children.find((node) => node.label === 'feature')
    assert.deepEqual(
      feature.children.map((node) => node.label),
      ['dev2', 'team'],
    )
    assert.equal(feature.children[0].branch, branches[2])
    assert.equal(groups[0].count, 4)
    assert.equal(groups[1].count, 0)
    assert.equal(groups[2].children[0].label, 'topic')
    const filtered = remoteBranchGroups(branches, ['origin'], [pinned], 'name-asc', 'dev2')
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].children[0].children[0].branch, branches[2])
    const ordinary = remoteBranchGroups(branches, [], [], 'name-desc')[0].children.find(
      (node) => node.label === 'feature',
    )
    assert.deepEqual(
      ordinary.children.map((node) => node.label),
      ['team', 'dev10', 'dev2'],
    )
    const alias = {
      ...branches[4],
      name: 'origin/HEAD',
      fullRef: 'refs/remotes/origin/HEAD',
      symbolicTarget: 'refs/remotes/origin/main',
    }
    assert.equal(remoteBranchGroups([alias], [], []).length, 0)
  })
  await test('Remote directory preference and collapse state persist per repository without changing other branches', () => {
    const key = 'gitcode.branch-preferences',
      previous = storage.get(key)
    try {
      freshStore()
      const sidebar = useSidebarStore()
      assert.equal(sidebar.groupDirectories('/tree-test'), true)
      sidebar.toggleGroupDirectories('/tree-test')
      sidebar.toggleDirectoryCollapsed(
        '/tree-test',
        JSON.stringify(['remote', 'origin', 'feature']),
      )
      assert.equal(sidebar.groupDirectories('/other'), true)
      freshStore()
      const restored = useSidebarStore()
      assert.equal(restored.groupDirectories('/tree-test'), false)
      assert.equal(
        restored.collapsedDirectories(
          '/tree-test',
          JSON.stringify(['remote', 'origin', 'feature']),
        ),
        true,
      )
      restored.toggleGroupDirectories('/tree-test')
      assert.equal(
        restored.collapsedDirectories(
          '/tree-test',
          JSON.stringify(['remote', 'origin', 'feature']),
        ),
        true,
      )
    } finally {
      if (previous === undefined) storage.delete(key)
      else storage.set(key, previous)
    }
  })

  await test('Directory trees scope local, GitFlow and tag folders independently and keep current-first sorting', () => {
    const branches = ['feature/task10', 'feature/task2', 'main'].map((name, index) => ({
      name,
      kind: 'local',
      fullRef: `refs/heads/${name}`,
      current: index === 1,
    }))
    const local = branchDirectoryTree(branches, ['local'], [], 'current-first')
    const flow = branchDirectoryTree(branches, ['gitflow'], [], 'current-first')
    assert.equal(local.children[0].label, 'feature')
    assert.equal(local.children[0].children[0].branch, branches[1])
    assert.notEqual(local.children[0].key, flow.children[0].key)
    assert.equal(
      branchDirectoryTree([{ name: 'versions/v2', kind: 'tag' }], ['tag'], []).children[0].label,
      'versions',
    )
  })

  await test('Legacy remote display preferences migrate to navigation-wide settings with isolated folder keys', () => {
    const key = 'gitcode.branch-preferences',
      previous = storage.get(key)
    try {
      storage.set(
        key,
        JSON.stringify({
          '/legacy': {
            remoteTree: false,
            remoteCollapsed: [JSON.stringify(['origin', 'feature'])],
          },
        }),
      )
      freshStore()
      const sidebar = useSidebarStore()
      assert.equal(sidebar.groupDirectories('/legacy'), false)
      assert.equal(
        sidebar.collapsedDirectories('/legacy', JSON.stringify(['remote', 'origin', 'feature'])),
        true,
      )
      assert.equal(
        sidebar.collapsedDirectories('/legacy', JSON.stringify(['local', 'feature'])),
        false,
      )
      assert.equal(sidebar.groupDirectories('/other'), true)
    } finally {
      if (previous === undefined) storage.delete(key)
      else storage.set(key, previous)
    }
  })

  await test('Sidebar reorder menu remains a UI preference and disables the top boundary', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      menu = useContextMenuStore(),
      prefs = useSidebarStore()
    prefs.reset()
    menu.target = {
      kind: 'section',
      section: 'gitflow',
      repo: store.repo.path,
      tabId: store.activeTabId,
      head: store.repo.head,
      currentBranch: store.repo.branch,
    }
    const context = {}
    await renderToString(createSSRApp(ContextMenu).use(pinia), context)
    const html = context.teleports.body
    assert.match(html, /GitFlow分组 右键菜单/)
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    const up = buttons.find((button) => button[2].includes('上移分组'))
    const down = buttons.find((button) => button[2].includes('下移分组'))
    assert.match(up[1], /\bdisabled\b/)
    assert.doesNotMatch(down[1], /\bdisabled\b/)
    assert.ok(html.includes('恢复默认分组顺序'))
    assert.equal(store.modal, null)
    assert.equal(store.busy, false)
  })

  await test('Sidebar renders one explicit hierarchy while preserving full refs and shared branch identity', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      beforeHead = store.repo.head
    store.repo.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: '',
      },
      signature: 'sidebar-fixture',
      ready: true,
      configured: true,
      missing: [],
      error: '',
      writeError: '',
    }
    store.repo.branches = ['feature/task10', 'main', 'feature/task2', 'develop'].map((name) => ({
      name,
      kind: 'local',
      fullRef: `refs/heads/${name}`,
      hash: beforeHead,
      current: name === 'main',
      upstream: '',
      track: '',
    }))
    const original = store.repo.branches.map((branch) => branch.name)
    const html = await renderToString(createSSRApp(Sidebar).use(pinia))
    assert.deepEqual(
      [...html.matchAll(/data-sidebar-section="([^"]+)"/g)].map((match) => match[1]),
      ['gitflow', 'local', 'remote', 'tag'],
    )
    const local = html.match(
      /<section[^>]*data-sidebar-section="local"[^>]*>([\s\S]*?)<\/section>/,
    )[1]
    assert.deepEqual(
      [...local.matchAll(/data-branch-name="([^"]+)"/g)].map((match) => match[1]),
      ['develop', 'feature/task2', 'feature/task10', 'main'],
    )
    const workflow = html.match(
      /<section[^>]*data-sidebar-section="gitflow"[^>]*>([\s\S]*?)<\/section>/,
    )[1]
    assert.match(workflow, /data-branch-name="main"[^>]*data-depth="1"/)
    assert.match(workflow, /data-branch-name="feature\/task2"[^>]*data-depth="2"/)
    assert.match(workflow, /<span(?:\s[^>]*)?>task2<\/span>/)
    assert.ok(workflow.includes('单击筛选 feature/task2'))
    assert.deepEqual(
      store.repo.branches.map((branch) => branch.name),
      original,
    )
    assert.equal(store.repo.head, beforeHead)
  })

  function flowWorkspace(suffix) {
    const store = freshStore()
    store.repo.path = `/tmp/flow-${suffix}`
    store.connected = true
    store.runtime = { ...nativeRuntime }
    store.repo.staged = []
    store.repo.unstaged = []
    store.repo.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: '',
      },
      signature: 'configuration-1',
      configured: true,
      ready: true,
      missing: [],
      error: '',
      writeError: '',
    }
    return { store, flow: useGitFlowStore() }
  }

  function flowInitWorkspace(suffix) {
    const { store, flow } = flowWorkspace(suffix)
    store.repo.branches = store.repo.branches.filter((branch) => branch.name !== 'develop')
    store.repo.gitflow.ready = false
    store.repo.gitflow.missing = ['develop']
    flow.open('settings')
    flow.sourceChoices.develop = 'refs/heads/main'
    return { store, flow }
  }

  await test('Unconfigured GitFlow gates task entry but leaves saving and missing-branch recovery reachable', async () => {
    const { store, flow } = flowWorkspace('entry-unconfigured')
    store.repo.gitflow.configured = false
    store.repo.gitflow.ready = false
    flow.open()
    assert.match(flow.startEntryBlocked, /配置并保存/)
    flow.open('start')
    assert.equal(flow.panel, 'overview')
    flow.open('finish')
    assert.equal(flow.panel, 'overview')
    const html = await renderToString(createSSRApp(GitFlowPanel).use(getActivePinia()))
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    assert.match(buttons.find((button) => button[2].includes('开始新分支'))[1], /\bdisabled\b/)
    assert.doesNotMatch(
      buttons.find((button) => button[2].includes('配置 GitFlow'))[1],
      /\bdisabled\b/,
    )
    assert.ok(html.includes('确认时会同时保存规则'))
    flow.open('settings')
    assert.equal(flow.panel, 'settings')
    assert.equal(flow.saveBlocked, '')
    assert.match(flow.previewBlocked, /无需创建/)
    let calls = 0
    nativeHandler = async () => {
      calls++
    }
    await flow.previewInit()
    assert.equal(calls, 0)
    flow.config.develop = 'integration'
    assert.deepEqual([...flow.missing], ['integration'])
    assert.match(flow.previewBlocked, /起点/)
    flow.sourceChoices.integration = 'refs/heads/develop'
    assert.equal(flow.previewBlocked, '')
  })

  await test('Dirty worktrees and read-only rules do not block preparing Start or viewing plans', async () => {
    const { store, flow } = flowWorkspace('entry-dirty')
    store.repo.unstaged = [{ path: 'draft.txt', status: 'M' }]
    flow.open('start')
    assert.equal(flow.panel, 'start')
    assert.equal(flow.startEntryBlocked, '')
    flow.name = 'prepared-work'
    assert.equal(flow.startBlocked, '')
    store.repo.unstaged = []
    store.repo.gitflow.writeError = '规则来自全局配置，只能读取'
    assert.equal(flow.startEntryBlocked, '')
    assert.equal(flow.startBlocked, '')
    flow.open('settings')
    flow.config.versionTag = 'v'
    assert.match(flow.saveBlocked, /只能读取/)
    store.repo.gitflow.operationError = '仓库有未完成的合并'
    flow.open('start')
    assert.equal(flow.panel, 'start')
    assert.match(flow.startBlocked, /未完成/)
    assert.equal(flow.finishEntryBlocked, '')
    flow.open('finish')
    assert.equal(flow.panel, null)
    assert.equal(store.modal, 'gitflow-finish')
  })

  await test('Disconnected GitFlow stops cached execution and green readiness until connection and state are rechecked', async () => {
    const { store, flow } = flowWorkspace('entry-disconnected')
    flow.open()
    const connected = await renderToString(createSSRApp(GitFlowPanel).use(getActivePinia()))
    assert.match(
      connected,
      /class="[^"]*\bonline\b[^"]*\bconnection-dot\b|class="[^"]*\bconnection-dot\b[^"]*\bonline\b/,
    )
    store.connected = false
    assert.equal(flow.requiresRecheck, true)
    assert.match(flow.startEntryBlocked, /未连接/)
    assert.match(flow.finishEntryBlocked, /未连接/)
    assert.match(flow.saveBlocked, /未连接/)
    const html = await renderToString(createSSRApp(GitFlowPanel).use(getActivePinia()))
    assert.ok(html.includes('本机核心未连接 · 规则状态待核对'))
    assert.doesNotMatch(
      html,
      /class="[^"]*\bonline\b[^"]*\bconnection-dot\b|class="[^"]*\bconnection-dot\b[^"]*\bonline\b/,
    )
    assert.ok(html.includes('连接并核对'))
    const methods = []
    nativeHandler = async (method) => {
      methods.push(method)
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return JSON.parse(JSON.stringify(store.repo))
      throw new Error('Unexpected mutation')
    }
    store.connected = true
    assert.match(flow.startEntryBlocked, /需要核实/)
    store.connected = false
    await flow.recheck()
    assert.equal(store.connected, true)
    assert.equal(flow.requiresRecheck, false)
    assert.equal(flow.startEntryBlocked, '')
    assert.deepEqual(methods, ['runtime', 'snapshot'])
  })

  await test('Finish without candidates is blocked independently of a valid Start entry', () => {
    const { store, flow } = flowWorkspace('entry-no-candidates')
    store.repo.branches = store.repo.branches.filter(
      (branch) => branch.kind !== 'local' || ['main', 'develop'].includes(branch.name),
    )
    flow.open()
    assert.equal(flow.startEntryBlocked, '')
    assert.match(flow.finishEntryBlocked, /暂无可完成/)
    flow.open('finish')
    assert.equal(flow.panel, 'overview')
    flow.open('start')
    assert.equal(flow.panel, 'start')
    store.runtime.gitAvailable = false
    assert.match(flow.startEntryBlocked, /Git 不可用/)
    assert.match(flow.startBlocked, /Git 不可用/)
  })

  await test('Missing develop repair goes from the targeted settings entry through real Git without touching dirty files', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'gitcode-repair-ui-'))
    const repo = path.join(root, 'project'),
      git = new GitService()
    t.after(async () => {
      await git.shutdown()
      await rm(root, { recursive: true, force: true })
    })
    await git.create({ kind: 'init', path: repo, url: '' })
    for (const [key, value] of [
      ['user.name', 'Repair test'],
      ['user.email', 'repair@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await git.git(repo, ['config', key, value])
    await writeFile(path.join(repo, 'hello.txt'), 'initial\n')
    await writeFile(path.join(repo, 'staged.txt'), 'initial\n')
    await git.git(repo, ['add', '.'])
    await git.git(repo, ['commit', '-m', 'initial'])
    await git.git(repo, ['branch', '-m', 'master'])
    const initial = await git.snapshot(repo),
      head = initial.head
    const saved = await git.action(repo, {
      action: 'gitflow-save',
      expectedHead: head,
      expectedBranch: 'master',
      signature: initial.gitflow.signature,
      config: initial.gitflow.config,
    })
    assert.equal(saved.outcome, 'succeeded', saved.error)
    assert.equal(saved.snapshot.gitflow.configured, true)
    assert.equal(saved.snapshot.gitflow.ready, false)
    await writeFile(path.join(repo, 'hello.txt'), 'keep unstaged\n')
    await writeFile(path.join(repo, 'staged.txt'), 'keep staged\n')
    await git.git(repo, ['add', 'staged.txt'])
    await writeFile(path.join(repo, 'draft.txt'), 'keep untracked\n')
    const beforeStatus = await git.git(repo, ['status', '--porcelain=v1', '-z'])
    const beforeIndex = await git.indexFingerprint(repo)
    const store = freshStore(),
      actions = []
    let previews = 0
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return git.runtime()
      if (method === 'snapshot') return git.job((signal) => git.snapshot(args.repo, signal))
      if (method === 'gitflow-plan') {
        previews++
        return git.job((signal) => git.flow.plan(args.repo, args.request, signal))
      }
      if (method === 'action') {
        actions.push(args.request.action)
        return git.job((signal) => git.action(args.repo, args.request, signal))
      }
      throw new Error(`Unexpected ${method}`)
    }
    assert.equal(await store.open(repo), true)
    const flow = useGitFlowStore()
    flow.open()
    assert.deepEqual([...flow.state.missing], ['develop'])
    const beforeFocusRequest = flow.settingsFocusRequest
    flow.openInitialization()
    assert.equal(flow.panel, 'settings')
    assert.equal(flow.settingsTarget, 'initialization')
    assert.ok(flow.settingsFocusRequest > beforeFocusRequest)
    assert.match(flow.previewBlocked, /起点/)
    await flow.previewInit()
    assert.equal(previews, 0)
    flow.sourceChoices.develop = 'refs/heads/master'
    assert.equal(flow.previewBlocked, '')
    await flow.previewInit()
    assert.equal(previews, 1)
    assert.deepEqual(
      flow.plan.creates.map((item) => [item.name, item.sourceRef, item.oid]),
      [['develop', 'refs/heads/master', head]],
    )
    assert.equal(flow.confirmBlocked, '')
    assert.equal(await flow.execute('gitflow-init'), true)
    assert.deepEqual(actions, ['gitflow-init'])
    assert.equal(flow.state.ready, true)
    assert.deepEqual([...flow.state.missing], [])
    assert.equal(store.repo.branch, 'master')
    assert.equal(store.repo.head, head)
    assert.equal((await git.git(repo, ['rev-parse', 'refs/heads/develop'])).trim(), head)
    assert.equal(await git.git(repo, ['status', '--porcelain=v1', '-z']), beforeStatus)
    assert.equal(await git.indexFingerprint(repo), beforeIndex)
    assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'keep unstaged\n')
    assert.equal(await readFile(path.join(repo, 'draft.txt'), 'utf8'), 'keep untracked\n')
    const html = await renderToString(createSSRApp(GitFlowPanel).use(getActivePinia()))
    assert.ok(html.includes('开始新分支…'))
    flow.open('start')
    assert.equal(flow.panel, 'start')
    flow.name = 'after-repair'
    assert.equal(flow.startBlocked, '')
  })

  await test('Reopening branch repair does not request focus for an old save result', async () => {
    const { store, flow } = flowInitWorkspace('repair-old-result')
    store.repo.gitflow.configured = false
    flow.open('settings')
    nativeHandler = async (method) => {
      assert.equal(method, 'action')
      const next = JSON.parse(JSON.stringify(store.repo))
      next.gitflow.configured = true
      return { outcome: 'succeeded', output: 'saved', snapshot: next }
    }
    assert.equal(await flow.execute('gitflow-save'), true)
    const previousRequest = flow.resultFocusRequest
    assert.ok(previousRequest > 0)
    flow.open()
    flow.openInitialization()
    assert.equal(flow.settingsTarget, 'initialization')
    assert.equal(flow.resultFocusRequest, previousRequest)
    assert.equal(flow.visibleResult.output, 'saved')
  })

  await test('GitFlow settings preserve ordered labels, accessible help and conflict/init actions in the compact layout', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      flow = useGitFlowStore()
    store.repo.branches = store.repo.branches.filter((branch) => branch.name !== 'develop')
    flow.open('settings')
    flow.config.feature = 'mine/'
    flow.configConflicts = ['feature']
    flow.legacyConfig = { ...flow.config, feature: 'old/' }
    const html = await renderToString(createSSRApp(GitFlowPanel).use(pinia))
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    assert.equal(new Set(ids).size, ids.length)
    for (const match of html.matchAll(/aria-describedby="([^"]+)"/g))
      for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), id)
    const ordered = ['production', 'develop', 'feature', 'release', 'hotfix', 'versionTag'].map(
      (key) => html.indexOf(`id="flow-${key}"`),
    )
    assert.ok(
      ordered.every(
        (position, index) => position >= 0 && (!index || position > ordered[index - 1]),
      ),
    )
    assert.equal((html.match(/class="gitflow-rule-group"/g) || []).length, 2)
    for (const text of [
      '基础分支',
      '命名前缀',
      '字段说明',
      '采用仓库规则',
      '保留我的修改',
      '采用这份旧草稿',
      '初始化基础分支',
      '预览初始化',
    ])
      assert.ok(html.includes(text), text)
    assert.ok(html.includes('id="flow-source-develop"'))
    assert.ok(html.indexOf('保存规则</button>') < html.indexOf('初始化基础分支</h3>'))
  })

  await test('GitFlow toolbar refresh never reclassifies untouched rules as user edits', async () => {
    const { store, flow } = flowWorkspace('toolbar-refresh-audit')
    flow.open('settings')
    const updated = JSON.parse(JSON.stringify(store.repo))
    updated.gitflow.signature = 'external-2'
    updated.gitflow.config.feature = 'external/'
    nativeHandler = async () => updated
    await store.refresh()
    assert.equal(flow.config.feature, 'external/')
    assert.equal(flow.dirtyConfig, false)
    assert.equal(flow.stale, true)
    await flow.recheck()
    assert.equal(flow.dirtyConfig, false)
    assert.equal(flow.stale, false)
    assert.equal(flow.saveBlocked, '规则没有变化。')
  })

  await test('GitFlow same-field conflicts require an explicit choice and never save automatically', async () => {
    const { store, flow } = flowWorkspace('three-way-audit')
    flow.open('settings')
    flow.config.feature = 'mine/'
    let updated = JSON.parse(JSON.stringify(store.repo)),
      writes = 0
    updated.gitflow.signature = 'external-2'
    updated.gitflow.config.feature = 'theirs/'
    updated.gitflow.config.versionTag = 'v'
    nativeHandler = async (method) => {
      if (method === 'action') writes++
      return updated
    }
    await store.refresh()
    await flow.recheck()
    assert.equal(flow.config.feature, 'mine/')
    assert.equal(flow.config.versionTag, 'v')
    assert.deepEqual([...flow.configConflicts], ['feature'])
    assert.match(flow.saveBlocked, /冲突/)
    assert.match(flow.previewBlocked, /冲突/)
    flow.resolveConflict('feature', 'repository')
    assert.equal(flow.config.feature, 'theirs/')
    assert.equal(flow.dirtyConfig, false)
    flow.config.feature = 'mine-again/'
    updated = JSON.parse(JSON.stringify(store.repo))
    updated.gitflow.signature = 'external-3'
    updated.gitflow.config.feature = 'theirs-again/'
    await flow.recheck()
    assert.deepEqual([...flow.configConflicts], ['feature'])
    flow.resolveConflict('feature', 'draft')
    assert.equal(flow.config.feature, 'mine-again/')
    assert.equal(flow.state.config.feature, 'theirs-again/')
    assert.equal(flow.saveBlocked, '')
    assert.equal(writes, 0)
  })

  await test('GitFlow restarted v2 drafts restore actual edits without reviving stale untouched rules', () => {
    const suffix = 'restart-v2-audit'
    const first = flowWorkspace(suffix)
    first.flow.open('start')
    first.flow.name = 'unfinished-name'
    first.flow.close()
    const next = flowWorkspace(suffix)
    next.store.repo.gitflow.config.feature = 'external/'
    next.store.repo.gitflow.signature = 'external-2'
    next.flow.open('settings')
    assert.equal(next.flow.name, 'unfinished-name')
    assert.equal(next.flow.config.feature, 'external/')
    assert.equal(next.flow.dirtyConfig, false)
    assert.equal(next.flow.restartNotice, true)
    assert.equal(next.flow.plan, null)
  })

  await test('GitFlow legacy config is a pending candidate and requires explicit adoption', () => {
    const { store, flow } = flowWorkspace('legacy-audit')
    const legacy = { ...store.repo.gitflow.config, feature: 'old/' }
    storage.set(
      'gitcode.gitflow-draft:/tmp/flow-legacy-audit',
      JSON.stringify({ config: legacy, name: 'legacy-name', type: 'feature', switchAfter: true }),
    )
    store.repo.gitflow.config.feature = 'current/'
    flow.open('settings')
    assert.equal(flow.name, 'legacy-name')
    assert.equal(flow.config.feature, 'current/')
    assert.equal(flow.legacyConfig.feature, 'old/')
    assert.equal(flow.dirtyConfig, false)
    flow.resolveLegacy(true)
    assert.equal(flow.config.feature, 'old/')
    assert.equal(flow.legacyConfig, null)
    assert.equal(flow.saveBlocked, '')
  })

  await test('GitFlow collapsed and cross-tab sessions preserve frozen source and partial diagnostics', async () => {
    const { store, flow } = flowWorkspace('session-audit')
    const tab = store.activeTabId
    flow.open('start')
    flow.name = 'partially-created'
    const frozen = flow.sourceOid
    nativeHandler = async () => ({
      outcome: 'partial',
      output: '',
      warning: 'partially-created 已创建，切换失败',
      snapshot: JSON.parse(JSON.stringify(store.repo)),
    })
    await flow.execute('gitflow-start')
    store.repo.branches.find((b) => b.name === 'develop').hash = 'c'.repeat(40)
    flow.close()
    flow.open('start')
    assert.equal(flow.sourceOid, frozen)
    assert.equal(flow.stale, true)
    assert.equal(flow.visibleResult.outcome, 'partial')
    flow.open('settings')
    assert.equal(flow.visibleResult, null)
    assert.match(flow.result.warning, /已创建/)
    store.newTab()
    await nextTick()
    store.activateTab(tab)
    await nextTick()
    flow.open('start')
    assert.equal(flow.name, 'partially-created')
    assert.equal(flow.sourceOid, frozen)
    assert.match(flow.visibleResult.warning, /已创建/)
    nativeHandler = async () => {
      throw new Error('read failed')
    }
    await flow.recheck()
    assert.equal(flow.requiresRecheck, true)
    assert.match(flow.visibleResult.warning, /已创建/)
  })

  await test('GitFlow checks the clock at confirmation even if the expiry timer has not run', async () => {
    const { flow } = flowInitWorkspace('clock-jump-audit')
    const originalNow = Date.now,
      deadline = Date.now() + 30000
    flow.plan = {
      id: 'unfired-timer',
      config: { ...flow.config },
      creates: [{ name: 'develop', sourceRef: 'refs/heads/main', oid: flow.capturedHead }],
      retained: ['main'],
      expiresAt: deadline,
    }
    assert.equal(flow.confirmBlocked, '')
    let calls = 0
    nativeHandler = async () => {
      calls++
    }
    try {
      Date.now = () => deadline + 1
      assert.equal(await flow.execute('gitflow-init'), false)
      assert.equal(calls, 0)
      assert.equal(flow.planExpired, true)
    } finally {
      Date.now = originalNow
      flow.close()
    }
  })

  await test('GitFlow rejects reserved HEAD as a base but accepts HEAD within a work branch', () => {
    const { flow } = flowWorkspace('head-audit')
    flow.open('settings')
    flow.config.production = 'HEAD'
    assert.ok(flow.configError)
    assert.ok(flow.saveBlocked)
    flow.resetConfig()
    flow.open('start')
    flow.name = 'HEAD'
    assert.equal(flow.startBlocked, '')
  })

  await test('GitFlow default rules can be saved before configuration exists', async () => {
    const { store, flow } = flowWorkspace('defaults-button')
    store.repo.gitflow.configured = false
    store.repo.gitflow.ready = false
    flow.open('settings')
    assert.equal(flow.dirtyConfig, false)
    assert.equal(flow.saveBlocked, '')
    let calls = 0
    nativeHandler = async (_method, value) => {
      calls++
      assert.equal(value.request.action, 'gitflow-save')
      return {
        outcome: 'succeeded',
        output: 'saved',
        snapshot: {
          ...JSON.parse(JSON.stringify(store.repo)),
          gitflow: { ...store.repo.gitflow, configured: true, ready: true },
        },
      }
    }
    assert.equal(await flow.execute('gitflow-save'), true)
    assert.equal(calls, 1)
    assert.equal(flow.saveBlocked, '规则没有变化。')
  })

  await test('GitFlow buttons reject branch namespace conflicts before submitting a plan or Start', () => {
    const { store, flow } = flowWorkspace('namespace-buttons')
    store.repo.branches.push({
      ...store.repo.branches[0],
      name: 'feature/login',
      fullRef: 'refs/heads/feature/login',
      current: false,
      kind: 'local',
    })
    flow.open('start')
    flow.name = 'login/child'
    assert.match(flow.startBlocked, /目录冲突/)
    flow.open('settings')
    flow.config.develop = 'feature'
    flow.config.feature = 'work/'
    assert.match(flow.previewBlocked, /目录冲突/)
  })

  await test('GitFlow store guards invalid form submissions without an IPC call', async () => {
    const { flow } = flowWorkspace('invalid-buttons')
    flow.open('settings')
    flow.config.hotfix = 'feature/nested/'
    let calls = 0
    nativeHandler = async () => {
      calls++
      throw new Error('Should not reach Git')
    }
    assert.match(flow.saveBlocked, /重叠/)
    assert.equal(await flow.execute('gitflow-save'), false)
    await flow.previewInit()
    assert.equal(flow.plan, null)
    flow.resetConfig()
    flow.open('start')
    for (const name of ['has space', 'a..b', '-option', 'a//b', 'a.lock', 'x@{y']) {
      flow.name = name
      assert.ok(flow.startBlocked, name)
      assert.equal(await flow.execute('gitflow-start'), false)
    }
    assert.equal(calls, 0)
  })

  await test('GitFlow plan expiry disables confirmation before the backend is called', async () => {
    const { flow } = flowInitWorkspace('expired-button')
    flow.plan = {
      id: 'expires-soon',
      config: { ...flow.config },
      creates: [{ name: 'develop', sourceRef: 'refs/heads/main', oid: flow.capturedHead }],
      retained: ['main'],
      expiresAt: Date.now() + 15,
    }
    assert.equal(flow.confirmBlocked, '')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(flow.planExpired, true)
    assert.match(flow.confirmBlocked, /过期/)
    let calls = 0
    nativeHandler = async () => {
      calls++
    }
    assert.equal(await flow.execute('gitflow-init'), false)
    assert.equal(calls, 0)
    flow.close()
  })

  await test('GitFlow navigation, type toggles and reset cannot silently renew stale targets', async () => {
    const { store, flow } = flowWorkspace('stale-buttons')
    flow.open('start')
    flow.name = 'frozen'
    const oid = flow.sourceOid
    store.repo.branches.find((b) => b.name === 'develop').hash = 'b'.repeat(40)
    flow.open('settings')
    flow.open('start')
    assert.equal(flow.sourceOid, oid)
    flow.type = 'hotfix'
    flow.type = 'feature'
    assert.equal(flow.sourceOid, oid)
    assert.equal(flow.stale, true)
    store.repo.head = 'c'.repeat(40)
    flow.resetConfig()
    assert.equal(flow.name, 'frozen')
    assert.equal(flow.stale, true)
    let calls = 0
    nativeHandler = async () => {
      calls++
    }
    assert.equal(await flow.execute('gitflow-start'), false)
    assert.equal(calls, 0)
  })

  await test('GitFlow clean unfinished operations block Start and initialization but allow editing rules', () => {
    const { store, flow } = flowWorkspace('unfinished-buttons')
    store.repo.gitflow.operationError = '仓库有未完成的合并，请先完成或中止。'
    flow.open('start')
    flow.name = 'blocked'
    assert.match(flow.startBlocked, /未完成/)
    flow.open('settings')
    assert.match(flow.previewBlocked, /未完成/)
    flow.config.versionTag = 'v'
    assert.equal(flow.saveBlocked, '')
  })

  await test('GitFlow recheck updates clean rules but preserves edited drafts', async () => {
    const { store, flow } = flowWorkspace('refresh-buttons')
    flow.open('settings')
    const snapshot = JSON.parse(JSON.stringify(store.repo))
    snapshot.gitflow.signature = 'configuration-2'
    snapshot.gitflow.config.feature = 'next/'
    nativeHandler = async () => snapshot
    await flow.recheck()
    assert.equal(flow.config.feature, 'next/')
    flow.config.feature = 'my-draft/'
    const newer = JSON.parse(JSON.stringify(snapshot))
    newer.gitflow.signature = 'configuration-3'
    newer.gitflow.config.feature = 'newer/'
    nativeHandler = async () => newer
    await flow.recheck()
    assert.equal(flow.config.feature, 'my-draft/')
    assert.equal(flow.state.config.feature, 'newer/')
    assert.equal(flow.dirtyConfig, true)
  })

  await test('GitFlow save with failed snapshot preserves Start draft and history selection', async () => {
    const { store, flow } = flowWorkspace('save-refresh-failure')
    flow.open('settings')
    flow.config.versionTag = 'v'
    flow.name = 'keep-start-draft'
    store.selectedCommit = store.repo.commits[0]
    const selected = store.selectedCommit.hash
    nativeHandler = async () => ({
      outcome: 'succeeded',
      output: 'saved',
      snapshot: null,
      refreshError: 'failed to read snapshot',
    })
    assert.equal(await flow.execute('gitflow-save'), true)
    assert.equal(flow.name, 'keep-start-draft')
    assert.equal(store.selectedCommit.hash, selected)
    assert.equal(flow.config.versionTag, 'v')
    assert.equal(flow.requiresRecheck, true)
    assert.ok(flow.saveBlocked)
  })

  await test('GitFlow Start sends one frozen contextual operation without changing history selection', async () => {
    const { store, flow } = flowWorkspace('start')
    flow.open('start')
    const sourceOid = store.repo.branches.find((b) => b.name === 'develop').hash
    const head = store.repo.head,
      branch = store.repo.branch
    flow.name = 'login'
    store.setBranchFilter(store.repo.branches.find((b) => b.kind === 'local' && b.name === 'main'))
    let sent
    nativeHandler = async (method, value) => {
      assert.equal(method, 'action')
      sent = value
      return {
        outcome: 'succeeded',
        output: '已创建 feature/login；尚未推送',
        snapshot: JSON.parse(JSON.stringify(store.repo)),
      }
    }
    assert.equal(await flow.execute('gitflow-start'), true)
    assert.equal(sent.repo, '/tmp/flow-start')
    assert.deepEqual(sent.request, {
      action: 'gitflow-start',
      expectedHead: head,
      expectedBranch: branch,
      signature: 'configuration-1',
      type: 'feature',
      name: 'login',
      sourceOid,
      switchAfter: true,
    })
    assert.equal(flow.name, '')
    assert.equal(flow.result.outcome, 'succeeded')
  })

  await test('GitFlow drafts survive collapse and reopening without crossing repository paths', async () => {
    const { store, flow } = flowWorkspace('draft-one')
    flow.open('settings')
    flow.config.feature = 'work/'
    flow.name = 'saved-draft'
    flow.close()
    flow.open('settings')
    assert.equal(flow.config.feature, 'work/')
    assert.equal(flow.name, 'saved-draft')
    assert.equal(flow.draftRestored, true)
    flow.type = 'hotfix'
    flow.switchAfter = false
    flow.close()
    store.repo.path = '/tmp/flow-draft-two'
    flow.open('start')
    assert.equal(flow.name, '')
    assert.equal(flow.config.feature, 'feature/')
    assert.equal(flow.type, 'feature')
    assert.equal(flow.switchAfter, true)
    flow.close()
    store.repo.path = '/tmp/flow-draft-one'
    flow.open('start')
    assert.equal(flow.name, 'saved-draft')
  })

  await test('GitFlow initialization preview is invalidated by any rule or source change', async () => {
    const { flow } = flowInitWorkspace('plan')
    let sent
    nativeHandler = async (method, value) => {
      assert.equal(method, 'gitflow-plan')
      sent = value
      return {
        id: 'plan-id',
        config: value.request.config,
        creates: [{ name: 'develop', sourceRef: 'refs/heads/main', oid: flow.capturedHead }],
        retained: ['main'],
        expiresAt: Date.now() + 10000,
      }
    }
    await flow.previewInit()
    assert.equal(flow.plan.id, 'plan-id')
    assert.equal(sent.request.signature, 'configuration-1')
    flow.config.versionTag = 'v'
    assert.equal(flow.plan, null)
    await flow.previewInit()
    flow.sourceChoices = { develop: 'refs/heads/feature/workspace' }
    assert.equal(flow.plan, null)
  })

  await test('GitFlow partial Start keeps input and exposes uncertainty instead of a completed result', async () => {
    const { store, flow } = flowWorkspace('partial')
    flow.open('start')
    flow.name = 'login'
    nativeHandler = async () => ({
      outcome: 'partial',
      output: '',
      warning: '分支已创建但切换失败，请检查',
      snapshot: JSON.parse(JSON.stringify(store.repo)),
    })
    assert.equal(await flow.execute('gitflow-start'), false)
    assert.equal(flow.result.outcome, 'partial')
    assert.equal(flow.name, 'login')
    assert.match(flow.error, /已创建/)
  })

  await test('GitFlow Finish opens an executable confirmation bound to the chosen branch, not a preview panel', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      flow = useGitFlowStore()
    store.connected = true
    store.runtime = { ...nativeRuntime }
    store.repo.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: '',
      },
      signature: 'finish-ready',
      configured: true,
      ready: true,
      missing: [],
      error: '',
      writeError: '',
      finishSupported: true,
      finish: null,
    }
    const candidate = store.repo.branches.find(
      (branch) => branch.kind === 'local' && branch.name.startsWith('feature/'),
    )
    const before = store.repo.branch
    flow.open('finish', candidate?.name)
    assert.equal(flow.panel, null)
    assert.equal(store.modal, 'gitflow-finish')
    assert.equal(store.repo.branch, before)
    assert.equal(store.busy, false)
    const { useGitFlowFinishStore } = await vite.ssrLoadModule('/src/stores/gitflowFinish.ts')
    const finish = useGitFlowFinishStore()
    assert.equal(finish.canChooseBranch, !candidate)
    assert.equal(finish.deleteBranch, true)
    assert.equal(finish.createTag, false)
  })

  await test('GitFlow Finish allows automatic protection of local edits while retaining conflict gates', async () => {
    const { store } = flowWorkspace('finish-dirty-protection')
    store.repo.gitflow.finishSupported = true
    store.repo.branches.push({
      name: 'feature/dirty-finish',
      kind: 'local',
      fullRef: 'refs/heads/feature/dirty-finish',
      hash: store.repo.head,
      current: false,
      upstream: '',
      track: '',
    })
    store.repo.unstaged = [
      { path: 'draft.txt', status: 'M' },
      { path: 'new.txt', status: '?' },
    ]
    const { useGitFlowFinishStore } = await vite.ssrLoadModule('/src/stores/gitflowFinish.ts')
    const finish = useGitFlowFinishStore()
    finish.open('feature/dirty-finish')
    assert.equal(finish.blocked, '')
    store.repo.merge = { active: true }
    assert.match(finish.blocked, /合并/)
    store.repo.merge = null
    store.repo.gitflow.operationError = '仓库有未完成的拣选'
    assert.match(finish.blocked, /拣选/)
  })

  await test('GitFlow panel closes on tab change and never applies an old draft to a new tab', async () => {
    const { store, flow } = flowWorkspace('switch')
    flow.open('start')
    flow.name = 'original'
    store.newTab()
    await nextTick()
    assert.equal(flow.panel, null)
    assert.equal(flow.plan, null)
    flow.open('start')
    assert.equal(flow.panel, null)
  })

  await test('GitCode migrates recent repositories once without reviving removed old entries', () => {
    const previousNew = storage.get('gitcode.recent'),
      previousOld = storage.get('gitk.recent')
    try {
      storage.delete('gitcode.recent')
      storage.set('gitk.recent', JSON.stringify(['/tmp/old-repository']))
      const migrated = freshStore()
      assert.deepEqual([...migrated.recent], ['/tmp/old-repository'])
      assert.deepEqual(JSON.parse(storage.get('gitcode.recent')), ['/tmp/old-repository'])
      migrated.forgetRecent('/tmp/old-repository')
      assert.deepEqual([...freshStore().recent], [])
      assert.deepEqual(JSON.parse(storage.get('gitk.recent')), ['/tmp/old-repository'])
    } finally {
      if (previousNew === undefined) storage.delete('gitcode.recent')
      else storage.set('gitcode.recent', previousNew)
      if (previousOld === undefined) storage.delete('gitk.recent')
      else storage.set('gitk.recent', previousOld)
    }
  })

  await test('Exit draft summary includes inactive repositories and excludes new-tab stale fields', () => {
    const store = freshStore()
    store.commitMessage = 'active draft'
    assert.equal(store.draftTabs.length, 1)
    store.newTab()
    assert.equal(store.isNewTab, true)
    assert.equal(store.draftTabs.length, 1)
    assert.equal(store.draftTabs[0].name, 'GitCode')
    store.activateTab(store.tabs[0].id)
    assert.equal(store.commitMessage, 'active draft')
    store.commitMessage = ''
    store.commitDescription = ''
    assert.equal(store.draftTabs.length, 0)
  })

  await test('Four application menus share named commands and checked column state', () => {
    const menus = buildMenus({
      enabled: ['file.open', 'file.recent.0', 'view.sha'],
      recent: ['repo'],
      author: false,
      time: false,
      sha: true,
    })
    assert.deepEqual(
      menus.map((menu) => menu.id),
      ['file', 'edit', 'view', 'help'],
    )
    assert.equal(menus[0].items.find((item) => item.id === 'file.open').enabled, true)
    assert.equal(menus[0].items.find((item) => item.id === 'file.closeTab').enabled, false)
    assert.equal(
      menus[0].items.find((item) => item.id === 'file.recent').children[0].id,
      'file.recent.0',
    )
    assert.equal(menus[2].items.find((item) => item.id === 'view.sha').checked, true)
    assert.equal(
      menus[1].items.some((item) => item.id.startsWith('git.')),
      false,
    )
  })

  await test('Context menus freeze the right-click target without selecting or switching it', () => {
    const store = freshStore()
    const menu = useContextMenuStore()
    const originalDocument = globalThis.document
    const originalMouse = globalThis.MouseEvent
    let prevented = 0,
      stopped = 0,
      focusCount = 0
    class Pointer {
      clientX = 1400
      clientY = 900
      currentTarget = {
        closest: () => ({ dataset: { navigationKey: 'local-develop' } }),
        isConnected: true,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 30 }),
        focus: () => {
          focusCount++
        },
      }
      preventDefault() {
        prevented++
      }
      stopPropagation() {
        stopped++
      }
    }
    globalThis.document = { querySelector: () => null }
    globalThis.MouseEvent = Pointer
    try {
      const branch = store.repo.branches.find((b) => b.name === 'develop')
      const selected = store.selectedCommit
      menu.open(new Pointer(), { kind: 'branch', branch })
      assert.equal(menu.target.branch.name, 'develop')
      assert.equal(menu.target.navigationSource, 'local-develop')
      assert.equal(menu.target.repo, store.repo.path)
      assert.equal(menu.target.tabId, store.activeTabId)
      assert.equal(menu.target.head, store.repo.head)
      assert.equal(store.repo.branch, 'main')
      assert.equal(store.selectedCommit, selected)
      branch.name = 'changed-after-opening'
      assert.equal(menu.target.branch.name, 'develop')
      assert.equal(prevented, 1)
      assert.equal(stopped, 1)
      menu.close()
      assert.equal(menu.target, null)
      assert.equal(focusCount, 1)
      const event = {
        key: 'F10',
        shiftKey: true,
        currentTarget: new Pointer().currentTarget,
        preventDefault: () => {},
        stopPropagation: () => {},
      }
      menu.keyboard(event, { kind: 'background' })
      assert.equal(menu.target.kind, 'background')
      assert.equal(menu.x, 110)
      assert.equal(menu.y, 48)
      menu.close(false)
      assert.equal(focusCount, 1)
    } finally {
      globalThis.document = originalDocument
      globalThis.MouseEvent = originalMouse
    }
  })

  await test('Reference badges combine only configured upstreams at the same commit', () => {
    const commit = {
      ...fixture.commits[0],
      hash: 'tip',
      refs: ['HEAD -> main', 'origin/main', 'tag: main'],
    }
    const local = {
      ...fixture.branches[0],
      name: 'main',
      hash: 'tip',
      current: true,
      upstream: 'origin/main',
      kind: 'local',
    }
    const remote = { ...local, name: 'origin/main', current: false, upstream: '', kind: 'remote' }
    const tag = {
      ...local,
      name: 'main',
      hash: 'tag-object',
      commitHash: 'tip',
      current: false,
      upstream: '',
      kind: 'tag',
    }
    const refs = resolveCommitReferences(commit, [remote, tag, local]),
      groups = groupCommitReferences(refs)
    assert.equal(refs.length, 3)
    assert.equal(groups.length, 2)
    assert.deepEqual(
      groups[0].members.map((ref) => ref.key),
      ['refs/heads/main', 'refs/remotes/origin/main'],
    )
    assert.equal(groups[0].primary.branch, local)
    assert.equal(groups[0].current, true)
    assert.equal(groups[1].primary.branch, tag)
    assert.equal(
      groupCommitReferences(
        resolveCommitReferences(commit, [{ ...local, upstream: '' }, remote, tag]),
      ).length,
      3,
    )
    assert.equal(
      resolveCommitReferences(commit, [local, { ...remote, hash: 'other-tip' }]).filter(
        (ref) => ref.kind === 'remote',
      ).length,
      0,
    )
  })

  await test('Reference grouping consumes each full identity once, even when two locals share an upstream', () => {
    const commit = { ...fixture.commits[0], hash: 'tip', refs: [] }
    const make = (name, kind, extra = {}) => ({
      ...fixture.branches[0],
      name,
      kind,
      hash: 'tip',
      current: false,
      upstream: '',
      ...extra,
    })
    const current = make('topic', 'local', { current: true, upstream: 'origin/topic' })
    const other = make('another', 'local', { upstream: 'origin/topic' })
    const sameNameLocal = make('origin/topic', 'local')
    const remote = make('origin/topic', 'remote')
    const refs = resolveCommitReferences(commit, [sameNameLocal, remote, other, current])
    const groups = groupCommitReferences([...refs].reverse())
    assert.equal(groups[0].primary.branch, current)
    assert.equal(groups[0].members[1].branch, remote)
    const keys = groups.flatMap((group) => group.members.map((ref) => ref.key))
    assert.equal(keys.length, refs.length)
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.includes('refs/heads/origin/topic'))
    assert.ok(keys.includes('refs/remotes/origin/topic'))
  })

  await test('Reference resolution hides only remote HEAD aliases and leaves unresolved references read-only', () => {
    const commit = {
      ...fixture.commits[0],
      hash: 'tip',
      refs: ['feature/HEAD', 'tag: release/HEAD', 'origin/HEAD', 'missing-reference'],
    }
    const branches = [
      { ...fixture.branches[0], name: 'feature/HEAD', hash: 'tip', kind: 'local', current: false },
      {
        ...fixture.branches[0],
        name: 'release/HEAD',
        hash: 'tag-object',
        commitHash: 'tip',
        kind: 'tag',
        current: false,
      },
      {
        ...fixture.branches[0],
        name: 'origin/HEAD',
        hash: 'tip',
        kind: 'remote',
        current: false,
        symbolicTarget: 'refs/remotes/origin/main',
      },
      {
        ...fixture.branches[0],
        name: 'origin/feature/HEAD',
        hash: 'tip',
        kind: 'remote',
        current: false,
        symbolicTarget: '',
      },
    ]
    const refs = resolveCommitReferences(commit, branches)
    assert.ok(refs.some((ref) => ref.key === 'refs/heads/feature/HEAD'))
    assert.ok(refs.some((ref) => ref.key === 'refs/tags/release/HEAD'))
    assert.ok(!refs.some((ref) => ref.key === 'refs/remotes/origin/HEAD'))
    assert.ok(refs.some((ref) => ref.key === 'refs/remotes/origin/feature/HEAD'))
    const unknown = refs.find((ref) => ref.label === 'missing-reference')
    assert.equal(unknown.kind, 'unknown')
    assert.equal(unknown.branch, undefined)
    assert.equal(unknown.current, false)
  })

  await test('Graph references resolve remote branches without assuming origin', () => {
    const remote = {
      ...fixture.branches[0],
      name: 'team/upstream/feature/login',
      fullRef: 'refs/remotes/team/upstream/feature/login',
      current: false,
      kind: 'remote',
    }
    assert.equal(referenceBranch([remote], remote.name, remote.hash), remote)
    assert.equal(referenceBranch(fixture.branches, 'HEAD -> main', fixture.head)?.kind, 'local')
    assert.equal(referenceBranch(fixture.branches, 'unknown', fixture.head), undefined)
  })

  await test('Column choices respect explicit overrides and restore responsive defaults', () => {
    const store = freshStore()
    store.updateViewport(1440)
    assert.equal(store.showAuthor, false)
    assert.equal(store.showTime, false)
    store.updateViewport(1920)
    assert.equal(store.showAuthor, true)
    assert.equal(store.showTime, true)
    store.showAuthor = false
    store.showSha = true
    store.updateViewport(1440)
    store.updateViewport(1920)
    assert.equal(store.showAuthor, false)
    assert.equal(store.showTime, true)
    store.resetColumns()
    assert.equal(store.showAuthor, true)
    assert.equal(store.showSha, false)
  })

  await test('Application starts on the repository hub with no fabricated workbench or history', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useRepositoryStore()
    assert.equal(store.isNewTab, true)
    assert.equal(store.repo.path, '')
    assert.deepEqual(store.repo.commits, [])
    assert.deepEqual(store.repo.branches, [])
    const html = await renderToString(createSSRApp(App).use(pinia))
    for (const text of ['新标签页', '打开仓库', '克隆仓库', '创建仓库'])
      assert.ok(html.includes(text), text)
    assert.ok(!html.includes('class="workbench"'))
    assert.ok(!html.includes('演示'))
  })

  await test('DAG edges end at their actual parent commit nodes, including merges', () => {
    const graph = buildGraph(fixture.commits)
    assert.equal(graph.nodes.length, fixture.commits.length)
    assert.equal(
      graph.edges.length,
      fixture.commits.reduce((sum, commit) => sum + commit.parents.length, 0),
    )
    let edgeIndex = 0
    for (const commit of fixture.commits) {
      for (const parent of commit.parents) {
        const edge = graph.edges[edgeIndex++]
        const node = graph.nodes.find((n) => n.hash === parent)
        assert.ok(node)
        assert.equal(edge.childHash, commit.hash)
        assert.equal(edge.parentHash, parent)
        // Read SVG endpoints independently of whether a route is straight or rounded.
        let end = { x: 0, y: 0 }
        for (const [, command, raw] of edge.d.matchAll(/([MHVQ])([^MHVQ]*)/g)) {
          const numbers = raw.trim().split(/[ ,]+/).map(Number)
          if (command === 'M') end = { x: numbers[0], y: numbers[1] }
          else if (command === 'H') end.x = numbers[0]
          else if (command === 'V') end.y = numbers[0]
          else if (command === 'Q') end = { x: numbers.at(-2), y: numbers.at(-1) }
        }
        assert.deepEqual(end, { x: node.x, y: node.y })
        assert.equal(edge.boundary, false)
      }
    }
  })

  await test('Cross-lane ancestry uses rounded turns between rows for both directions', () => {
    const commits = [
      { ...fixture.commits[0], hash: 'worktree', parents: ['head'] },
      { ...fixture.commits[0], hash: 'feature-a', parents: ['base'] },
      { ...fixture.commits[0], hash: 'feature-b', parents: ['base'] },
      { ...fixture.commits[0], hash: 'head', parents: ['base'] },
      { ...fixture.commits[0], hash: 'base', parents: [] },
    ]
    const graph = buildGraph(commits, 0),
      nodes = new Map(graph.nodes.map((node) => [node.hash, node]))
    const turns = graph.edges.filter((edge) => edge.d.includes(' Q'))
    assert.ok(turns.some((edge) => nodes.get(edge.childHash).x > nodes.get(edge.parentHash).x))
    assert.ok(turns.some((edge) => nodes.get(edge.childHash).x < nodes.get(edge.parentHash).x))
    for (const edge of turns) {
      const child = nodes.get(edge.childHash)
      assert.ok(edge.d.includes(' H'))
      assert.ok(!edge.d.includes(' C'))
      for (const [, values] of edge.d.matchAll(/Q([^MHVQ]*)/g)) {
        const coords = values.trim().split(/[ ,]+/).map(Number)
        for (const y of [coords[1], coords[3]]) assert.ok(y > child.y && y < child.y + 30)
      }
    }
  })

  await test('Search with missing parents uses boundary stubs without growing lanes', () => {
    const commits = Array.from({ length: 250 }, (_, i) => ({
      ...fixture.commits[0],
      hash: `node-${i}`,
      parents: [`missing-${i}`],
    }))
    const graph = buildGraph(commits)
    assert.equal(graph.width, 116)
    assert.ok(graph.edges.every((edge) => edge.boundary))
  })

  await test('Changing HEAD preserves every commit lane, color and ancestry route', () => {
    const commits = [
      { ...fixture.commits[0], hash: 'other-branch', parents: ['base'] },
      { ...fixture.commits[0], hash: 'head', parents: ['base'] },
      { ...fixture.commits[0], hash: 'base', parents: [] },
    ]
    const baseline = buildGraph(commits)
    for (const head of ['other-branch', 'head', 'base']) {
      const graph = buildHistoryGraph(
        commits.map((commit) => ({
          ...commit,
          refs: commit.hash === head ? ['HEAD -> current'] : [],
        })),
      )
      assert.deepEqual(graph.nodes, baseline.nodes)
      assert.deepEqual(graph.edges, baseline.edges)
      assert.equal(graph.worktree.color, 'var(--accent)')
      assert.equal(graph.worktree.x, 24)
      assert.equal(graph.width, baseline.width)
    }
  })

  await test('Worktree remains independent in filtered and empty histories', () => {
    const commits = [
      { ...fixture.commits[0], hash: 'other-branch', parents: ['head'] },
      { ...fixture.commits[0], hash: 'head', parents: ['missing'] },
    ]
    const graph = buildHistoryGraph(commits)
    assert.equal(graph.worktree.x, 24)
    assert.deepEqual(graph.edges, buildGraph(commits).edges)
    assert.ok(graph.edges.every((edge) => edge.childHash !== '__worktree__'))
    assert.equal(graph.nodes[0].y, 45)
    const empty = buildHistoryGraph([])
    assert.deepEqual(empty.nodes, [])
    assert.deepEqual(empty.edges, [])
    assert.equal(empty.worktree.y, 15)
  })

  await test('Selected commit requires explicit partial-file confirmation and consumes a plan once', async () => {
    const store = freshStore()
    store.connected = true
    store.commitMessage = 'Selected files'
    store.commitDescription = 'Keep until success'
    const paths = ['partial.txt'],
      actions = []
    nativeHandler = async (method, args) => {
      if (method === 'selected-commit-plan')
        return {
          id: 'selected-plan',
          paths,
          files: [{ path: paths[0], status: 'M', partialStaged: true }],
          partialPaths: paths,
          selectedCount: 1,
          scope: 'working-tree',
          expiresAt: Date.now() + 60000,
        }
      if (method === 'action') {
        actions.push(args)
        return { snapshot: structuredClone(fixture), output: '', outcome: 'succeeded' }
      }
    }
    const plan = await store.prepareSelectedCommit(paths)
    assert.equal(plan.id, 'selected-plan')
    assert.equal(await store.commitSelected(plan.id), false)
    assert.equal(actions.length, 0)
    assert.equal(store.commitDescription, 'Keep until success')
    assert.equal(await store.commitSelected(plan.id, true), true)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].request.action, 'commit-selected')
    assert.equal(actions[0].request.confirmPartial, true)
    assert.equal(store.commitMessage, '')
    assert.equal(await store.commitSelected(plan.id, true), false)
    assert.equal(actions.length, 1)
  })

  await test('Selected commit rejects changed repository context and discards cancelled preparation', async () => {
    const store = freshStore()
    store.connected = true
    const paths = ['a.txt']
    const plan = {
      id: 'bound-plan',
      paths,
      files: [],
      partialPaths: [],
      selectedCount: 1,
      scope: 'working-tree',
      expiresAt: Date.now() + 60000,
    }
    let actions = 0
    nativeHandler = async (method) => {
      if (method === 'selected-commit-plan') return plan
      if (method === 'action') actions++
    }
    await store.prepareSelectedCommit(paths)
    store.repo = { ...store.repo, path: '/different-repository' }
    assert.equal(await store.commitSelected(plan.id), false)
    assert.equal(actions, 0)
    const pending = deferred()
    nativeHandler = async (method) =>
      method === 'selected-commit-plan' ? pending.promise : undefined
    const preparing = store.prepareSelectedCommit(paths)
    await store.cancelOperation()
    pending.resolve(plan)
    assert.equal(await preparing, null)
    assert.equal(store.busy, false)
    assert.equal(await store.commitSelected(plan.id), false)
  })

  await test('Full worktree diff keeps its source across refresh and tab navigation', async () => {
    const store = freshStore()
    store.connected = true
    const file = { path: 'partial.txt', status: 'M' }
    const snapshot = {
      ...structuredClone(fixture),
      path: '/full-worktree-diff',
      staged: [file],
      unstaged: [file],
    }
    store.repo = snapshot
    const reads = []
    nativeHandler = async (method, args) => {
      if (method === 'diff') {
        reads.push(args)
        return { diff: 'full diff', truncated: false }
      }
      if (method === 'snapshot') return structuredClone(snapshot)
    }
    await store.selectWorktreeFile(file)
    await store.refresh()
    assert.equal(reads.length, 2)
    assert.ok(reads.every((args) => args.staged === 'working'))
    assert.equal(store.fileDiffSource, 'working')
    const tab = store.activeTabId
    store.newTab()
    store.activateTab(tab)
    assert.equal(store.fileDiffSource, 'working')
    store.closeDiff()
    assert.equal(store.fileDiffSource, null)
  })

  await test('Branch filtering follows ancestry; text search filters author and SHA', () => {
    const store = freshStore()
    store.setBranchFilter(
      store.repo.branches.find((b) => b.kind === 'local' && b.name === 'feature/commit-graph'),
    )
    const hashes = new Set(store.visibleCommits.map((commit) => commit.hash))
    assert.ok(hashes.has(fixture.commits[2].hash))
    assert.ok(hashes.has(fixture.commits.at(-1).hash))
    assert.ok(!hashes.has(fixture.commits[0].hash))
    store.clearBranchFilter()
    store.query = 'LIN WANG'
    assert.ok(store.visibleCommits.length > 0)
    assert.ok(store.visibleCommits.every((commit) => commit.author === 'Lin Wang'))
    store.query = fixture.commits[0].hash
    assert.equal(store.visibleCommits.length, 1)
    assert.equal(store.changes, 7)
  })

  await test('Favorites outrank name and current-first sorting; preferences persist per repository and section', () => {
    freshStore()
    const sidebar = useSidebarStore(),
      repoPath = '/tmp/favorite-sort-a'
    const branches = ['task10', 'task2', 'task1'].map((name, i) => ({
      ...fixture.branches[0],
      name,
      kind: 'local',
      hash: `${i}`,
      current: i === 2,
      fullRef: `refs/heads/${name}`,
    }))
    const names = (section) =>
      sidebar.sortedBranches(repoPath, section, branches).map((b) => b.name)
    assert.deepEqual(names('local'), ['task1', 'task2', 'task10'])
    sidebar.setSort(repoPath, 'local', 'name-desc')
    assert.deepEqual(names('local'), ['task10', 'task2', 'task1'])
    sidebar.toggleFavorite(repoPath, branches[1])
    assert.deepEqual(names('local'), ['task2', 'task10', 'task1'])
    sidebar.setSort(repoPath, 'local', 'current-first')
    assert.deepEqual(names('local'), ['task2', 'task1', 'task10'])
    assert.equal(sidebar.sortMode(repoPath, 'gitflow'), 'name-asc')
    assert.equal(sidebar.isFavorite('/tmp/favorite-sort-b', branches[1]), false)
    assert.equal(
      sidebar.isFavorite(repoPath, { ...branches[1], kind: 'tag', fullRef: 'refs/tags/task2' }),
      false,
    )
    assert.equal(
      sidebar.isFavorite(repoPath, {
        ...branches[1],
        kind: 'remote',
        fullRef: 'refs/remotes/task2',
      }),
      false,
    )
    setActivePinia(createPinia())
    const restored = useSidebarStore()
    assert.equal(restored.isFavorite(repoPath, branches[1]), true)
    assert.equal(restored.sortMode(repoPath, 'local'), 'current-first')
    restored.toggleFavorite(repoPath, branches[1])
    assert.equal(restored.isFavorite(repoPath, branches[1]), false)
    assert.deepEqual(
      restored.sortedBranches(repoPath, 'local', branches).map((b) => b.name),
      ['task1', 'task2', 'task10'],
    )
  })

  await test('Same-named branch and annotated tag filter distinct commit ancestry', () => {
    const store = freshStore()
    store.repo.commits = ['local', 'tagged'].map((hash) => ({
      ...fixture.commits[0],
      hash,
      parents: [],
    }))
    const local = {
      ...fixture.branches[0],
      name: 'develop',
      kind: 'local',
      fullRef: 'refs/heads/develop',
      hash: 'local',
      commitHash: 'local',
    }
    const tag = {
      ...local,
      kind: 'tag',
      fullRef: 'refs/tags/develop',
      hash: 'tag-object',
      commitHash: 'tagged',
    }
    store.repo.branches = [local, tag]
    store.setBranchFilter(local, 'local-entry')
    assert.deepEqual(
      store.visibleCommits.map((c) => c.hash),
      ['local'],
    )
    store.setBranchFilter(tag, 'tag-entry')
    assert.equal(store.branchFilter, 'refs/tags/develop')
    assert.deepEqual(
      store.visibleCommits.map((c) => c.hash),
      ['tagged'],
    )
  })

  await test('Filter entry transfers atomically, explicit filtering never toggles and clear removes both states', () => {
    const store = freshStore(),
      branch = store.repo.branches.find((b) => b.name === 'develop')
    store.setBranchFilter(branch, 'local', true)
    store.setBranchFilter(branch, 'gitflow', true)
    assert.equal(store.sidebarBranchSelection, 'gitflow')
    assert.ok(store.branchFilter)
    store.setBranchFilter(branch, 'local')
    store.setBranchFilter(branch, 'local')
    assert.equal(store.sidebarBranchSelection, 'local')
    store.setBranchFilter(branch) // A graph menu has no sidebar entry.
    assert.equal(store.sidebarBranchSelection, '')
    assert.ok(store.branchFilter)
    store.clearBranchFilter()
    assert.equal(store.branchFilter, '')
    assert.equal(store.sidebarBranchSelection, '')
  })

  await test('Repository tabs restore their own reference filter and source without sharing selection', async () => {
    const store = freshStore()
    nativeHandler = async (method) =>
      method === 'runtime'
        ? nativeRuntime
        : structuredClone({ ...fixture, path: '/tmp/filter-other', name: 'other' })
    const firstId = store.activeTabId,
      first = store.repo.branches.find((b) => b.name === 'develop')
    store.setBranchFilter(first, 'gitflow-entry')
    store.newTab()
    assert.equal(store.branchFilter, '')
    await store.open('/tmp/filter-other')
    const otherId = store.activeTabId
    assert.equal(store.sidebarBranchSelection, '')
    store.setBranchFilter(
      store.repo.branches.find((b) => b.name === 'main'),
      'local-entry',
    )
    store.activateTab(firstId)
    assert.equal(store.branchFilter, 'refs/heads/develop')
    assert.equal(store.sidebarBranchSelection, 'gitflow-entry')
    store.activateTab(otherId)
    assert.equal(store.branchFilter, 'refs/heads/main')
    assert.equal(store.sidebarBranchSelection, 'local-entry')
  })

  await test('Refresh follows moved references and clears removed targets without losing commit drafts', async () => {
    const store = freshStore(),
      live = structuredClone({ ...fixture, path: '/tmp/filter-refresh', name: 'filter-refresh' })
    nativeHandler = async (method) => (method === 'runtime' ? nativeRuntime : structuredClone(live))
    await store.open(live.path)
    const branch = store.repo.branches.find((b) => b.name === 'develop')
    store.setBranchFilter(branch, 'local-entry')
    store.commitMessage = 'keep draft'
    live.branches.find((b) => b.name === 'develop').hash = live.commits.at(-1).hash
    await store.refresh()
    assert.equal(store.sidebarBranchSelection, 'local-entry')
    assert.deepEqual(
      store.visibleCommits.map((c) => c.hash),
      [live.commits.at(-1).hash],
    )
    live.branches = live.branches.filter((b) => b.name !== 'develop')
    await store.refresh()
    assert.equal(store.branchFilter, '')
    assert.equal(store.sidebarBranchSelection, '')
    assert.equal(store.commitMessage, 'keep draft')
    assert.ok(store.notices.some((n) => n.text.includes('原筛选引用已不存在')))
  })

  await test('Failed checkout preserves selected history, reference filter and commit draft', async () => {
    const store = freshStore(),
      live = structuredClone({
        ...fixture,
        path: '/tmp/checkout-failure',
        name: 'checkout-failure',
      })
    nativeHandler = async (command) =>
      command === 'runtime' ? nativeRuntime : structuredClone(live)
    await store.open(live.path)
    const branch = store.repo.branches.find((b) => b.kind === 'local' && b.name === 'develop')
    store.setBranchFilter(branch, 'local-entry')
    store.selectedCommit = store.repo.commits[1]
    store.commitBody = 'Keep historical details'
    store.commitMessage = 'Keep checkout draft'
    const selected = store.selectedCommit.hash
    nativeHandler = async () => ({
      outcome: 'failed',
      error: 'Local changes would be overwritten',
      output: '',
      snapshot: structuredClone(live),
    })
    assert.equal(
      await store.run('checkout', { name: branch.name, expectedOid: branch.hash }),
      false,
    )
    assert.equal(store.repo.branch, 'main')
    assert.equal(store.selectedCommit.hash, selected)
    assert.equal(store.branchFilter, 'refs/heads/develop')
    assert.equal(store.sidebarBranchSelection, 'local-entry')
    assert.equal(store.commitBody, 'Keep historical details')
    assert.equal(store.commitMessage, 'Keep checkout draft')
  })

  await test('Refresh preserves historical details, diff, query and commit draft', async () => {
    const store = freshStore()
    const live = { ...structuredClone(fixture), path: '/tmp/refresh', name: 'refresh' }
    nativeHandler = async (command) => {
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'commit')
        return { files: [{ path: 'src/old.ts', status: 'M' }], body: 'historical details' }
      if (command === 'diff') return { diff: 'historical diff', truncated: false }
      throw new Error(command)
    }
    await store.open(live.path)
    await store.selectCommit(store.repo.commits[2])
    await store.selectFile(store.commitFiles[0])
    const selected = store.selectedCommit.hash
    store.commitMessage = 'keep my draft'
    store.commitDescription = 'keep details'
    store.query = 'graph'
    await store.refresh()
    assert.equal(store.selectedCommit.hash, selected)
    assert.equal(store.selectedFile.path, 'src/old.ts')
    assert.equal(store.diffText, 'historical diff')
    assert.equal(store.commitBody, 'historical details')
    assert.equal(store.commitMessage, 'keep my draft')
    assert.equal(store.commitDescription, 'keep details')
    assert.equal(store.query, 'graph')
  })

  await test('Reopening an existing repository refreshes selected working diff while historical OIDs remain immutable', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/reopen-selected-diff',
        name: 'reopen-selected-diff',
        staged: [],
        unstaged: [{ path: 'working.txt', status: 'M' }],
      }
    let currentDiff = '+before external update'
    const diffReads = []
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'commit')
        return { files: [{ path: 'history.txt', status: 'M' }], body: 'fixed historical body' }
      if (method === 'diff') {
        diffReads.push(args)
        return { diff: args.commit ? '+fixed historical content' : currentDiff, truncated: false }
      }
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    await store.selectFile(live.unstaged[0])
    const originalId = store.activeTabId
    store.newTab()
    currentDiff = '+after external update'
    await store.open(live.path)
    assert.equal(store.activeTabId, originalId)
    assert.equal(store.diffText, '+after external update')
    assert.equal(diffReads.length, 2)
    const historical = store.repo.commits[1]
    await store.selectCommit(historical)
    await store.selectFile(store.commitFiles[0])
    const countBeforeReopen = diffReads.length
    store.newTab()
    live.head = 'f'.repeat(40)
    live.commits = live.commits.filter((commit) => commit.hash !== historical.hash)
    await store.open(live.path)
    assert.equal(store.selectedCommit.hash, historical.hash)
    assert.equal(store.diffText, '+fixed historical content')
    assert.equal(store.commitBody, 'fixed historical body')
    assert.equal(
      diffReads.length,
      countBeforeReopen,
      'A fixed historical OID must not be replaced with the worktree diff',
    )
  })

  await test('Read errors survive tab navigation and explicit retries clear only the corresponding error', async () => {
    const store = freshStore(),
      live = { ...structuredClone(fixture), path: '/tmp/read-errors', name: 'read-errors' }
    let failCommit = true,
      failDiff = true,
      commitReads = 0
    nativeHandler = async (method) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'commit') {
        commitReads++
        if (failCommit) throw new Error('commit details unavailable')
        return { files: [{ path: 'changed.txt', status: 'M' }], body: 'retried commit details' }
      }
      if (method === 'diff') {
        if (failDiff) throw new Error('diff unavailable')
        return { diff: '+retried file content', truncated: false }
      }
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    const originalId = store.activeTabId,
      historical = store.repo.commits[0]
    await store.selectCommit(historical)
    assert.equal(store.commitLoading, false)
    assert.equal(store.commitError, 'commit details unavailable')
    store.newTab()
    store.activateTab(originalId)
    assert.equal(store.commitError, 'commit details unavailable')
    assert.equal(
      commitReads,
      1,
      'Returning to a failed detail must preserve its explicit retry state',
    )
    failCommit = false
    await store.selectCommit(store.selectedCommit)
    assert.equal(store.commitError, '')
    assert.equal(store.commitBody, 'retried commit details')
    await store.selectFile(store.commitFiles[0])
    assert.equal(store.diffLoading, false)
    assert.equal(store.diffError, 'diff unavailable')
    store.newTab()
    store.activateTab(originalId)
    assert.equal(store.diffError, 'diff unavailable')
    assert.equal(store.selectedFile.path, 'changed.txt')
    failDiff = false
    await store.selectFile(store.selectedFile, store.fileStaged)
    assert.equal(store.diffError, '')
    assert.equal(store.diffText, '+retried file content')
    assert.equal(store.commitError, '')
  })

  await test('Cancelling sync preparation discards a late plan and keeps the operation locked until cancellation is acknowledged', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/cancel-preparation',
        name: 'cancel-preparation',
      }
    const plan = deferred(),
      acknowledgement = deferred()
    let actions = 0
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'sync-plan') return plan.promise
      if (method === 'cancel') return acknowledgement.promise
      if (method === 'action') {
        actions++
        throw new Error('Cancelled preparation must not execute')
      }
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    const preparation = store.prepareSync('push')
    assert.equal(store.busy, true)
    assert.equal(store.modal, 'push')
    const cancel = store.cancelOperation()
    assert.equal(store.cancelling, true)
    plan.resolve({
      id: 'late-unused-plan',
      kind: 'push',
      head: live.head,
      branch: live.branch,
      sourceRef: `refs/heads/${live.branch}`,
      destinationRef: `refs/heads/${live.branch}`,
      remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
      expiresAt: Date.now() + 10000,
      remotes: [],
    })
    await nextTick()
    await Promise.resolve()
    assert.equal(store.busy, true, 'A late plan cannot unlock before the cancel acknowledgement')
    assert.equal(store.syncPreview, null)
    acknowledgement.resolve()
    await Promise.all([preparation, cancel])
    assert.equal(store.busy, false)
    assert.equal(store.cancelling, false)
    assert.equal(store.syncPreview, null)
    assert.equal(actions, 0)
    assert.match(store.syncError, /放弃|取消/)
    assert.equal(await store.confirmSync(), false)
  })

  await test('Cancelling a sync retry during snapshot refresh cannot request a new plan when the old snapshot arrives', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/cancel-retry-snapshot',
        name: 'cancel-retry-snapshot',
      }
    const lateSnapshot = deferred(),
      acknowledgement = deferred()
    let snapshots = 0,
      plans = 0,
      actions = 0
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') {
        snapshots++
        return snapshots === 1 ? structuredClone(live) : lateSnapshot.promise
      }
      if (method === 'sync-plan') {
        plans++
        return {
          id: `plan-${plans}`,
          kind: 'push',
          head: live.head,
          branch: live.branch,
          sourceRef: `refs/heads/${live.branch}`,
          destinationRef: `refs/heads/${live.branch}`,
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 10000,
          remotes: [],
        }
      }
      if (method === 'cancel') return acknowledgement.promise
      if (method === 'action') {
        actions++
        throw new Error('No write was approved')
      }
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    await store.prepareSync('push')
    assert.equal(plans, 1)
    const retry = store.retrySync('push')
    assert.equal(store.busy, true)
    assert.equal(snapshots, 2)
    const cancel = store.cancelOperation()
    acknowledgement.resolve()
    await cancel
    assert.equal(store.busy, true, 'The retry snapshot is still unresolved')
    lateSnapshot.resolve(structuredClone(live))
    await retry
    assert.equal(store.busy, false)
    assert.equal(store.syncPreview, null)
    assert.equal(plans, 1, 'A cancelled retry cannot restart sync planning after a late snapshot')
    assert.equal(actions, 0)
  })

  await test('Cancelling an executing push keeps its modal and busy state until the real result is read', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/cancel-executing-push',
        name: 'cancel-executing-push',
      }
    const result = deferred(),
      acknowledgement = deferred()
    nativeHandler = async (method, args) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'sync-plan')
        return {
          id: 'approved-push',
          kind: 'push',
          head: live.head,
          branch: live.branch,
          sourceRef: `refs/heads/${live.branch}`,
          destinationRef: `refs/heads/${live.branch}`,
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 10000,
          remotes: [],
        }
      if (method === 'action') {
        assert.equal(args.request.planId, 'approved-push')
        return result.promise
      }
      if (method === 'cancel') return acknowledgement.promise
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    await store.prepareSync('push')
    const execution = store.confirmSync()
    assert.equal(store.busy, true)
    const cancel = store.cancelOperation()
    acknowledgement.resolve()
    await cancel
    assert.equal(store.busy, true)
    assert.equal(store.modal, 'push')
    result.resolve({
      outcome: 'cancelled',
      error: 'Push cancelled after contacting remote; verify actual state',
      output: '',
      snapshot: { ...structuredClone(live), total: 77 },
    })
    assert.equal(await execution, false)
    assert.equal(store.busy, false)
    assert.equal(store.cancelling, false)
    assert.equal(store.modal, 'push')
    assert.equal(store.syncPreview, null)
    assert.equal(store.repo.total, 77)
    assert.match(store.syncError, /cancelled|核对/)
  })

  await test('Cancelling fetch during plan acquisition never starts the Git action even when cancellation acknowledgement fails', async () => {
    for (const acknowledge of [true, false]) {
      const store = freshStore(),
        live = {
          ...structuredClone(fixture),
          path: `/tmp/cancel-fetch-plan-${acknowledge}`,
          name: 'cancel-fetch-plan',
        }
      const plan = deferred()
      let actions = 0
      nativeHandler = async (method) => {
        if (method === 'runtime') return nativeRuntime
        if (method === 'snapshot') return structuredClone(live)
        if (method === 'sync-plan') return plan.promise
        if (method === 'cancel') {
          if (!acknowledge) throw new Error('cancel acknowledgement unavailable')
          return
        }
        if (method === 'action') {
          actions++
          throw new Error('A cancelled plan cannot authorize execution')
        }
        throw new Error(`Unexpected ${method}`)
      }
      await store.open(live.path)
      const pending = store.run('fetch')
      assert.equal(store.busy, true)
      await store.cancelOperation()
      assert.equal(store.busy, true, 'The original plan has not settled yet')
      if (!acknowledge)
        assert.ok(
          store.notices.some((notice) => notice.error && /取消请求未确认/.test(notice.text)),
        )
      plan.resolve({
        id: 'unused-fetch-plan',
        kind: 'fetch',
        head: live.head,
        branch: live.branch,
        sourceRef: '',
        destinationRef: '',
        remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
        expiresAt: Date.now() + 10000,
        remotes: [],
      })
      assert.equal(await pending, false)
      assert.equal(actions, 0)
      assert.equal(store.busy, false)
      assert.equal(store.repo.head, live.head)
      assert.ok(store.notices.some((notice) => /未开始执行/.test(notice.text)))
    }
  })

  await test('A failed cancellation acknowledgement does not close the push result modal when the actual operation later succeeds', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/cancel-ack-failure-result',
        name: 'cancel-ack-failure-result',
      }
    const result = deferred()
    nativeHandler = async (method) => {
      if (method === 'runtime') return nativeRuntime
      if (method === 'snapshot') return structuredClone(live)
      if (method === 'sync-plan')
        return {
          id: 'approved-push',
          kind: 'push',
          head: live.head,
          branch: live.branch,
          sourceRef: `refs/heads/${live.branch}`,
          destinationRef: `refs/heads/${live.branch}`,
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 10000,
          remotes: [],
        }
      if (method === 'action') return result.promise
      if (method === 'cancel') throw new Error('cancel acknowledgement unavailable')
      throw new Error(`Unexpected ${method}`)
    }
    await store.open(live.path)
    await store.prepareSync('push')
    const executing = store.confirmSync()
    await store.cancelOperation()
    assert.equal(store.cancelling, false)
    assert.equal(store.busy, true)
    result.resolve({
      outcome: 'succeeded',
      output: 'The push actually completed',
      snapshot: { ...structuredClone(live), total: 88 },
    })
    assert.equal(await executing, true, 'Actual success must not be relabelled as cancelled')
    assert.equal(store.modal, 'push')
    assert.equal(store.repo.total, 88)
    assert.match(store.syncError, /已经完成.*核对/)
    assert.equal(store.busy, false)
  })

  await test('Sync confirmation sends the approved plan and retains fresh failure state', async () => {
    const store = freshStore(),
      live = { ...structuredClone(fixture), path: '/tmp/sync', name: 'sync' }
    const calls = []
    nativeHandler = async (command, args) => {
      calls.push({ command, args })
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'sync-plan')
        return {
          id: 'approved',
          kind: args.kind,
          method: 'merge',
          head: live.head,
          branch: live.branch,
          sourceRef: 'refs/heads/main',
          destinationRef: 'refs/heads/main',
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 60000,
          remotes: [{ name: 'origin', address: '/tmp/bare' }],
        }
      if (command === 'action')
        return {
          outcome: 'partial',
          output: '',
          error: 'fetch succeeded, fast-forward failed',
          snapshot: { ...structuredClone(live), total: 99 },
          steps: [{ remote: 'origin', ok: true }],
        }
      throw new Error(command)
    }
    await store.open(live.path)
    store.commitMessage = 'preserve draft'
    await store.prepareSync('pull')
    assert.equal(store.syncPreview.id, 'approved')
    assert.equal(await store.confirmSync(), false)
    const request = calls.find((call) => call.command === 'action').args.request
    assert.equal(request.action, 'pull')
    assert.equal(request.planId, 'approved')
    assert.equal(request.expectedHead, live.head)
    assert.equal(request.expectedBranch, live.branch)
    assert.equal(store.repo.total, 99)
    assert.equal(store.commitMessage, 'preserve draft')
    assert.equal(store.syncPreview, null)
    assert.match(store.syncError, /fast-forward failed/)
    assert.equal(store.busy, false)
  })

  await test('Selected push and retries retain the chosen branch, read fresh OIDs and never fall back to HEAD', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/selected-sync',
        name: 'selected-sync',
        branch: 'main',
        head: 'a'.repeat(40),
      }
    const selected = {
      kind: 'local',
      name: 'feature/topic',
      fullRef: 'refs/heads/feature/topic',
      hash: 'b'.repeat(40),
      current: false,
      upstream: 'origin/feature/topic',
      track: '',
    }
    live.branches = [
      { ...selected, name: 'main', fullRef: 'refs/heads/main', hash: live.head, current: true },
      selected,
    ]
    const plans = [],
      actions = []
    nativeHandler = async (command, args) => {
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'sync-plan') {
        plans.push(args)
        return {
          id: `approved-${plans.length}`,
          kind: args.kind,
          head: args.expected.sourceOid,
          branch: 'feature/topic',
          sourceRef: args.expected.sourceRef,
          destinationRef: 'refs/heads/feature/topic',
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 60000,
          remotes: [{ name: 'origin', address: '/tmp/bare' }],
        }
      }
      if (command === 'action') {
        actions.push(args)
        return {
          outcome: 'failed',
          error: 'remote refused',
          output: '',
          snapshot: structuredClone(live),
        }
      }
      throw new Error(command)
    }
    await store.open(live.path)
    store.commitMessage = 'preserve my main draft'
    await store.prepareSync('push', selected)
    assert.equal(plans[0].expected.sourceRef, selected.fullRef)
    assert.equal(plans[0].expected.sourceOid, selected.hash)
    assert.equal(plans[0].expected.expectedBranch, 'main')
    assert.equal(plans[0].expected.expectedHead, live.head)
    assert.equal(await store.confirmSync(), false)
    await store.fetchBeforePull()
    assert.match(store.syncError, /请先切换到 feature\/topic/)
    assert.equal(
      actions.length,
      1,
      'Updating a non-current pushed branch must not fetch and pull the worktree branch instead',
    )
    assert.equal(plans.length, 1)
    live.branches[1] = { ...selected, hash: 'c'.repeat(40) }
    await store.retrySync('push')
    assert.equal(plans[1].expected.sourceRef, selected.fullRef)
    assert.equal(plans[1].expected.sourceOid, 'c'.repeat(40))
    assert.equal(await store.confirmSync(), false)
    live.branches = live.branches.filter((b) => b.name !== selected.name)
    await store.retrySync('push')
    assert.equal(plans.length, 2)
    assert.equal(actions.length, 2)
    assert.match(store.syncError, /已不存在/)
    assert.equal(store.syncPreview, null)
    assert.equal(store.repo.branch, 'main')
    assert.equal(store.repo.head, live.head)
    assert.equal(store.commitMessage, 'preserve my main draft')
  })

  await test('First publish previews a target, forwards explicit changes and never writes before confirmation', async () => {
    const store = freshStore()
    const live = {
      ...structuredClone(fixture),
      path: '/tmp/publish-target',
      name: 'publish-target',
      branch: 'feature/topic',
    }
    live.branches = [
      {
        ...fixture.branches[0],
        name: 'feature/topic',
        fullRef: 'refs/heads/feature/topic',
        hash: live.head,
        kind: 'local',
        upstream: '',
        track: '',
        current: true,
      },
    ]
    const plans = []
    let writes = 0
    nativeHandler = async (command, args) => {
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'sync-plan') {
        plans.push(args.expected)
        const target = args.expected.publish || { remote: 'origin', branch: 'feature/topic' }
        return {
          id: 'publish-' + plans.length,
          kind: 'push',
          head: live.head,
          branch: live.branch,
          sourceRef: 'refs/heads/feature/topic',
          worktreeBranch: live.branch,
          destinationRef: 'refs/heads/' + target.branch,
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 60000,
          publish: { ...target, remotes: ['origin', 'backup'] },
          remotes: [{ name: target.remote, address: '/test/remote' }],
        }
      }
      if (command === 'action') {
        writes++
        return { outcome: 'succeeded', output: 'published', snapshot: structuredClone(live) }
      }
      throw new Error(command)
    }
    await store.open(live.path)
    await store.prepareSync('push')
    assert.equal(store.syncPreview.publish.remote, 'origin')
    assert.equal(writes, 0)
    await store.setPublishTarget('backup', 'review/topic')
    assert.deepEqual(plans[1].publish, { remote: 'backup', branch: 'review/topic' })
    assert.equal(store.syncPreview.destinationRef, 'refs/heads/review/topic')
    assert.equal(writes, 0)
    const checked = store.syncPreview.remoteCheck
    for (const state of ['error', 'behind', 'diverged']) {
      store.syncPreview.remoteCheck = { state, checkedAt: Date.now() }
      assert.equal(await store.confirmSync(), false)
      assert.equal(writes, 0, `A ${state} check cannot start a push`)
    }
    store.syncPreview.remoteCheck = undefined
    assert.equal(await store.confirmSync(), false)
    store.syncPreview.remoteCheck = checked
    assert.equal(await store.confirmSync(), true)
    assert.equal(writes, 1)
  })

  await test('A legacy core without first publish support explains that it must be restarted', async () => {
    const store = freshStore(),
      live = {
        ...structuredClone(fixture),
        path: '/tmp/no-linked-remote',
        name: 'no-linked-remote',
      }
    live.branches = live.branches.map((branch) => ({ ...branch, upstream: '', track: '' }))
    let actions = 0
    nativeHandler = async (command, args) => {
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'sync-plan')
        throw new Error(
          `分支 ${args.expected.expectedBranch} 尚无明确上游，请先通过 Git 配置上游后重试。`,
        )
      if (command === 'action') {
        actions++
        throw new Error('Must not write')
      }
      throw new Error(command)
    }
    await store.open(live.path)
    await store.prepareSync('push')
    assert.equal(store.modal, 'push')
    assert.match(store.syncError, /尚未关联远端分支/)
    assert.equal(store.syncPreview, null)
    assert.equal(await store.confirmSync(), false)
    assert.equal(actions, 0)
  })

  await test('Selected push refuses a legacy core plan for the current branch before confirmation', async () => {
    const store = freshStore(),
      live = { ...structuredClone(fixture), path: '/tmp/legacy-sync', name: 'legacy-sync' }
    let actions = 0
    nativeHandler = async (command, args) => {
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      if (command === 'sync-plan')
        return {
          id: 'wrong-current-plan',
          kind: args.kind,
          head: live.head,
          branch: live.branch,
          sourceRef: `refs/heads/${live.branch}`,
          destinationRef: `refs/heads/${live.branch}`,
          remoteCheck: { state: 'forward', oid: live.head, checkedAt: Date.now() },
          expiresAt: Date.now() + 60000,
          remotes: [{ name: 'origin', address: '/tmp/bare' }],
        }
      if (command === 'action') {
        actions++
        throw new Error('Must not execute')
      }
      throw new Error(command)
    }
    await store.open(live.path)
    await store.prepareSync('push', {
      kind: 'local',
      name: 'feature/topic',
      fullRef: 'refs/heads/feature/topic',
      hash: 'b'.repeat(40),
      current: false,
      upstream: 'origin/feature/topic',
      track: '',
    })
    assert.equal(store.syncPreview, null)
    assert.match(store.syncError, /重启桌面应用/)
    assert.equal(await store.confirmSync(), false)
    assert.equal(actions, 0)
  })

  await test('Local branch menus distinguish selected push, blocked pull and read-only GitFlow plans', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      menu = useContextMenuStore()
    store.connected = true
    store.runtime = { ...nativeRuntime }
    store.repo.branch = 'main'
    store.repo.gitflow = {
      config: {
        production: 'main',
        develop: 'develop',
        feature: 'feature/',
        release: 'release/',
        hotfix: 'hotfix/',
        versionTag: '',
      },
      signature: 'menu',
      ready: true,
      configured: true,
      missing: [],
      error: '',
      writeError: '',
    }
    const b = {
      name: 'feature/topic',
      kind: 'local',
      fullRef: 'refs/heads/feature/topic',
      hash: store.repo.head,
      current: false,
      upstream: 'origin/feature/topic',
      track: '',
    }
    menu.target = {
      kind: 'branch',
      branch: b,
      repo: store.repo.path,
      tabId: store.activeTabId,
      head: store.repo.head,
      currentBranch: 'main',
    }
    const render = async () => {
      const context = {}
      await renderToString(createSSRApp(ContextMenu).use(pinia), context)
      return context.teleports.body
    }
    const html = await render()
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    const push = buttons.find((button) => button[2].includes('推送'))
    const pull = buttons.find((button) => button[2].includes('拉取'))
    assert.doesNotMatch(push[1], /\bdisabled\b/)
    assert.doesNotMatch(pull[1], /\bdisabled\b/)
    assert.match(html, /aria-label="feature\/topic 右键菜单"/)
    assert.doesNotMatch(html, /context-menu-heading|context-menu-context|当前检出/)
    assert.ok(html.includes('完成 feature/topic'))
    assert.doesNotMatch(html, /查看 GitFlow 完成计划|仅查看计划，暂不执行完成操作/)
    assert.ok(html.indexOf('删除 feature/topic') < html.indexOf('复制分支名'))
    menu.target = { ...menu.target, branch: { ...b, upstream: '' } }
    const noUpstream = await render()
    assert.doesNotMatch(
      [...noUpstream.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((button) =>
        button[2].includes('推送'),
      )[1],
      /\bdisabled\b/,
    )
    assert.doesNotMatch(noUpstream, /无上游|未设置上游/)
  })

  await test('Navigation menus hide impossible actions and replace checkout for occupied worktrees', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore()),
      menu = useContextMenuStore()
    const local = store.repo.branches.find(
      (b) => b.kind === 'local' && b.name === store.repo.branch,
    )
    const target = (branch) => ({
      kind: 'branch',
      branch,
      repo: store.repo.path,
      tabId: store.activeTabId,
      head: store.repo.head,
      currentBranch: store.repo.branch,
    })
    const render = async () => {
      const context = {}
      await renderToString(createSSRApp(ContextMenu).use(pinia), context)
      return context.teleports.body
    }
    menu.target = target(local)
    let html = await render()
    assert.doesNotMatch(html, /切换到 |删除 /)
    assert.match(html, /重命名 /)
    menu.target = target({ ...local, name: 'feature/other', current: false, upstream: '' })
    html = await render()
    assert.match(html, /切换到 |删除 /)
    assert.match(html, /设置上游/)
    assert.doesNotMatch(html, /无上游|未设置上游/)
    store.repo.remotes = []
    html = await render()
    assert.doesNotMatch(html, /推送|拉取|设置上游/)
    assert.match(html, /在此创建分支/)
    menu.target = target({
      ...local,
      name: 'feature/worktree',
      current: false,
      worktreePath: '/tmp/linked',
    })
    html = await render()
    assert.match(html, /打开 feature\/worktree 所在工作区/)
    assert.doesNotMatch(html, /切换到 |删除 |重命名 /)
    store.busy = true
    html = await render()
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    assert.match(buttons.find((b) => b[2].includes('所在工作区'))[1], /disabled/)
    assert.doesNotMatch(buttons.find((b) => b[2].includes('复制分支名'))[1], /disabled/)
  })

  await test('Uncertain commit outcomes retain drafts and show refreshed repository state', async () => {
    const store = freshStore(),
      live = { ...structuredClone(fixture), path: '/tmp/uncertain', name: 'uncertain' }
    nativeHandler = async (command) =>
      command === 'runtime'
        ? nativeRuntime
        : command === 'snapshot'
          ? structuredClone(live)
          : {
              outcome: 'partial',
              output: '',
              error: 'hook rejected',
              warning: 'result needs inspection',
              snapshot: { ...structuredClone(live), total: 42 },
            }
    await store.open(live.path)
    store.commitMessage = 'must retain'
    assert.equal(await store.run('commit', { message: 'must retain' }), false)
    assert.equal(store.commitMessage, 'must retain')
    assert.equal(store.repo.total, 42)
    assert.ok(store.notices.some((notice) => notice.text === 'result needs inspection'))
  })

  await test('Empty workspace mutations open the repository dialog and never call Git', async () => {
    setActivePinia(createPinia())
    const store = useRepositoryStore()
    let requests = 0
    nativeHandler = async () => {
      requests++
      return {}
    }
    assert.equal(await store.run('stage', { paths: ['README.md'] }), false)
    assert.equal(store.modal, 'open')
    await store.selectCommit(fixture.commits[0])
    await store.selectFile({ path: 'README.md', status: 'M' })
    await store.refresh()
    assert.equal(store.selectedCommit, null)
    assert.equal(store.selectedFile, null)
    assert.equal(requests, 0)
  })

  await test('Opening, staging and committing use the Electron preload bridge without HTTP', async () => {
    const store = freshStore()
    const live = { ...structuredClone(fixture), path: '/tmp/live', name: 'live' }
    const requests = []
    nativeHandler = async (command, args) => {
      requests.push({ command, args })
      if (command === 'runtime') return nativeRuntime
      if (command === 'snapshot') return structuredClone(live)
      const payload = args.request
      if (payload.action === 'stage') {
        live.staged.push(live.unstaged.shift())
      }
      if (payload.action === 'commit') live.staged = []
      return { snapshot: structuredClone(live), output: 'ok' }
    }
    assert.equal(await store.open('/tmp/live'), true)
    assert.equal(store.isNewTab, false)
    assert.equal(store.repo.path, '/tmp/live')
    assert.deepEqual(requests[1], { command: 'snapshot', args: { repo: '/tmp/live' } })
    assert.equal(await store.run('stage', { paths: [live.unstaged[0].path] }), true)
    assert.equal(store.repo.staged.length, 3)
    store.commitMessage = 'feat: test'
    assert.equal(await store.run('commit', { message: store.commitMessage }), true)
    assert.equal(store.commitMessage, '')
    assert.equal(store.repo.staged.length, 0)
  })

  await test('API failures preserve the active repository and expose the Git error', async () => {
    const store = freshStore()
    store.connected = true
    nativeHandler = async () => {
      throw '目录不是 Git 仓库'
    }
    assert.equal(await store.open('/tmp/not-a-repo'), false)
    assert.equal(store.isNewTab, false)
    assert.equal(store.repo.name, 'GitCode')
    assert.ok(store.notices.some((n) => n.error && n.text === '目录不是 Git 仓库'))
    assert.equal(store.busy, false)
  })

  await test('Out-of-order diff responses cannot overwrite the latest selection', async () => {
    const store = freshStore()
    const pending = []
    nativeHandler = () => new Promise((resolve) => pending.push(resolve))
    const first = store.selectFile({ path: 'a.txt', status: 'M' })
    const second = store.selectFile({ path: 'b.txt', status: 'M' })
    pending[1]({ diff: '+latest', truncated: false })
    await second
    pending[0]({ diff: '+stale', truncated: false })
    await first
    assert.equal(store.selectedFile.path, 'b.txt')
    assert.equal(store.diffText, '+latest')
    assert.equal(store.diffLoading, false)
  })

  await test('New tab renders repository entry points without displaying a stale workbench', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore())
    store.newTab()
    const html = await renderToString(createSSRApp(App).use(pinia))
    for (const text of ['新标签页', '克隆仓库', '创建仓库', '最近打开', 'Git 官方文档'])
      assert.ok(html.includes(text), text)
    assert.ok(!html.includes('class="workbench"'))
    assert.ok(!html.includes('class="fixture-banner"'))
  })

  await test('Switching repository tabs preserves separate drafts, searches and file selections', async () => {
    const store = freshStore()
    const firstTab = store.activeTabId
    store.commitMessage = 'first draft'
    store.commitDescription = 'first details'
    store.query = 'graph'
    await store.selectFile({ path: 'README.md', status: 'M' }, true)
    store.newTab()
    const newId = store.activeTabId
    assert.equal(store.isNewTab, true)
    nativeHandler = async (command) =>
      command === 'runtime'
        ? nativeRuntime
        : { ...structuredClone(fixture), path: '/tmp/second', name: 'second' }
    assert.equal(await store.open('/tmp/second'), true)
    assert.equal(store.activeTabId, newId)
    assert.equal(store.tabs.length, 2)
    assert.equal(store.isNewTab, false)
    assert.equal(store.commitMessage, '')
    store.commitMessage = 'second draft'
    store.commitDescription = 'second details'
    store.query = 'second search'
    store.activateTab(firstTab)
    assert.equal(store.isNewTab, false)
    assert.equal(store.commitMessage, 'first draft')
    assert.equal(store.commitDescription, 'first details')
    assert.equal(store.query, 'graph')
    assert.equal(store.selectedFile.path, 'README.md')
    assert.equal(store.fileStaged, true)
    store.activateTab(newId)
    assert.equal(store.repo.path, '/tmp/second')
    assert.equal(store.commitMessage, 'second draft')
    assert.equal(store.commitDescription, 'second details')
    assert.equal(store.query, 'second search')
    assert.equal(store.selectedFile, null)
  })

  await test('Sidebar branch queries remain isolated on direct tab switches and after a new-tab round trip', async () => {
    const store = freshStore(),
      firstId = store.activeTabId
    store.sidebarQuery = 'first-repository-branch'
    const live = {
      ...structuredClone(fixture),
      path: '/tmp/sidebar-query-second',
      name: 'sidebar-query-second',
    }
    nativeHandler = async (method) => (method === 'runtime' ? nativeRuntime : structuredClone(live))
    store.newTab()
    await store.open(live.path)
    const secondId = store.activeTabId
    assert.equal(store.sidebarQuery, '')
    store.sidebarQuery = 'second-repository-branch'
    store.activateTab(firstId)
    assert.equal(store.sidebarQuery, 'first-repository-branch')
    store.activateTab(secondId)
    assert.equal(store.sidebarQuery, 'second-repository-branch')
    store.newTab()
    store.activateTab(firstId)
    assert.equal(store.sidebarQuery, 'first-repository-branch')
    store.activateTab(secondId)
    assert.equal(store.sidebarQuery, 'second-repository-branch')
  })

  await test('Closing a draft requires a choice; closing the last tab leaves a usable new page', () => {
    const store = freshStore()
    const id = store.activeTabId
    store.commitMessage = 'unfinished draft'
    store.closeTab(id)
    assert.equal(store.modal, 'close')
    assert.equal(store.tabs.length, 1)
    store.closeTab(id, true)
    assert.equal(store.modal, null)
    assert.equal(store.tabs.length, 1)
    assert.equal(store.isNewTab, true)
    assert.notEqual(store.activeTabId, id)
  })

  await test('Opening an existing repository selects its tab and keeps its draft', async () => {
    const store = freshStore()
    nativeHandler = async (command) =>
      command === 'runtime'
        ? nativeRuntime
        : { ...structuredClone(fixture), path: '/tmp/same', name: 'same' }
    await store.open('/tmp/same')
    const id = store.activeTabId
    store.commitMessage = 'keep me'
    store.newTab()
    const count = store.tabs.length
    await store.open('/tmp/same')
    assert.equal(store.activeTabId, id)
    assert.equal(store.commitMessage, 'keep me')
    assert.equal(store.tabs.length, count)
  })

  await test('A pending diff from the previous tab cannot alter a newly opened repository', async () => {
    const store = freshStore()
    let complete
    nativeHandler = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    const pending = store.selectFile({ path: 'old.txt', status: 'M' })
    store.newTab()
    complete({ diff: '+wrong tab', truncated: false })
    await pending
    assert.equal(store.isNewTab, true)
    assert.notEqual(store.diffText, '+wrong tab')
  })

  await test('Creating a repository invokes the main process and replaces the active new tab', async () => {
    const store = freshStore()
    store.newTab()
    const id = store.activeTabId
    const requests = []
    nativeHandler = async (command, args) => {
      requests.push({ command, args })
      return command === 'runtime'
        ? nativeRuntime
        : { snapshot: { ...structuredClone(fixture), path: '/tmp/created', name: 'created' } }
    }
    assert.equal(await store.createRepository('init', '/tmp/created'), true)
    assert.equal(store.activeTabId, id)
    assert.equal(store.isNewTab, false)
    assert.deepEqual(requests[1], {
      command: 'create',
      args: { request: { kind: 'init', path: '/tmp/created', url: '' } },
    })
    store.forgetRecent('/tmp/created')
    assert.ok(!store.recent.includes('/tmp/created'))
    assert.ok(!JSON.parse(localStorage.getItem('gitcode.recent')).includes('/tmp/created'))
  })

  await test('A static preview without a local origin explains the missing core without a developer command', async () => {
    const store = freshStore()
    const bridge = window.gitk
    delete window.gitk
    try {
      await store.init()
      assert.equal(store.connected, false)
      assert.equal(await store.open('C:\\Projects\\example'), false)
      assert.ok(store.notices.some((n) => n.error && n.text.includes('需要连接 GitCode 本机核心')))
      assert.ok(store.notices.every((n) => !n.text.includes('bun run desktop')))
    } finally {
      window.gitk = bridge
    }
  })

  await test('Browser local connection renders directory access, disconnects honestly and reconnects without native chrome', async () => {
    const nativeWindow = globalThis.window,
      originalFetch = globalThis.fetch
    let failRead = false,
      handshakes = 0
    globalThis.window = {
      location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:43187' },
      addEventListener() {},
    }
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/session')) {
        handshakes++
        return new Response(JSON.stringify({ token: 'd'.repeat(64), protocol: 1 }))
      }
      const value = JSON.parse(options.body)
      if (value.method === 'snapshot' && failRead) throw new TypeError('core stopped')
      return new Response(
        JSON.stringify({
          result: { ...nativeRuntime, platform: 'linux', transport: 'local', environment: 'wsl' },
        }),
      )
    }
    try {
      const pinia = createPinia()
      setActivePinia(pinia)
      const store = seedRepository(useRepositoryStore())
      await store.init()
      assert.equal(store.connected, true)
      assert.equal(store.runtime.transport, 'local')
      store.modal = 'open'
      const html = await renderToString(createSSRApp(App).use(pinia))
      assert.ok(html.includes('本机 Git 核心已连接'))
      assert.ok(html.includes('正在访问 WSL 目录'))
      assert.ok(html.includes('WSL 本机核心已连接'))
      assert.doesNotMatch(html, /class="window-controls"/)
      assert.ok(!html.includes('使用内置目录浏览器'))
      failRead = true
      assert.equal(await store.open('/tmp/browser-connection'), false)
      assert.equal(store.connected, false)
      assert.match(store.connectionError, /本机连接已中断/)
      const disconnected = await renderToString(createSSRApp(App).use(pinia))
      assert.ok(disconnected.includes('尚未连接本机 Git 核心'))
      assert.ok(disconnected.includes('连接本机核心'))
      failRead = false
      await store.init()
      assert.equal(store.connected, true)
      assert.equal(store.connectionError, '')
      assert.equal(handshakes, 1)
    } finally {
      globalThis.window = nativeWindow
      globalThis.fetch = originalFetch
    }
  })

  await test('Native directory selection handles success, cancellation and IPC failure', async () => {
    const store = freshStore()
    nativeHandler = async (command) => {
      assert.equal(command, 'chooseDirectory')
      return 'C:\\Projects\\中文项目'
    }
    assert.equal(await store.chooseDirectory(), 'C:\\Projects\\中文项目')
    nativeHandler = async () => null
    assert.equal(await store.chooseDirectory(), null)
    nativeHandler = async () => {
      throw 'dialog failed'
    }
    assert.equal(await store.chooseDirectory(), null)
    assert.ok(store.notices.some((n) => n.text === 'dialog failed'))
  })

  await test('Windows, UNC and Unix paths retain native separators and repository names', () => {
    assert.equal(pathName('C:\\Projects\\my-repo'), 'my-repo')
    assert.equal(pathName('\\\\server\\share\\my-repo\\'), 'my-repo')
    assert.equal(pathName('/Users/name/my-repo/'), 'my-repo')
    assert.equal(joinPath('C:\\Projects\\', 'my-repo'), 'C:\\Projects\\my-repo')
    assert.equal(joinPath('\\\\server\\share', 'my-repo'), '\\\\server\\share\\my-repo')
    assert.equal(joinPath('/Users/name/', 'my-repo'), '/Users/name/my-repo')
  })

  await test('Runtime information and cancellation use the native bridge', async () => {
    const store = freshStore()
    const commands = []
    nativeHandler = async (command) => {
      commands.push(command)
      return nativeRuntime
    }
    await store.init()
    assert.equal(store.connected, true)
    assert.equal(store.runtime.platform, 'windows')
    store.busy = true
    store.activeOperation = 'fetch'
    await store.cancelOperation()
    assert.deepEqual(commands, ['runtime', 'cancel'])
    await desktop.diff('/tmp/repo', 'src/file.ts', true, fixture.commits[0].hash)
    assert.equal(commands.at(-1), 'diff')
  })

  await test('Electron window controls update maximization and preserve minimize and close', async () => {
    const calls = []
    let max = false
    const native = {
      minimize: async () => {
        calls.push('minimize')
      },
      toggleMaximize: async () => {
        calls.push('maximize')
        max = !max
      },
      close: async () => {
        calls.push('close')
      },
      isMaximized: async () => max,
      isFullscreen: async () => false,
      isFocused: async () => true,
    }
    window.gitkWindow = native
    try {
      const pinia = createPinia()
      let chrome
      await renderToString(
        createSSRApp({
          setup() {
            chrome = useDesktopWindow()
            return () => null
          },
        }).use(pinia),
      )
      assert.equal(chrome.customFrame.value, true)
      await chrome.action('maximize')
      assert.equal(chrome.maximized.value, true)
      assert.deepEqual(calls, ['maximize'])
      await chrome.action('maximize')
      assert.equal(chrome.maximized.value, false)
      await chrome.action('minimize')
      await chrome.action('close')
      assert.deepEqual(calls, ['maximize', 'maximize', 'minimize', 'close'])
      native.minimize = async () => {
        throw new Error('window unavailable')
      }
      await chrome.action('minimize')
      setActivePinia(pinia)
      assert.ok(
        useRepositoryStore().notices.some(
          (notice) => notice.error && notice.text.includes('window unavailable'),
        ),
      )
    } finally {
      delete window.gitkWindow
    }
  })

  await test('macOS reserves its native window controls; browser previews omit desktop chrome', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = seedRepository(useRepositoryStore())
    store.runtime = { ...nativeRuntime, platform: 'macos' }
    window.gitkWindow = {}
    try {
      const html = await renderToString(createSSRApp(App).use(pinia))
      assert.ok(html.includes('platform-macos'))
      assert.ok(!html.includes('aria-label="窗口控制"'))
    } finally {
      delete window.gitkWindow
    }
    const html = await renderToString(createSSRApp(App).use(createPinia()))
    assert.ok(!html.includes('aria-label="窗口控制"'))
  })
} finally {
  globalThis.window = originalWindow
  await vite.close()
}
