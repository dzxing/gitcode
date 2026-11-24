'use strict'

// Windows-only acceptance against a packaged executable. Application mutations
// use visible controls; the bridge is used only to observe operation results.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { randomBytes } = require('node:crypto')
const https = require('node:https')
const { spawn } = require('node:child_process')
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const index = value.indexOf('=')
    return [value.slice(2, index), value.slice(index + 1)]
  }),
)
const project = path.resolve(options.project || path.join(__dirname, '..'))
const appDirectory = path.resolve(options.app || path.join(project, 'release', 'win-unpacked'))
const artifacts = path.resolve(options.output || path.join(project, 'design', 'desktop-acceptance'))
const requireProject = createRequire(path.join(project, 'package.json'))
const { _electron } = requireProject('playwright-core')
const { GitService, execute } = require(path.join(project, 'electron', 'git.cjs'))
const { environmentForGit } = require(path.join(project, 'electron', 'git-runtime.cjs'))
const { quietSsh } = require(path.join(project, 'electron', 'auto-fetch.cjs'))
const resourcesPath = path.join(appDirectory, 'resources')
const git = new GitService({
  selection: options.git ? { mode: 'custom', path: path.resolve(options.git) } : { mode: 'auto' },
})
const checks = []
const limitations = []
const apps = new Set()
let root
const report = async (finished) =>
  fs.writeFile(
    path.join(artifacts, 'report.json'),
    JSON.stringify(
      {
        finished,
        passed: finished && checks.every((check) => check.passed),
        application: appDirectory,
        transport: 'packaged Windows Electron and actual preload IPC',
        checks,
        limitations,
        temporaryRepositories: true,
        businessRepositoriesModified: false,
      },
      null,
      2,
    ),
  )
async function check(name, work) {
  try {
    const details = await work()
    checks.push({ name, passed: true, ...(details ? { details } : {}) })
    console.log(`PASS ${name}`)
  } catch (error) {
    checks.push({ name, passed: false, error: git.safeError(error) })
    console.error(`FAIL ${name}: ${git.safeError(error)}`)
    throw error
  } finally {
    await report(false)
  }
}
async function configure(repo) {
  for (const [key, value] of [
    ['user.name', 'GitCode Desktop QA'],
    ['user.email', 'desktop-qa@example.test'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ])
    await git.git(repo, ['config', key, value])
}
async function commit(repo, file, text, message = file) {
  await fs.writeFile(path.join(repo, file), text)
  await git.git(repo, ['add', file])
  await git.git(repo, ['commit', '-m', message])
  return git.head(repo)
}
async function fixture(name, branch = 'qa/native') {
  const directory = path.join(root, name)
  const repo = path.join(directory, '中文 worktree'),
    remote = path.join(directory, 'remote.git')
  await fs.mkdir(repo, { recursive: true })
  await git.git(repo, ['init', '-b', branch])
  await configure(repo)
  const head = await commit(repo, 'shared.txt', 'base\n')
  await git.git(directory, ['init', '--bare', remote])
  await git.git(repo, ['remote', 'add', 'origin', remote])
  await git.git(repo, ['push', '-u', 'origin', branch])
  return { directory, repo: await git.repository(repo), remote, head, branch }
}
async function launch(name, existingProfile, { resetSettings = true, startupShot = '' } = {}) {
  console.log(`LAUNCH ${name}`)
  const profile = existingProfile || path.join(root, `profile-${name}`)
  await fs.mkdir(profile, { recursive: true })
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^(PATH|GITCODE_GIT_PATH|GITK_GIT_PATH|GIT_EXEC_PATH|ELECTRON_RUN_AS_NODE|GITCODE_DEV_URL|GITK_DEV_URL)$/i.test(
        key,
      )
    )
      delete env[key]
  env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  if (options.git) env.GITCODE_GIT_PATH = path.resolve(options.git)
  const app = await _electron.launch({
    executablePath: path.join(appDirectory, 'GitCode.exe'),
    args: [`--user-data-dir=${profile}`, '--force-renderer-accessibility'],
    env,
    timeout: 60000,
  })
  apps.add(app)
  const actual = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    pid: process.pid,
    userData: app.getPath('userData'),
  }))
  assert.equal(actual.packaged, true)
  assert.equal(
    (await fs.realpath(actual.userData)).toLowerCase(),
    (await fs.realpath(profile)).toLowerCase(),
    'Acceptance must never use an existing user profile',
  )
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const capture = startupShot
    ? page
        .getByRole('region', { name: '应用启动状态', exact: true })
        .waitFor({ timeout: 2000 })
        .then(() => page.screenshot({ path: path.join(artifacts, startupShot + '.png') }))
        .catch(() => {})
    : Promise.resolve()
  const errors = [],
    failedAssets = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('file:')) failedAssets.push(request.url())
  })
  await page.waitForFunction(() =>
    document.querySelector('#operation-status')?.textContent.includes('已连接'),
  )
  assert.ok(page.url().startsWith('file:'))
  const runtime = await page.evaluate(() => window.gitcode.runtime())
  assert.ok(['system', 'environment'].includes(runtime.gitSource))
  assert.ok(
    !runtime.gitPath.startsWith(resourcesPath),
    'Git must not come from the application bundle',
  )
  const state = { app, page, profile, errors, failedAssets, runtime, nativePid: actual.pid }
  await capture
  if (resetSettings) await settings(state, 0)
  return state
}
async function settings(state, interval) {
  const page = state.page
  await page.getByRole('button', { name: '活动日志', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '活动日志', exact: true })
  await dialog.getByRole('button', { name: '自动获取与日志设置', exact: true }).click()
  const input = dialog.getByRole('spinbutton', { name: '自动获取间隔（分钟）' })
  await input.waitFor()
  await page.waitForFunction(
    () => !document.querySelector('.activity-log-settings input[type=number]')?.disabled,
  )
  await input.fill(String(interval))
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.activity-log-settings'))
  await dialog.getByRole('button', { name: '关闭活动日志', exact: true }).click()
}
async function idle(state) {
  await state.page.waitForFunction(
    () => document.querySelector('#operation-status')?.textContent.includes('已连接'),
    {},
    { timeout: 60000 },
  )
}
async function refresh(state) {
  await state.page
    .locator('.toolbar-actions')
    .getByRole('button', { name: '刷新', exact: true })
    .click()
  await idle(state)
}
async function open(state, repo) {
  // Let the real native chooser IPC return this disposable fixture once.
  // Git discovery, trust and repository loading still use the production core.
  await state.app.evaluate(({ dialog }, repo) => {
    const previous = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = previous
      return { canceled: false, filePaths: [repo] }
    }
  }, repo)
  await state.page.keyboard.press('Control+o')
  const trust = state.page.getByRole('dialog', { name: '信任此仓库？', exact: true })
  const needsTrust = await Promise.race([
    trust.waitFor({ state: 'visible' }).then(() => true),
    state.page
      .waitForFunction(
        (repo) =>
          document
            .querySelector('.repo-selector')
            ?.getAttribute('data-repository-path')
            ?.toLowerCase() === repo.toLowerCase(),
        repo,
      )
      .then(() => false),
  ])
  if (needsTrust) await trust.getByRole('button', { name: '信任并打开', exact: true }).click()
  await state.page.waitForFunction(
    (repo) =>
      document
        .querySelector('.repo-selector')
        ?.getAttribute('data-repository-path')
        ?.toLowerCase() === repo.toLowerCase(),
    repo,
  )
  await idle(state)
}

async function action(state, repo, operation, click, outcomes = ['succeeded']) {
  const old = await state.page.evaluate(
    async (repo) =>
      (await window.gitcode.operationLog({ scope: 'repository', repo })).records.map(
        (record) => record.id,
      ),
    repo,
  )
  await click()
  let result
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const records = await state.page.evaluate(
      async (repo) => (await window.gitcode.operationLog({ scope: 'repository', repo })).records,
      repo,
    )
    result = records.find(
      (record) =>
        record.operation === operation && !old.includes(record.id) && record.state !== 'running',
    )
    if (result) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (!result) {
    const diagnostics = await state.page.evaluate(async (repo) => {
      const displayed = document.querySelector('.status-path')?.title
      return {
        repo,
        displayed,
        expected: await window.gitcode.operationLog({ scope: 'repository', repo }),
        actual: displayed
          ? await window.gitcode.operationLog({ scope: 'repository', repo: displayed })
          : null,
        activity: await window.gitcode.activity(),
        warning: document.querySelector('.partial-warning')?.textContent,
      }
    }, repo)
    await fs.writeFile(
      path.join(artifacts, 'missing-operation.json'),
      JSON.stringify(diagnostics, null, 2),
    )
  }
  assert.ok(result, `Operation did not finish: ${operation}`)
  assert.ok(outcomes.includes(result.state), JSON.stringify(result))
  await idle(state)
  return result
}
async function worktree(state) {
  await state.page
    .locator('.workspace-nav')
    .getByRole('button', { name: /工作区/ })
    .click()
}
async function commitUI(state, repo, message) {
  await refresh(state)
  await worktree(state)
  const stage = state.page.getByRole('button', { name: '全部暂存', exact: true })
  if ((await stage.count()) && (await stage.isEnabled()))
    await action(state, repo, 'stage', () => stage.click())
  await state.page.getByRole('textbox', { name: '提交说明', exact: true }).fill(message)
  return action(state, repo, 'commit', () =>
    state.page.getByRole('button', { name: /提交 \d+ 个文件/ }).click(),
  )
}
async function pushUI(state, repo, recovery = false, outcomes) {
  if (!recovery)
    return action(
      state,
      repo,
      'push',
      async () => {
        await state.page
          .locator('.toolbar-actions')
          .getByRole('button', { name: '推送', exact: true })
          .click()
        await idle(state)
        const dialog = state.page.getByRole('dialog', { name: '推送指定分支', exact: true })
        if (!(await dialog.isVisible())) return
        await dialog.locator('.push-check').waitFor()
        const first = dialog.getByRole('button', { name: '创建并推送', exact: true })
        await (
          (await first.count()) ? first : dialog.getByRole('button', { name: '推送', exact: true })
        ).click()
      },
      outcomes,
    )
  await state.page
    .locator('.toolbar-actions')
    .getByRole('button', { name: '推送', exact: true })
    .click()
  const dialog = state.page.getByRole('dialog', { name: '推送指定分支', exact: true })
  if (recovery)
    return action(
      state,
      repo,
      'pull-and-push',
      () => dialog.getByRole('button', { name: '拉取并推送', exact: true }).click(),
      outcomes,
    )
}
async function shot(state, name) {
  await state.page.screenshot({ path: path.join(artifacts, `${name}.png`) })
}
async function killOwnedProcess(pid) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 || code === 128
        ? resolve()
        : reject(Error(`Owned process termination failed: ${code}`)),
    )
  })
}
async function closeClean(state) {
  if (!apps.has(state.app)) return
  try {
    await idle(state)
    const quit = state.page.getByRole('dialog', { name: '退出 GitCode？', exact: true })
    if (await quit.count()) await quit.getByRole('button', { name: /留在应用|取消退出/ }).click()
    await Promise.race([
      state.app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('Owned test application did not close')), 8000),
      ),
    ])
  } catch {
    let pid
    try {
      pid = state.app.process().pid
    } catch {
      /* Already closed. */
    }
    if (pid) await killOwnedProcess(pid).catch(() => {})
  }
  apps.delete(state.app)
  console.log('CLOSED owned packaged application')
}

async function businessSuite() {
  const f = await fixture('business'),
    state = await launch('business')
  const { page } = state
  try {
    await check(
      'packaged exe opens a Unicode repository using an independently installed Git',
      async () => {
        await open(state, f.repo)
        const version = await page.locator('.sidebar-version').innerText()
        assert.ok(version.includes(`v${require(path.join(project, 'package.json')).version}`))
        assert.doesNotMatch(version, /\bPreview\b/)
        await page.evaluate(async () => {
          await document.fonts.ready
          await document.fonts.load('12px "Cascadia Mono"')
        })
        assert.ok(
          await page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes('Cascadia Mono') && font.status === 'loaded',
            ),
          ),
        )
        assert.deepEqual(state.failedAssets, [])
        await shot(state, '02-native-repository')
        return {
          gitVersion: state.runtime.gitVersion,
          gitSource: state.runtime.gitSource,
          fileProtocol: true,
        }
      },
    )
    await check('branch creation and checkout execute through the native UI', async () => {
      await page
        .locator('.toolbar-actions')
        .getByRole('button', { name: '分支', exact: true })
        .click()
      const form = page.getByRole('form', { name: '在此提交新建分支', exact: true })
      await form.getByRole('textbox', { name: '分支名称', exact: true }).fill('qa/desktop')
      await form.getByRole('checkbox', { name: '创建后检出', exact: true }).check()
      await action(state, f.repo, 'create-branch', () =>
        form.getByRole('button', { name: '创建分支', exact: true }).click(),
      )
      assert.equal(await git.currentBranch(f.repo), 'qa/desktop')
      for (const branch of ['qa/native', 'qa/desktop']) {
        await action(state, f.repo, 'checkout', () =>
          page
            .locator(`[data-sidebar-section="local"] [data-branch-name="${branch}"] .branch-main`)
            .dblclick(),
        )
        assert.equal(await git.currentBranch(f.repo), branch)
      }
    })
    await check(
      'staging and commit create a real commit and first Push creates its upstream',
      async () => {
        await fs.writeFile(path.join(f.repo, 'native.txt'), 'created through packaged UI\n')
        await commitUI(state, f.repo, 'QA packaged commit')
        await pushUI(state, f.repo)
        assert.equal(
          (await git.git(f.repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(),
          'origin/qa/desktop',
        )
        assert.equal(
          await git.head(f.repo),
          (await git.git(f.remote, ['rev-parse', 'refs/heads/qa/desktop'])).trim(),
        )
        await shot(state, '03-native-first-push')
      },
    )
    const peer = path.join(f.directory, 'peer')
    await git.git(f.directory, ['clone', '-b', 'qa/desktop', f.remote, peer])
    await configure(peer)
    await check(
      'Fetch shows remote updates without moving local HEAD; Pull fast-forwards explicitly',
      async () => {
        const localHead = await git.head(f.repo)
        const next = await commit(peer, 'remote.txt', 'remote update\n')
        await git.git(peer, ['push', 'origin', 'qa/desktop'])
        await action(state, f.repo, 'fetch', () =>
          page
            .locator('.toolbar-actions')
            .getByRole('button', { name: '获取', exact: true })
            .click(),
        )
        assert.equal(await git.head(f.repo), localHead)
        assert.equal((await git.git(f.repo, ['rev-parse', 'origin/qa/desktop'])).trim(), next)
        await action(state, f.repo, 'pull', () =>
          page
            .locator('.toolbar-actions')
            .getByRole('button', { name: '拉取', exact: true })
            .click(),
        )
        assert.equal(await git.head(f.repo), next)
      },
    )
    await check(
      'diverged Push stops at a conflict; native three-way editor completes without silently publishing',
      async () => {
        await fs.writeFile(path.join(f.repo, 'shared.txt'), 'local conflict\n')
        await commitUI(state, f.repo, 'QA local conflict')
        const remoteHead = await commit(peer, 'shared.txt', 'remote conflict\n')
        await git.git(peer, ['push', 'origin', 'qa/desktop'])
        await pushUI(state, f.repo, true, ['partial'])
        const panel = page.getByRole('region', { name: '解决冲突', exact: true })
        await panel.waitFor()
        assert.equal(await page.locator('dialog[open]').count(), 0)
        assert.equal(
          (await git.git(f.remote, ['rev-parse', 'refs/heads/qa/desktop'])).trim(),
          remoteHead,
        )
        await shot(state, '04-native-conflict')
        await panel.locator('.conflict-file-name').click()
        const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
        await editor
          .getByRole('textbox', { name: '编辑合并结果', exact: true })
          .fill('native local and remote\n')
        await shot(state, '05-native-three-way-editor')
        await action(state, f.repo, 'merge-resolve', () =>
          editor.getByRole('button', { name: '保存并标记已解决', exact: true }).click(),
        )
        const ready = page.getByRole('region', { name: '检查合并结果', exact: true })
        await action(state, f.repo, 'merge-finish', () =>
          ready.getByRole('button', { name: '完成合并', exact: true }).click(),
        )
        assert.equal(await git.merge.state(f.repo), null)
        assert.equal(
          (await git.git(f.remote, ['rev-parse', 'refs/heads/qa/desktop'])).trim(),
          remoteHead,
        )
        await pushUI(state, f.repo)
        assert.equal(
          (await git.git(f.remote, ['rev-parse', 'refs/heads/qa/desktop'])).trim(),
          await git.head(f.repo),
        )
      },
    )
    await check(
      'Stash Apply retains the record and Pop removes it after successful recovery',
      async () => {
        const clean = await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8')
        await fs.writeFile(path.join(f.repo, 'shared.txt'), 'native stash change\n')
        await refresh(state)
        await worktree(state)
        await page.getByRole('tab', { name: '贮藏', exact: true }).click()
        const form = page.getByRole('form', { name: '贮藏当前修改', exact: true })
        await form.getByRole('textbox', { name: /^贮藏名称/ }).fill('Native packaged stash')
        await action(state, f.repo, 'stash-create', () =>
          form.getByRole('button', { name: /贮藏/ }).click(),
        )
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), clean)
        await page.locator('.stash-row').first().click()
        let panel = page.getByRole('region', { name: '贮藏详情', exact: true })
        await action(state, f.repo, 'stash-apply', () =>
          panel.getByRole('button', { name: '恢复并保留', exact: true }).click(),
        )
        assert.ok((await git.git(f.repo, ['stash', 'list'])).includes('Native packaged stash'))
        assert.equal(
          await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'),
          'native stash change\n',
        )
        if (await panel.count())
          await panel.getByRole('button', { name: '返回工作区', exact: true }).click()
        await fs.writeFile(path.join(f.repo, 'shared.txt'), clean)
        await refresh(state)
        await page.locator('.stash-row').first().click()
        panel = page.getByRole('region', { name: '贮藏详情', exact: true })
        await action(state, f.repo, 'stash-pop', () =>
          panel.getByRole('button', { name: '恢复并移除', exact: true }).click(),
        )
        assert.equal((await git.git(f.repo, ['stash', 'list'])).trim(), '')
        assert.equal(
          await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'),
          'native stash change\n',
        )
        await fs.writeFile(path.join(f.repo, 'shared.txt'), clean)
        await refresh(state)
      },
    )
    await check(
      'packaged renderer finishes the main operation suite without script or asset errors',
      async () => {
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
      },
    )
  } catch (error) {
    await shot(state, 'business-failure').catch(() => {})
    throw error
  } finally {
    await closeClean(state)
  }
}
async function terminalSuite() {
  const f = await fixture('terminal'),
    state = await launch('terminal')
  const { page } = state
  try {
    await open(state, f.repo)
    await check(
      'packaged Windows terminal tabs retain independent live processes alongside Git console',
      async () => {
        await page.getByRole('button', { name: 'Git 控制台', exact: true }).click()
        const panel = page.locator('.terminal-workbench')
        const consoleTab = panel.getByRole('tab', { name: 'Git 控制台', exact: true })
        await consoleTab.waitFor()
        await panel.getByRole('combobox', { name: '新终端使用的 Shell' }).selectOption('cmd')
        await panel.getByRole('button', { name: '新建终端', exact: true }).click()
        const firstTab = panel.getByRole('tab', { name: /终端 1/ })
        await firstTab.waitFor()
        const first = (
          await panel.locator('.terminal-session-view').first().getAttribute('id')
        ).slice('terminal-'.length)
        const read = async (id) =>
          page.evaluate(
            async ({ repo, id }) =>
              window.gitcode.terminal(repo, { action: 'read', id, cursor: 0 }),
            { repo: f.repo, id },
          )
        const waitForOutput = async (id, marker) => {
          try {
            await waitUntil(async () => (await read(id)).data.includes(marker))
          } catch {
            const output = await read(id)
            await fs.writeFile(
              path.join(artifacts, 'terminal-failure-output.json'),
              JSON.stringify(output, null, 2),
            )
            await shot(state, 'terminal-failure')
            throw Error(`Terminal did not produce ${marker}; state=${output.state}`)
          }
        }
        const command = async (id, text) => {
          const input = page.locator(`[id="terminal-${id}"] textarea`)
          await input.pressSequentially(text, { delay: 1 })
          await input.press('Enter')
        }
        await command(first, 'set "QA_NATIVE=preserved"')
        await command(first, 'echo __READY_%QA_NATIVE%__')
        await waitForOutput(first, '__READY_preserved__')
        await command(first, 'ping -n 3 127.0.0.1 >nul & echo __BACKGROUND_%QA_NATIVE%__')
        await consoleTab.click()
        await firstTab.waitFor()
        await waitForOutput(first, '__BACKGROUND_preserved__')
        assert.equal((await read(first)).state, 'running')
        await panel.getByRole('button', { name: '新建终端', exact: true }).click()
        await panel.getByRole('tab', { name: /终端 2/ }).waitFor()
        const second = (
          await panel.locator('.terminal-session-view').nth(1).getAttribute('id')
        ).slice('terminal-'.length)
        assert.notEqual(second, first)
        await command(
          second,
          'if defined QA_NATIVE (echo __LEAK_%QA_NATIVE%__) else (echo __ISOLATED_%OS%__)',
        )
        await waitForOutput(second, '__ISOLATED_Windows_NT__')
        await panel.getByRole('button', { name: '关闭终端 2', exact: true }).click()
        await firstTab.click()
        await command(first, 'echo __KEPT_%QA_NATIVE%__')
        await waitForOutput(first, '__KEPT_preserved__')
        await fs.writeFile(path.join(f.repo, 'console.txt'), 'native console\n')
        await refresh(state)
        await worktree(state)
        await action(state, f.repo, 'stage', () =>
          page.getByRole('button', { name: '全部暂存', exact: true }).click(),
        )
        await page.getByRole('button', { name: 'Git 控制台', exact: true }).click()
        await page
          .locator('.git-console-line.start')
          .filter({ hasText: /\badd\b/ })
          .waitFor()
        await panel.getByRole('button', { name: '关闭终端 1', exact: true }).click()
        // Native PTY closure is acknowledged asynchronously before removing its tab.
        await firstTab.waitFor({ state: 'hidden' })
        assert.equal(await panel.isVisible(), true)
        assert.equal(await consoleTab.getAttribute('aria-selected'), 'true')
        assert.equal(await panel.getByRole('tab').count(), 1)
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
        await shot(state, 'native-console-and-terminal')
        return {
          nativePty: true,
          backgroundCommandContinued: true,
          environmentPreserved: true,
          independentShells: true,
          gitOutputRecorded: true,
        }
      },
    )
  } finally {
    await closeClean(state)
  }
}

async function flowSuite() {
  const f = await fixture('gitflow', 'production'),
    state = await launch('gitflow')
  const { page } = state
  try {
    await open(state, f.repo)
    await check(
      'GitFlow initializes missing develop from the selected production branch',
      async () => {
        await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
        const panel = page.locator('.gitflow-panel')
        await panel.getByRole('button', { name: '配置 GitFlow', exact: true }).click()
        await panel.getByRole('textbox', { name: '生产分支', exact: true }).fill('production')
        await panel.getByRole('textbox', { name: '开发分支', exact: true }).fill('develop')
        await panel.getByRole('textbox', { name: '版本标签前缀', exact: true }).fill('v')
        await panel.locator('[id="flow-source-develop"]').selectOption('refs/heads/production')
        await panel.getByRole('button', { name: '预览初始化', exact: true }).click()
        await action(state, f.repo, 'gitflow-init', () =>
          panel.getByRole('button', { name: '确认初始化', exact: true }).click(),
        )
        assert.equal((await git.git(f.repo, ['rev-parse', 'develop'])).trim(), f.head)
        assert.equal((await git.snapshot(f.repo)).gitflow.ready, true)
        await shot(state, '06-native-gitflow-init')
        await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
      },
    )
    for (const [type, suffix, label, tag] of [
      ['feature', 'native-feature', '完成功能分支', ''],
      ['release', '2.0.0', '完成发布', 'v2.0.0'],
      ['hotfix', '2.0.1', '完成热修复', 'v2.0.1'],
    ])
      await check(
        `GitFlow ${type} starts, commits and finishes via packaged UI without automatic Push`,
        async () => {
          await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
          let panel = page.locator('.gitflow-panel')
          await panel.getByRole('button', { name: '开始新分支…', exact: true }).click()
          await panel.getByRole('button', { name: new RegExp('^' + type) }).click()
          await panel.getByRole('textbox', { name: '分支名称', exact: true }).fill(suffix)
          await action(state, f.repo, 'gitflow-start', () =>
            panel.getByRole('button', { name: '创建并切换', exact: true }).click(),
          )
          assert.equal(await git.currentBranch(f.repo), `${type}/${suffix}`)
          await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
          await fs.writeFile(path.join(f.repo, `${type}.txt`), `native ${type}\n`)
          await commitUI(state, f.repo, `QA native ${type}`)
          const source = await git.head(f.repo)
          await page.getByRole('button', { name: '打开 GitFlow 操作面板', exact: true }).click()
          panel = page.locator('.gitflow-panel')
          await panel.getByRole('button', { name: '完成分支…', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: label, exact: true })
          if (tag) {
            await dialog.getByRole('checkbox', { name: '创建版本标签', exact: true }).check()
            await dialog.getByRole('textbox', { name: '版本标签名称', exact: true }).fill(tag)
          }
          await action(state, f.repo, 'gitflow-finish', () =>
            dialog.getByRole('button', { name: label, exact: true }).click(),
          )
          assert.equal(await git.currentBranch(f.repo), 'develop')
          assert.ok(
            (await git.recovery.read(f.repo)).entries.some(
              (entry) => entry.branch === `${type}/${suffix}` && entry.oid === source,
            ),
            'GitFlow deletion must retain a recovery point',
          )
          await git.git(f.repo, ['merge-base', '--is-ancestor', source, 'develop'])
          if (tag) {
            await git.git(f.repo, ['merge-base', '--is-ancestor', source, 'production'])
            assert.equal(
              (await git.git(f.repo, ['cat-file', '-t', `refs/tags/${tag}`])).trim(),
              'tag',
            )
          }
          assert.equal(
            (
              await git.git(f.repo, [
                'for-each-ref',
                '--format=%(refname)',
                `refs/heads/${type}/${suffix}`,
              ])
            ).trim(),
            '',
          )
          assert.equal(
            (await git.git(f.remote, ['rev-parse', 'refs/heads/production'])).trim(),
            f.head,
          )
          await shot(state, `07-native-gitflow-${type}`)
          if (await panel.count())
            await panel.getByRole('button', { name: '收起 GitFlow 面板', exact: true }).click()
        },
      )
  } catch (error) {
    await shot(state, 'gitflow-failure').catch(() => {})
    throw error
  } finally {
    await closeClean(state)
  }
}

async function httpsRemote(fixture) {
  const directory = path.join(fixture.directory, 'tls')
  await fs.mkdir(directory)
  const key = path.join(directory, 'server.key'),
    certificate = path.join(directory, 'server.crt')
  const gitRoot = path.dirname(path.dirname((await git.runtime()).gitPath))
  let openssl = 'openssl.exe'
  for (const toolchain of ['ucrt64', 'mingw64', 'usr']) {
    const candidate = path.join(gitRoot, toolchain, 'bin', 'openssl.exe')
    if (
      await fs.access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      openssl = candidate
      break
    }
  }
  const generated = await execute(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      certificate,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { timeout: 20000 },
  )
  assert.equal(generated.code, 0, generated.stderr)
  const control = {
    token: randomBytes(24).toString('hex'),
    mode: 'ok',
    events: [],
    holding: false,
    release: null,
  }
  const server = https.createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(certificate) },
    async (request, response) => {
      const url = new URL(request.url, 'https://127.0.0.1')
      if (
        ![
          '/remote.git/info/refs',
          '/remote.git/git-upload-pack',
          '/remote.git/git-receive-pack',
        ].includes(url.pathname)
      ) {
        response.writeHead(404)
        response.end()
        return
      }
      const authorized =
        request.headers.authorization ===
        'Basic ' + Buffer.from('qa:' + control.token).toString('base64')
      if (!authorized) {
        control.events.push({ at: Date.now(), path: url.pathname, status: 401 })
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitCode QA"' })
        response.end()
        return
      }
      if (
        control.mode === 'hold-push' &&
        request.method === 'POST' &&
        url.pathname.endsWith('/git-receive-pack')
      ) {
        control.holding = true
        await new Promise((resolve) => {
          control.release = resolve
        })
        control.holding = false
        control.release = null
        if (response.destroyed) {
          control.events.push({ at: Date.now(), path: url.pathname, cancelledBeforeBackend: true })
          return
        }
      }
      const env = environmentForGit(
        {
          ...process.env,
          GIT_PROJECT_ROOT: fixture.directory,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers['content-type'] || '',
          CONTENT_LENGTH: request.headers['content-length'] || '',
          REMOTE_USER: 'qa',
          REMOTE_ADDR: '127.0.0.1',
          GIT_PROTOCOL: request.headers['git-protocol'] || '',
        },
        git.gitPath,
        git.gitSource,
      )
      const child = spawn(git.gitPath, ['http-backend'], {
        env,
        windowsHide: true,
      })
      const chunks = []
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => {})
      child.on('error', () => {
        if (!response.destroyed) response.destroy()
      })
      request.pipe(child.stdin)
      child.on('close', (code) => {
        control.events.push({
          at: Date.now(),
          method: request.method,
          path: url.pathname,
          backendCode: code,
        })
        if (response.destroyed) return
        const output = Buffer.concat(chunks)
        let separator = output.indexOf('\r\n\r\n'),
          length = 4
        if (separator < 0) {
          separator = output.indexOf('\n\n')
          length = 2
        }
        if (separator < 0) {
          response.writeHead(500)
          response.end('Invalid CGI headers')
          return
        }
        let status = 200
        for (const line of output.subarray(0, separator).toString().split(/\r?\n/)) {
          const split = line.indexOf(':')
          if (split < 0) continue
          const name = line.slice(0, split),
            value = line.slice(split + 1).trim()
          if (name.toLowerCase() === 'status') status = parseInt(value)
          else response.setHeader(name, value)
        }
        response.writeHead(status)
        response.end(output.subarray(separator + length))
      })
    },
  )
  await git.git(fixture.remote, ['config', 'http.receivepack', 'true'])
  const listen = (port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  await listen(0)
  const port = server.address().port
  const url = `https://127.0.0.1:${port}/remote.git`
  const credentials = path.join(directory, 'credentials')
  const writeCredentials = () =>
    fs.writeFile(credentials, `https://qa:${control.token}@127.0.0.1:${port}/remote.git\n`)
  const connect = async (repo) => {
    await git.git(repo, ['remote', 'set-url', 'origin', url])
    await git.git(repo, ['config', 'http.sslBackend', 'openssl'])
    await git.git(repo, ['config', 'http.sslCAInfo', certificate.replaceAll('\\', '/')])
    await git.git(repo, ['config', 'credential.useHttpPath', 'true'])
    await git.git(repo, ['config', '--unset-all', 'credential.helper'], { allowedCodes: [0, 5] })
    await git.git(repo, ['config', '--add', 'credential.helper', ''])
    await git.git(repo, [
      'config',
      '--add',
      'credential.helper',
      `store --file='${credentials.replaceAll('\\', '/')}'`,
    ])
  }
  const stop = async () => {
    control.release?.()
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
  await writeCredentials()
  await connect(fixture.repo)
  return { control, server, connect, writeCredentials, stop, restart: () => listen(port) }
}
async function authSuite() {
  const f = await fixture('https-auth'),
    state = await launch('https-auth'),
    server = await httpsRemote(f)
  const page = state.page
  try {
    await open(state, f.repo)
    await check(
      'packaged Git performs verified HTTPS Fetch with isolated test credentials',
      async () => {
        await action(state, f.repo, 'fetch', () =>
          page
            .locator('.toolbar-actions')
            .getByRole('button', { name: '获取', exact: true })
            .click(),
        )
        assert.ok(server.control.events.some((event) => event.backendCode === 0))
        assert.equal(await page.locator('dialog[open]').count(), 0)
      },
    )
    const second = await fixture('https-expired')
    await server.connect(second.repo)
    server.control.token = randomBytes(24).toString('hex') // Simulate expiry without touching any real credential.
    await check(
      'expired HTTPS credentials fail quietly during automatic Fetch and expose a recoverable log',
      async () => {
        await settings(state, 1)
        await open(state, second.repo)
        await page.waitForFunction(
          () => document.querySelector('.fetch-status-button')?.textContent.includes('获取需处理'),
          {},
          { timeout: 90000 },
        )
        const status = await page.evaluate((repo) => window.gitcode.fetchStatus(repo), second.repo)
        assert.equal(status.remotes.origin.paused, true)
        assert.ok(server.control.events.some((event) => event.status === 401))
        assert.equal(await page.locator('dialog[open]').count(), 0)
        assert.equal((await state.app.windows()).length, 1)
        await page.locator('.fetch-status-button').click()
        await page.locator('.activity-log-remotes').waitFor()
        await shot(state, '08-native-expired-credentials')
      },
    )
    await check(
      'updating only the test credential file and manually retrying clears authentication failure',
      async () => {
        await server.writeCredentials()
        await action(state, second.repo, 'fetch', () =>
          page
            .getByRole('region', { name: '操作详情', exact: true })
            .getByRole('button', { name: '手动获取', exact: true })
            .click(),
        )
        const status = await page.evaluate((repo) => window.gitcode.fetchStatus(repo), second.repo)
        assert.equal(status.remotes.origin.paused, false)
        assert.equal(status.error, '')
        await settings(state, 0)
      },
    )
    await check(
      'network interruption fails without changing HEAD or index and recovery succeeds through manual retry',
      async () => {
        const head = await git.head(second.repo),
          index = await git.indexFingerprint(second.repo)
        await server.stop()
        await action(
          state,
          second.repo,
          'fetch',
          () =>
            page
              .locator('.toolbar-actions')
              .getByRole('button', { name: '获取', exact: true })
              .click(),
          ['failed'],
        )
        assert.equal(await git.head(second.repo), head)
        assert.equal(await git.indexFingerprint(second.repo), index)
        await page.locator('.fetch-status-button').click()
        await page.locator('.activity-log-detail').waitFor()
        await shot(state, '09-native-network-interruption')
        await server.restart()
        await action(state, second.repo, 'fetch', () =>
          page
            .getByRole('region', { name: '操作详情', exact: true })
            .getByRole('button', { name: '手动获取', exact: true })
            .click(),
        )
        assert.equal(
          (await page.evaluate((repo) => window.gitcode.fetchStatus(repo), second.repo)).error,
          '',
        )
      },
    )
  } catch (error) {
    await shot(state, 'auth-failure').catch(() => {})
    throw error
  } finally {
    await server.stop()
    await closeClean(state)
    await fs.writeFile(
      path.join(artifacts, 'https-events.json'),
      JSON.stringify(server.control.events, null, 2),
    )
  }
}
async function waitUntil(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error('Native test condition timed out')
}
async function lifecycleSuite() {
  const f = await fixture('lifecycle'),
    state = await launch('lifecycle'),
    page = state.page
  let restored
  try {
    await open(state, f.repo)
    await check(
      'window close with a commit draft requires confirmation and Cancel preserves its contents',
      async () => {
        await page
          .getByRole('textbox', { name: '提交说明', exact: true })
          .fill('QA draft survives cancelled close')
        await state.app
          .browserWindow(page)
          .then((window) => window.evaluate((window) => window.close()))
        const dialog = page.getByRole('dialog', { name: '退出 GitCode？', exact: true })
        await dialog.waitFor()
        assert.equal(
          await dialog.getByRole('button', { name: '退出 GitCode', exact: true }).isDisabled(),
          true,
        )
        await shot(state, '10-native-draft-close-guard')
        await dialog.getByRole('button', { name: '留在应用', exact: true }).click()
        assert.equal(
          await page.getByRole('textbox', { name: '提交说明', exact: true }).inputValue(),
          'QA draft survives cancelled close',
        )
      },
    )
    await check('settings and operation history survive a clean packaged-app restart', async () => {
      await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('')
      console.log('RESTART save settings')
      await settings(state, 4)
      console.log('RESTART close application')
      const profile = state.profile
      await closeClean(state)
      console.log('RESTART launch application')
      restored = await launch('lifecycle-restored', profile, { resetSettings: false })
      assert.equal(
        (await restored.page.evaluate(() => window.gitcode.activitySettings())).autoFetchInterval,
        4,
      )
      const appLog = await restored.page.evaluate(() =>
        window.gitcode.operationLog({ scope: 'application' }),
      )
      assert.ok(appLog.records.some((record) => record.operation === 'activity-settings'))
      await settings(restored, 0)
      await open(restored, f.repo)
      await shot(restored, '11-native-restart-persistence')
    })
    await check(
      'commit draft is recovered after an unexpected packaged-app process exit',
      async () => {
        await restored.page
          .getByRole('textbox', { name: '提交说明', exact: true })
          .fill('QA draft before unexpected exit')
        await new Promise((resolve) => setTimeout(resolve, 500))
        const before = await restored.page.evaluate(() =>
          Object.entries(localStorage).filter(([key]) => key.startsWith('gitcode.commitDraft.v1:')),
        )
        const profile = restored.profile,
          proc = restored.app.process()
        apps.delete(restored.app)
        await killOwnedProcess(proc.pid)
        restored = await launch('draft-crash-recovery', profile, { resetSettings: false })
        await open(restored, f.repo)
        const recovered = await restored.page
          .getByRole('textbox', { name: '提交说明', exact: true })
          .inputValue()
        const restoredDraft = recovered === 'QA draft before unexpected exit'
        const after = await restored.page.evaluate(() =>
          Object.entries(localStorage).filter(([key]) => key.startsWith('gitcode.commitDraft.v1:')),
        )
        await fs.writeFile(
          path.join(artifacts, 'draft-recovery-storage.json'),
          JSON.stringify({ before, after, recovered }, null, 2),
        )
        assert.equal(restoredDraft, true, JSON.stringify({ before, after, recovered }))
        await restored.page.getByRole('textbox', { name: '提交说明', exact: true }).fill('')
        return { restoredDraft }
      },
    )
  } finally {
    if (restored) await closeClean(restored)
    await closeClean(state)
  }
  for (const cancel of [false, true]) {
    console.log(`START close-${cancel ? 'cancel' : 'wait'} fixture`)
    const sample = await fixture(cancel ? 'close-cancel' : 'close-wait')
    console.log('START held-Push application')
    const current = await launch(cancel ? 'close-cancel' : 'close-wait')
    console.log('START controlled HTTPS remote')
    const remote = await httpsRemote(sample)
    try {
      await open(current, sample.repo)
      await fs.writeFile(path.join(sample.repo, 'pending.txt'), 'pending native Push\n')
      await commitUI(current, sample.repo, 'QA pending Push')
      const localHead = await git.head(sample.repo),
        originalRemote = sample.head
      await check(
        cancel
          ? 'Cancel and exit stops a held Push without publishing or leaving an active job'
          : 'Wait and exit finishes a held Push before closing the packaged application',
        async () => {
          remote.control.mode = 'hold-push'
          await current.page
            .locator('.toolbar-actions')
            .getByRole('button', { name: '推送', exact: true })
            .click()
          await waitUntil(() => remote.control.holding, 30000)
          await current.app
            .browserWindow(current.page)
            .then((window) => window.evaluate((window) => window.close()))
          const quit = current.page.getByRole('dialog', { name: '退出 GitCode？', exact: true })
          await quit.waitFor()
          await shot(current, cancel ? '13-native-close-cancel' : '12-native-close-wait')
          const exiting = new Promise((resolve) => current.app.process().once('exit', resolve))
          await quit
            .getByRole('button', {
              name: cancel ? '取消操作并退出' : '等待完成后退出',
              exact: true,
            })
            .click()
          if (!cancel) remote.control.release()
          await Promise.race([
            exiting,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(Error('Application did not exit after close decision')),
                30000,
              ),
            ),
          ])
          apps.delete(current.app)
          if (cancel) remote.control.release?.()
          assert.equal(
            (await git.git(sample.remote, ['rev-parse', 'refs/heads/qa/native'])).trim(),
            cancel ? originalRemote : localHead,
          )
        },
      )
    } finally {
      remote.control.release?.()
      await remote.stop()
      await closeClean(current)
    }
  }
}
async function invokeNativeMenu(state, label) {
  const quoted = label.replace(/'/g, "''")
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$processCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${state.nativePid})
$nameCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${quoted}')
for($attempt=0;$attempt -lt 12;$attempt++) {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$processCondition)
  foreach($window in $windows) {
    $item=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$nameCondition)
    if($item) {
      $pattern=$item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      Write-Output 'INVOKED owned native menu'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}
$windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$processCondition)
foreach($window in $windows) {
  Write-Output ('WINDOW: '+$window.Current.Name)
  $elements=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($element in $elements) { if($element.Current.ControlType.ProgrammaticName -match 'Menu') {Write-Output ($element.Current.ControlType.ProgrammaticName+'|'+$element.Current.Name)} }
}
throw 'Owned native menu item was not found' 
`
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true },
    )
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stderr.on('data', (data) => {
      output += data.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(Error('Native menu invocation timed out'))
    }, 20000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(Error(output))
    })
  })
}

async function boundarySuite() {
  const conflict = async (name, attrs, bom = false) => {
    const f = await fixture(name, 'qa/local'),
      file = 'nested/file.txt'
    for (const [key, value] of [
      ['core.hooksPath', '.git/no-hooks'],
      ['filter.lfs.process', ''],
      ['filter.lfs.required', 'false'],
      ['filter.lfs.clean', 'cat'],
      ['filter.lfs.smudge', 'cat'],
    ])
      await git.git(f.repo, ['config', key, value])
    await fs.mkdir(path.join(f.repo, 'nested'))
    await fs.writeFile(path.join(f.repo, 'nested', '.gitattributes'), attrs)
    await commit(f.repo, file, (bom ? '\ufeff' : '') + 'base\n', 'conflict baseline')
    await git.git(f.repo, ['switch', '-c', 'qa/incoming'])
    const incoming = await commit(f.repo, file, (bom ? '\ufeff' : '') + 'incoming\n', 'incoming')
    await git.git(f.repo, ['switch', 'qa/local'])
    await commit(f.repo, file, (bom ? '\ufeff' : '') + 'local\n', 'local')
    await git.git(f.repo, ['merge', '--no-commit', incoming], { allowedCodes: [0, 1] })
    return { ...f, file }
  }
  const a = await conflict('small-markers', '*.txt conflict-marker-size=3\n', true)
  const state = await launch('boundaries'),
    { page } = state
  try {
    await open(state, a.repo)
    await check(
      'packaged Windows respects small conflict markers, preserves BOM versions and saves valid Markdown underlines',
      async () => {
        await page.getByRole('button', { name: a.file, exact: true }).click()
        const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
        await editor.getByText('剩余 1 个冲突块', { exact: true }).waitFor()
        assert.equal(
          await editor.getByRole('button', { name: '保存并标记已解决', exact: true }).isEnabled(),
          false,
        )
        assert.ok(
          (await editor.locator('.merge-pane pre').first().textContent()).startsWith('\ufefflocal'),
        )
        await shot(state, '01-native-small-markers')
        const content = '\ufeffHeading\n=======\nresolved\n'
        await editor.getByRole('textbox', { name: '编辑合并结果', exact: true }).fill(content)
        await action(state, a.repo, 'merge-resolve', () =>
          editor.getByRole('button', { name: '保存并标记已解决', exact: true }).click(),
        )
        assert.equal(await fs.readFile(path.join(a.repo, a.file), 'utf8'), content)
      },
    )
    await check(
      'packaged Windows protects filtered files from manual editing and supports whole-version resolution',
      async () => {
        const b = await conflict('filtered-conflict', '*.txt filter=lfs merge=text\n')
        await open(state, b.repo)
        await page.getByRole('button', { name: b.file, exact: true }).click()
        const editor = page.getByRole('region', { name: '冲突解决编辑器', exact: true })
        await editor.getByText('合并结果 · 只读', { exact: true }).waitFor()
        assert.equal(
          await editor
            .getByRole('textbox', { name: '编辑合并结果', exact: true })
            .evaluate((node) => node.readOnly),
          true,
        )
        assert.equal(
          await editor.getByRole('button', { name: '保存并标记已解决', exact: true }).isEnabled(),
          false,
        )
        await shot(state, '02-native-filter-readonly')
        await action(state, b.repo, 'merge-resolve', () =>
          editor.getByRole('button', { name: '整文件采用当前分支', exact: true }).click(),
        )
        assert.equal(await fs.readFile(path.join(b.repo, b.file), 'utf8'), 'local\n')
      },
    )
    await check('packaged Windows displays and stages paths beyond 260 characters', async () => {
      const f = await fixture('long-path', 'qa/long')
      await git.git(f.repo, ['config', 'core.longpaths', 'false'])
      const file =
        Array.from({ length: 10 }, (_, i) => 'directory-' + i + '-abcdefghijklmnop').join('/') +
        '/deep.txt'
      await fs.mkdir(path.dirname(path.join(f.repo, file)), { recursive: true })
      await fs.writeFile(path.join(f.repo, file), 'deep\n')
      assert.ok(path.join(f.repo, file).length > 260)
      await open(state, f.repo)
      const main = page.locator(`.file-main[data-file-path="${file}"][data-file-staged="false"]`)
      await main.waitFor()
      await main.locator('..').hover()
      await action(state, f.repo, 'stage', () =>
        page.getByRole('button', { name: '暂存 ' + file, exact: true }).click(),
      )
      assert.ok((await git.status(f.repo)).staged.some((entry) => entry.path === file))
      await shot(state, '03-native-long-path')
    })
    await check(
      'packaged Windows parent repository refreshes after an external commit inside a submodule',
      async () => {
        const f = await fixture('module-parent', 'qa/parent'),
          source = path.join(f.directory, 'module-source')
        await fs.mkdir(source)
        await git.git(source, ['init', '-b', 'qa/module'])
        await configure(source)
        await commit(source, 'file.txt', 'base\n', 'module baseline')
        await git.git(f.repo, [
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          source,
          'deps/child',
        ])
        await git.git(f.repo, ['commit', '-am', 'add module'])
        const sub = path.join(f.repo, 'deps', 'child')
        await configure(sub)
        await open(state, f.repo)
        await page.evaluate((repo) => window.gitcode.repositoryChanges(repo), f.repo)
        await commit(sub, 'file.txt', 'externally updated\n', 'module external commit')
        await page
          .locator('.file-main[data-file-path="deps/child"][data-file-staged="false"]')
          .waitFor({ timeout: 10000 })
        await shot(state, '04-native-submodule-refresh')
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
      },
    )
  } finally {
    await closeClean(state)
  }
}

async function releaseRegressionSuite() {
  const f = await fixture('release-regressions', 'qa/base')
  const head = await commit(f.repo, 'entry', 'old entry\n', 'path baseline')
  await git.git(f.repo, ['tag', 'qa/base'])
  await git.git(f.repo, ['notes', 'add', '-m', 'QA internal note'])
  const tree = (await git.git(f.repo, ['rev-parse', 'HEAD^{tree}'])).trim()
  const hidden = (
    await git.git(f.repo, ['commit-tree', tree, '-m', 'QA prefetch-only commit'])
  ).trim()
  await git.git(f.repo, ['update-ref', 'refs/prefetch/remotes/origin/hidden', hidden])
  await git.git(f.repo, ['mv', 'shared.txt', 'renamed.txt'])
  await fs.rm(path.join(f.repo, 'entry'))
  await fs.mkdir(path.join(f.repo, 'entry'))
  await fs.writeFile(path.join(f.repo, 'entry', 'child.txt'), 'unselected new content\n')
  const state = await launch('release-regressions'),
    { page } = state
  try {
    await open(state, f.repo)
    await page.getByRole('button', { name: '列表视图', exact: true }).click()
    await check(
      'packaged Windows uses the exact branch with a same-name tag and pushes only the intended remote ref',
      async () => {
        assert.ok(!(await page.locator('body').innerText()).includes('heads/qa/base'))
        await pushUI(state, f.repo)
        assert.equal((await git.git(f.remote, ['rev-parse', 'refs/heads/qa/base'])).trim(), head)
        assert.deepEqual(
          (await git.git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']))
            .trim()
            .split('\n'),
          ['refs/heads/qa/base'],
        )
      },
    )
    await check('packaged Windows normal graph excludes Notes and prefetch commits', async () => {
      const snapshot = await page.evaluate((repo) => window.gitcode.snapshot(repo), f.repo)
      assert.equal(snapshot.total, 2)
      assert.ok(!snapshot.commits.some((c) => c.hash === hidden))
      assert.ok(!(await page.locator('body').innerText()).includes('Notes added'))
    })
    await check(
      'packaged Windows shows staged rename metadata rather than a whole-file addition',
      async () => {
        await page
          .locator('.file-main[data-file-path="renamed.txt"][data-file-staged="true"]')
          .click()
        await page.locator('.diff-scroll').filter({ hasText: 'rename from shared.txt' }).waitFor()
        assert.ok(!(await page.locator('.diff-scroll').innerText()).includes('new file mode'))
        await shot(state, '01-native-identity-history-rename')
      },
    )
    await check(
      'packaged Windows blocks incomplete path selections and supports explicit combined stage and unstage',
      async () => {
        const index = await git.indexFingerprint(f.repo)
        await page.locator('.worktree-node-row[data-worktree-path="entry"]').hover()
        await action(
          state,
          f.repo,
          'stage',
          () => page.getByRole('button', { name: '暂存 entry', exact: true }).click(),
          ['failed'],
        )
        assert.equal(await git.indexFingerprint(f.repo), index)
        assert.ok((await page.locator('.toast.error').last().innerText()).includes('一并选择'))
        await shot(state, '02-native-incomplete-selection')
        for (const file of ['entry', 'entry/child.txt'])
          await page.getByRole('checkbox', { name: '选择暂存 ' + file, exact: true }).check()
        await action(state, f.repo, 'stage', () =>
          page.getByRole('button', { name: '暂存所选（2）', exact: true }).click(),
        )
        assert.ok((await git.status(f.repo)).staged.some((file) => file.path === 'entry/child.txt'))
        for (const file of ['entry', 'entry/child.txt'])
          await page.getByRole('checkbox', { name: '选择取消暂存 ' + file, exact: true }).check()
        await action(state, f.repo, 'unstage', () =>
          page.getByRole('button', { name: '取消暂存所选（2）', exact: true }).click(),
        )
        assert.deepEqual(
          (await git.status(f.repo)).staged.map((file) => file.path),
          ['renamed.txt'],
        )
        assert.equal(
          await fs.readFile(path.join(f.repo, 'entry', 'child.txt'), 'utf8'),
          'unselected new content\n',
        )
        await shot(state, '03-native-complete-selection')
      },
    )
    await check(
      'packaged Windows reword preserves hash-prefixed messages through the unpacked editor helper',
      async () => {
        const r = await fixture('release-rebase', 'qa/base')
        await git.git(r.repo, ['switch', '-c', 'qa/target'])
        const target = await commit(r.repo, 'target.txt', 'target\n', 'target change')
        await git.git(r.repo, ['switch', '-c', 'qa/topic', r.head])
        await commit(r.repo, 'topic.txt', 'topic\n', 'topic change')
        await open(state, r.repo)
        await page
          .locator('[data-sidebar-section="local"] [data-branch-name="qa/target"] .branch-main')
          .click({ button: 'right' })
        await invokeNativeMenu(state, '交互式变基 qa/topic 到 qa/target')
        const panel = page.getByRole('region', { name: '交互式变基', exact: true })
        await panel.locator('select').selectOption('reword')
        await panel.locator('textarea').fill('#literal title\n\n#literal body')
        await action(state, r.repo, 'rebase-start', () =>
          panel.getByRole('button', { name: '开始变基', exact: true }).click(),
        )
        assert.equal(
          (await git.git(r.repo, ['log', '-1', '--format=%B'])).trim(),
          '#literal title\n\n#literal body',
        )
        assert.equal((await git.git(r.repo, ['rev-parse', 'HEAD~1'])).trim(), target)
        assert.equal(await git.currentBranch(r.repo), 'qa/topic')
        await shot(state, '04-native-hash-reword')
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
      },
    )
  } finally {
    await closeClean(state)
  }
}

async function commitDiagnosticsSuite() {
  const f = await fixture('commit-diagnostics', 'qa/hooks')
  const hooks = path.join(f.repo, '.git', 'QA hooks')
  await fs.mkdir(hooks)
  await git.git(f.repo, ['config', 'core.hooksPath', '.git/QA hooks'])
  const hook = (name, body) => fs.writeFile(path.join(hooks, name), '#!/bin/sh\n' + body + '\n')
  await fs.writeFile(path.join(f.repo, 'shared.txt'), 'staged edit\n')
  await git.git(f.repo, ['add', 'shared.txt'])
  const state = await launch('commit-diagnostics'),
    { page } = state
  const submit = () => page.getByRole('button', { name: /提交 \d+ 个文件/ }).click()
  const draft = page.getByRole('textbox', { name: '提交说明', exact: true })
  const inspectLog = async (text) => {
    const toast = page.locator('.toast.error').last()
    await toast.getByRole('button', { name: '查看日志', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '活动日志', exact: true })
    await page.waitForFunction(
      (value) => document.querySelector('.activity-log-detail')?.textContent.includes(value),
      text,
    )
    assert.ok((await dialog.locator('.activity-log-detail').innerText()).includes(text))
    return dialog
  }
  try {
    await open(state, f.repo)
    await draft.fill('Native attempted commit')
    await check(
      'packaged Windows formatter rejection preserves draft, index, worktree and matching hook log',
      async () => {
        await hook(
          'pre-commit',
          "printf 'formatter edit\\n' > shared.txt\nprintf 'QA_NATIVE_FORMATTER\\n' >&2\nexit 1",
        )
        await action(state, f.repo, 'commit', submit, ['failed'])
        assert.equal(await draft.inputValue(), 'Native attempted commit')
        assert.equal(await git.head(f.repo), f.head)
        assert.equal(await git.git(f.repo, ['show', ':shared.txt']), 'staged edit\n')
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'formatter edit\n')
        const dialog = await inspectLog('pre-commit：退出码 1')
        assert.ok(
          (await dialog.locator('.activity-log-detail').innerText()).includes(
            'QA_NATIVE_FORMATTER',
          ),
        )
        await shot(state, '01-native-hook-log')
        await dialog.getByRole('button', { name: '关闭活动日志', exact: true }).click()
      },
    )
    await check(
      'packaged Windows commit-msg failure keeps editable message and does not create commit',
      async () => {
        await fs.rm(path.join(hooks, 'pre-commit'))
        await hook('commit-msg', 'exit 2')
        await action(state, f.repo, 'commit', submit, ['failed'])
        assert.equal(await draft.inputValue(), 'Native attempted commit')
        assert.equal(await git.head(f.repo), f.head)
        const dialog = await inspectLog('commit-msg：退出码 2')
        await dialog.getByRole('button', { name: '关闭活动日志', exact: true }).click()
      },
    )
    await check(
      'packaged Windows identifies a real missing Node command in the GUI hook environment',
      async () => {
        await fs.rm(path.join(hooks, 'commit-msg'))
        await hook('pre-commit', 'node --version')
        await action(state, f.repo, 'commit', submit, ['failed'])
        assert.equal(await draft.inputValue(), 'Native attempted commit')
        assert.ok((await page.locator('.toast.error').last().innerText()).includes('PATH'))
        assert.equal(await git.head(f.repo), f.head)
        const dialog = await inspectLog('pre-commit：退出码 127')
        await shot(state, '02-native-missing-node')
        await dialog.getByRole('button', { name: '关闭活动日志', exact: true }).click()
      },
    )
    await check(
      'packaged Windows signing failure preserves message and staged content',
      async () => {
        await fs.rm(path.join(hooks, 'pre-commit'))
        await git.git(f.repo, ['config', 'commit.gpgsign', 'true'])
        await git.git(f.repo, ['config', 'gpg.format', 'openpgp'])
        await git.git(f.repo, [
          'config',
          'gpg.program',
          path.join(f.repo, 'missing-signing-program'),
        ])
        await action(state, f.repo, 'commit', submit, ['failed'])
        assert.equal(await draft.inputValue(), 'Native attempted commit')
        assert.ok(
          (await page.locator('.toast.error').last().innerText()).includes('提交签名未完成'),
        )
        assert.equal(await git.head(f.repo), f.head)
        assert.equal(await git.git(f.repo, ['show', ':shared.txt']), 'staged edit\n')
        await shot(state, '02-native-signing-failure')
      },
    )
    await check(
      'packaged Windows post-commit failure reports commit created, clears draft and never commits unstaged formatter edits',
      async () => {
        await git.git(f.repo, ['config', 'commit.gpgsign', 'false'])
        await hook('post-commit', 'exit 9')
        await action(state, f.repo, 'commit', submit, ['succeeded'])
        assert.equal(await draft.inputValue(), '')
        assert.equal(
          (await git.git(f.repo, ['rev-list', '--count', `${f.head}..HEAD`])).trim(),
          '1',
        )
        assert.equal(await git.git(f.repo, ['show', 'HEAD:shared.txt']), 'staged edit\n')
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), 'formatter edit\n')
        assert.ok((await page.locator('.toast.error').last().innerText()).includes('提交已创建'))
        const dialog = await inspectLog('post-commit：退出码 9')
        await shot(state, '03-native-created-with-warning')
        await dialog.getByRole('button', { name: '关闭活动日志', exact: true }).click()
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
      },
    )
  } finally {
    await closeClean(state)
  }
}

async function partialStageSuite() {
  const f = await fixture('partial-stage', 'qa/partial')
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`)
  await commit(f.repo, 'shared.txt', base.join(''), 'native partial base')
  const work = [...base]
  work[3] = 'first edit\n'
  work[25] = 'second edit\n'
  await fs.writeFile(path.join(f.repo, 'shared.txt'), work.join(''))
  const state = await launch('partial-stage'),
    { page } = state
  const choose = async () => {
    const exit = page.getByRole('button', { name: '退出选择', exact: true })
    if (await exit.count()) await exit.click()
    await page.locator('.file-main[data-file-path="shared.txt"][data-file-staged="false"]').click()
    await page.getByRole('button', { name: '选择修改', exact: true }).click()
  }
  const blob = () => git.git(f.repo, ['show', ':shared.txt'])
  try {
    await open(state, f.repo)
    const draft = page.getByRole('textbox', { name: '提交说明', exact: true })
    await draft.fill('Native partial commit')
    const staged = [...base]
    staged[3] = 'first edit\n'
    await check(
      'packaged Windows stages only selected lines and preserves draft and working bytes',
      async () => {
        await choose()
        await page.getByRole('button', { name: '选择修改块 1', exact: true }).click()
        assert.equal(await page.locator('.partial-gutter input:checked').count(), 2)
        await shot(state, '01-native-line-selection')
        await action(state, f.repo, 'partial-stage', () =>
          page.getByRole('button', { name: /^暂存所选行/ }).click(),
        )
        assert.equal(await blob(), staged.join(''))
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), work.join(''))
        assert.equal(await draft.inputValue(), 'Native partial commit')
      },
    )
    await check(
      'packaged Windows unstages a single added line and then the remaining block without touching the worktree',
      async () => {
        await page.getByRole('button', { name: '暂存内容', exact: true }).click()
        await page.getByRole('button', { name: '选择修改', exact: true }).click()
        await page
          .locator('.diff-line.add')
          .filter({ hasText: '+first edit' })
          .getByRole('checkbox')
          .check()
        await shot(state, '02-native-unstage-line')
        await action(state, f.repo, 'partial-stage', () =>
          page.getByRole('button', { name: /^取消暂存所选行/ }).click(),
        )
        const removed = [...base]
        removed.splice(3, 1)
        assert.equal(await blob(), removed.join(''))
        await action(state, f.repo, 'partial-stage', () =>
          page.getByRole('button', { name: '取消暂存修改块 1', exact: true }).click(),
        )
        await page.getByRole('button', { name: '选择修改', exact: true }).waitFor()
        assert.equal(await page.locator('.partial-warning').count(), 0)
        assert.equal(await blob(), base.join(''))
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), work.join(''))
      },
    )
    await check(
      'packaged Windows commit includes the selected hunk only and leaves the other edit uncommitted',
      async () => {
        await choose()
        await action(state, f.repo, 'partial-stage', () =>
          page.getByRole('button', { name: '暂存修改块 1', exact: true }).click(),
        )
        await action(state, f.repo, 'commit', () =>
          page.getByRole('button', { name: /^提交 1 个文件/ }).click(),
        )
        assert.equal(await git.git(f.repo, ['show', 'HEAD:shared.txt']), staged.join(''))
        assert.equal(await blob(), staged.join(''))
        assert.equal(await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'), work.join(''))
        assert.equal(await draft.inputValue(), '')
        await shot(state, '03-native-partial-commit')
      },
    )
    await check(
      'packaged Windows keeps stale selections visible and blocks them until explicitly reread',
      async () => {
        await choose()
        await page.getByRole('button', { name: '选择修改块 1', exact: true }).click()
        await fs.writeFile(path.join(f.repo, 'shared.txt'), work.join('') + 'external append\n')
        await page.locator('.partial-warning').waitFor({ timeout: 20000 })
        assert.equal(await page.locator('.partial-gutter input:checked').count(), 2)
        assert.equal(await page.getByRole('button', { name: /^暂存所选行/ }).isDisabled(), true)
        await shot(state, '04-native-stale-selection')
        await page.getByRole('button', { name: '重新读取', exact: true }).click()
        await page.waitForFunction(() =>
          document.querySelector('.diff-scroll')?.textContent.includes('external append'),
        )
        assert.equal(await page.locator('.partial-gutter input:checked').count(), 0)
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
      },
    )
  } catch (error) {
    await shot(state, 'partial-stage-failure').catch(() => {})

    await fs
      .writeFile(path.join(artifacts, 'partial-stage-failure.html'), await page.content())
      .catch(() => {})
    throw error
  } finally {
    await closeClean(state)
  }
}

async function recoverySuite() {
  const f = await fixture('native-recovery', 'qa/native')
  const localHead = await commit(
    f.repo,
    'shared.txt',
    'local second commit\n',
    'native local second commit',
  )
  let state = await launch('native-recovery')
  const recovery = async () => {
    await state.page
      .getByRole('menubar', { name: '应用菜单' })
      .getByRole('menuitem', { name: '仓库 Repository', exact: true })
      .click()
    await state.page.getByRole('menuitem', { name: 'Git 操作恢复…', exact: true }).click()
    const dialog = state.page.getByRole('dialog', { name: 'Git 操作恢复', exact: true })
    await dialog.getByRole('button', { name: '刷新', exact: true }).waitFor()
    await state.page.waitForFunction(
      () => !document.querySelector('.recovery-footer button')?.disabled,
    )
    return dialog
  }
  try {
    await open(state, f.repo)
    const input = state.page.getByRole('textbox', { name: '提交说明', exact: true })
    await input.fill('Keep native recovery draft')
    await check(
      'packaged Windows recovery preserves index, worktree and commit draft while undoing a local commit',
      async () => {
        const dialog = await recovery()
        await dialog.getByRole('checkbox', { name: '我已确认该提交尚未共享' }).check()
        await shot(state, '01-native-undo-preview')
        const index = await git.indexFingerprint(f.repo)
        await dialog.getByRole('button', { name: '撤回提交并保留代码', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await git.head(f.repo), f.head)
        assert.equal(await git.indexFingerprint(f.repo), index)
        assert.equal(
          await fs.readFile(path.join(f.repo, 'shared.txt'), 'utf8'),
          'local second commit\n',
        )
        assert.equal(await input.inputValue(), 'Keep native recovery draft')
      },
    )
    await check(
      'packaged Windows restores the original commit as a new branch without switching checkout',
      async () => {
        const dialog = await recovery()
        await dialog
          .getByRole('combobox', { name: '恢复点', exact: true })
          .selectOption({ index: 1 })
        await dialog
          .getByRole('textbox', { name: '恢复后的本地分支名', exact: true })
          .fill('qa/restored')
        await shot(state, '02-native-restore-preview')
        await dialog.getByRole('button', { name: '恢复为本地分支', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal((await git.git(f.repo, ['rev-parse', 'qa/restored'])).trim(), localHead)
        assert.equal(await git.currentBranch(f.repo), 'qa/native')
      },
    )
    await input.fill('')
    await check(
      'packaged Windows branch deletion recovery survives a clean app restart',
      async () => {
        await state.page
          .locator('[data-sidebar-section="local"] [data-branch-name="qa/restored"] .branch-main')
          .click({ button: 'right' })
        await invokeNativeMenu(state, '删除 qa/restored')
        await state.page.getByRole('button', { name: '确认删除本地分支', exact: true }).click()
        await state.page
          .locator('[data-sidebar-section="local"] [data-branch-name="qa/restored"]')
          .waitFor({ state: 'hidden' })
        const profile = state.profile
        await closeClean(state)
        state = await launch('native-recovery-restored', profile)
        const dialog = await recovery()
        await dialog
          .getByRole('combobox', { name: '恢复点', exact: true })
          .selectOption({ index: 1 })
        assert.equal(
          await dialog
            .getByRole('textbox', { name: '恢复后的本地分支名', exact: true })
            .inputValue(),
          'qa/restored',
        )
        await shot(state, '03-native-restart-recovery')
        await dialog.getByRole('button', { name: '恢复为本地分支', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal((await git.git(f.repo, ['rev-parse', 'qa/restored'])).trim(), localHead)
        assert.equal(await git.head(f.repo), f.head)
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
        await shot(state, '04-native-recovered-branch')
      },
    )
  } finally {
    await closeClean(state)
  }
}

async function observationSuite() {
  const f = await fixture('external-observation', 'qa/first')
  await git.git(f.repo, ['branch', 'qa/other'])
  const state = await launch('external-observation')
  try {
    await open(state, f.repo)
    await state.page.waitForFunction(
      async (repo) => (await window.gitcode.repositoryChanges(repo)).watched > 0,
      f.repo,
    )
    const input = state.page.getByRole('textbox', { name: '提交说明', exact: true })
    const file = path.join(f.repo, 'shared.txt')
    const index = await git.indexFingerprint(f.repo)
    await check(
      'packaged Windows detects external saves without moving commit focus or writing the index',
      async () => {
        await input.fill('Keep native commit draft')
        await input.evaluate((node) => {
          node.focus()
          node.setSelectionRange(2, 6)
        })
        await fs.writeFile(file, 'external native edit\n')
        await state.page
          .locator('.file-main[data-file-path="shared.txt"][data-file-staged="false"]')
          .waitFor({ timeout: 20000 })
        assert.equal(await input.inputValue(), 'Keep native commit draft')
        assert.ok(
          await input.evaluate(
            (node) =>
              document.activeElement === node &&
              node.selectionStart === 2 &&
              node.selectionEnd === 6,
          ),
        )
        assert.equal(await git.indexFingerprint(f.repo), index)
        await shot(state, '01-native-external-save')
      },
    )
    await check(
      'packaged Windows observes terminal staging, commits and branch checkout automatically',
      async () => {
        await git.git(f.repo, ['add', 'shared.txt'])
        await state.page
          .locator('.file-main[data-file-path="shared.txt"][data-file-staged="true"]')
          .waitFor({ timeout: 20000 })
        await git.git(f.repo, ['commit', '-m', 'native terminal commit'])
        await state.page.waitForFunction(
          () =>
            document
              .querySelector('.history-panel')
              ?.textContent.includes('native terminal commit'),
          {},
          { timeout: 20000 },
        )
        await git.git(f.repo, ['switch', 'qa/other'])
        await state.page.waitForFunction(
          () =>
            document.querySelector('.branch-selector summary')?.textContent.includes('qa/other'),
          {},
          { timeout: 20000 },
        )
        assert.equal(await input.inputValue(), 'Keep native commit draft')
        await shot(state, '02-native-external-checkout')
      },
    )
    await check(
      'packaged Windows defers an external index lock and recovers after it is released',
      async () => {
        const lock = path.join(f.repo, '.git', 'index.lock')
        await fs.writeFile(lock, 'owned acceptance lock')
        try {
          await fs.writeFile(file, 'edit during external lock\n')
          await state.page.waitForFunction(
            () =>
              document.querySelector('.statusbar')?.textContent.includes('等待其他 Git 操作完成'),
            {},
            { timeout: 20000 },
          )
          assert.equal(await fs.readFile(lock, 'utf8'), 'owned acceptance lock')
          assert.equal(await input.inputValue(), 'Keep native commit draft')
          await shot(state, '03-native-external-lock')
        } finally {
          await fs.unlink(lock)
        }
        await state.page
          .locator('.file-main[data-file-path="shared.txt"][data-file-staged="false"]')
          .waitFor({ timeout: 20000 })
        await state.page.waitForFunction(
          () =>
            !document.querySelector('.statusbar')?.textContent.includes('等待其他 Git 操作完成'),
        )
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.failedAssets, [])
        await shot(state, '04-native-external-recovered')
      },
    )
    await input.fill('')
  } finally {
    await closeClean(state)
  }
}

async function startupSuite() {
  const first = await fixture('startup-first'),
    second = await fixture('startup-second')
  const state = await launch('startup-session', undefined, { startupShot: '01-native-launch' })
  let restored, retry
  const moved = first.repo + '.unavailable'
  let unavailable = false
  try {
    await open(state, first.repo)
    await open(state, second.repo)
    const profile = state.profile
    await closeClean(state)
    await check(
      'packaged launch restores tabs and active repository; startup and exit timings persist in application logs',
      async () => {
        restored = await launch('startup-restored', profile, {
          resetSettings: false,
          startupShot: '02-native-restoring',
        })
        assert.equal(
          await restored.page.locator('.repo-selector').getAttribute('title'),
          '打开本地仓库：' + second.repo,
        )
        assert.equal(await restored.page.locator('.repo-tab').count(), 2)
        const log = await restored.page.evaluate(async () => {
          const summary = await window.gitcode.operationLog({ scope: 'application' })
          return {
            records: await Promise.all(
              summary.records
                .filter((record) => record.operation.startsWith('application-'))
                .map(async (record) => {
                  const detail = await window.gitcode.operationLog({
                    scope: 'application',
                    id: record.id,
                  })
                  return detail.records.find((item) => item.id === record.id)
                }),
            ),
          }
        })
        const startup = log.records.find(
          (record) =>
            record.operation === 'application-startup' &&
            record.state === 'succeeded' &&
            record.output.includes('开始恢复活动仓库'),
        )
        assert.ok(startup, JSON.stringify(log.records))
        assert.ok(startup.output.includes('ms'))
        assert.ok(
          log.records.some(
            (record) => record.operation === 'application-exit' && record.state === 'succeeded',
          ),
        )
        await fs.writeFile(
          path.join(artifacts, 'lifecycle-records.json'),
          JSON.stringify(
            log.records.filter((record) => record.operation.startsWith('application-')),
            null,
            2,
          ),
        )
        await shot(restored, '03-native-restored-tabs')
        await restored.page.getByTitle(first.repo, { exact: true }).click()
        await idle(restored)
        assert.equal(
          await restored.page.locator('.repo-selector').getAttribute('title'),
          '打开本地仓库：' + first.repo,
        )
        assert.equal(await git.head(first.repo), first.head)
        assert.equal(await git.head(second.repo), second.head)
      },
    )
    await closeClean(restored)
    await fs.rename(first.repo, moved)
    unavailable = true
    await check(
      'missing startup repository offers retry and returns to the real workspace after the path is restored',
      async () => {
        retry = await launch('startup-missing', profile, { resetSettings: false })
        const screen = retry.page.getByRole('region', { name: '应用启动状态', exact: true })
        await screen.waitFor()
        await screen.getByRole('button', { name: '重试', exact: true }).waitFor()
        await shot(retry, '04-native-missing-repository')
        await fs.rename(moved, first.repo)
        unavailable = false
        await screen.getByRole('button', { name: '重试', exact: true }).click()
        await screen.waitFor({ state: 'hidden' })
        await idle(retry)
        assert.equal(
          await retry.page.locator('.repo-selector').getAttribute('title'),
          '打开本地仓库：' + first.repo,
        )
        await shot(retry, '05-native-retry-success')
        assert.deepEqual(retry.errors, [])
      },
    )
  } finally {
    if (unavailable) await fs.rename(moved, first.repo)
    if (retry) await closeClean(retry)
    if (restored) await closeClean(restored)
    await closeClean(state)
  }
}
async function toastSuite() {
  const f = await fixture('toast'),
    state = await launch('toast')
  const metadata = path.join(f.repo, '.git'),
    hidden = path.join(f.repo, '.git-qa-hidden')
  let moved = false
  try {
    await open(state, f.repo)
    await check(
      'native IPC rejection stays a compact error toast with expandable original details',
      async () => {
        await fs.rename(metadata, hidden)
        moved = true
        await state.page
          .locator('.toolbar-actions')
          .getByRole('button', { name: '刷新', exact: true })
          .click()
        const toast = state.page.locator('.toast.error').last()
        await toast.waitFor()
        const content = toast.locator('.toast-content')
        assert.ok(!(await content.innerText()).includes('Error invoking remote method'))
        const pre = toast.locator('pre')
        assert.equal(await pre.isVisible(), false)
        await shot(state, '01-native-error-summary')
        await toast.locator('summary').click()
        assert.equal(await pre.isVisible(), true)
        assert.ok((await pre.innerText()).includes('Error invoking remote method'))
        await shot(state, '02-native-error-details')
        await new Promise((resolve) => setTimeout(resolve, 10000))
        assert.equal(await toast.isVisible(), true)
        await toast.getByRole('button', { name: '关闭提示', exact: true }).click()
        await fs.rename(hidden, metadata)
        moved = false
        await refresh(state)
        assert.equal(await git.head(f.repo), f.head)
        assert.deepEqual(state.errors, [])
      },
    )
  } finally {
    if (moved) await fs.rename(hidden, metadata)
    await closeClean(state)
  }
}
async function existingSshCheck() {
  if (!options['ssh-url']) {
    limitations.push({
      kind: 'environment',
      area: 'existing-SSH',
      reason: '未提供真实 SSH 只读验证目标；测试不修改用户私钥或已知主机。',
    })
    return
  }
  const f = await fixture('existing-ssh')
  const configured =
    process.env.GIT_SSH_COMMAND ||
    (await git.git(f.repo, ['config', '--get', 'core.sshCommand'], { optional: true })) ||
    'ssh'
  const command = quietSsh(configured)
  if (!command) {
    limitations.push({
      kind: 'environment',
      area: 'existing-SSH',
      reason: '当前自定义 SSH 工具不能确认非交互模式。',
    })
    return
  }
  git.background = true
  git.backgroundSsh = command + ' -o ConnectTimeout=10'
  try {
    await git.git(f.repo, ['ls-remote', '--', options['ssh-url'], 'HEAD'], { timeout: 15000 })
    checks.push({
      name: 'existing Windows SSH identity reads the authorized remote HEAD without modifying the server',
      passed: true,
    })
  } catch (error) {
    limitations.push({ kind: 'environment', area: 'existing-SSH', reason: git.safeError(error) })
  } finally {
    git.background = false
    git.backgroundSsh = null
  }
}

async function main() {
  if (process.platform !== 'win32') throw Error('Run native acceptance on Windows')
  await fs.mkdir(artifacts, { recursive: true })
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-native-acceptance-'))
  await fs.writeFile(
    path.join(root, 'owner.json'),
    JSON.stringify({ task: 'desktop-acceptance', root, application: appDirectory }),
  )
  const suites = [
    businessSuite,
    terminalSuite,
    flowSuite,
    lifecycleSuite,
    authSuite,
    toastSuite,
    startupSuite,
    observationSuite,
    recoverySuite,
    partialStageSuite,
    commitDiagnosticsSuite,
    releaseRegressionSuite,
    boundarySuite,
  ].filter((suite) => !options.suite || suite.name === options.suite)
  try {
    for (const suite of suites) {
      try {
        await suite()
      } catch (error) {
        console.error(git.safeError(error))
        if (checks.at(-1)?.passed !== false)
          checks.push({ name: suite.name, passed: false, error: git.safeError(error) })
      }
    }
    if (!options.suite || options.suite === 'authSuite') await existingSshCheck()
    await report(true)
    if (checks.some((check) => !check.passed)) process.exitCode = 1
  } finally {
    for (const app of apps) {
      try {
        await app.close()
      } catch {
        try {
          app.process().kill()
        } catch {
          /* Already exited. */
        }
      }
    }
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
// An unresolved driver promise must never look like a successful test run.
const watchdog = setTimeout(
  () => {
    console.error('Native acceptance exceeded its 20-minute deadline')
    process.exit(1)
  },
  20 * 60 * 1000,
)
process.on('exit', (code) => {
  require('node:fs').writeFileSync(
    path.join(artifacts, `runner-exit-${options.suite || 'all'}.json`),
    JSON.stringify({
      code,
      at: new Date().toISOString(),
      checks: checks.length,
      pid: process.pid,
      root,
    }),
  )
})
main()
  .catch((error) => {
    console.error(error.stack)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(watchdog))
