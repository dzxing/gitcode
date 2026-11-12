'use strict'

// Run on Windows after packaging. All repositories and profiles are temporary.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { GitService, execute } = require('../electron/git.cjs')
const { environmentForGit } = require('../electron/git-runtime.cjs')

async function verify() {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上执行本验证。')
  const appDirectory = path.resolve(process.argv[2] || 'release/bundled-git/win-unpacked')
  const resourcesPath = path.join(appDirectory, 'resources')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-bundled-git-'))
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(PATH|GITCODE_GIT_PATH|GITK_GIT_PATH|GIT_EXEC_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key))
      delete env[key]
  env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const git = new GitService({ resourcesPath, env })
  const checks = []
  let application
  try {
    const runtime = await git.runtime()
    assert.equal(runtime.gitAvailable, true, runtime.gitError)
    assert.equal(runtime.gitSource, 'bundled')
    assert.ok(runtime.gitPath.startsWith(resourcesPath))
    checks.push('内置 Git 在无系统 Git PATH、无路径覆盖时被选中')
    const isolated = environmentForGit(env, runtime.gitPath, runtime.gitSource)
    const run = async (cwd, args) => {
      const result = await execute(runtime.gitPath, args, { cwd, env: isolated })
      assert.equal(result.code, 0, result.stderr)
      return result.stdout.trim()
    }
    const repo = path.join(root, '中文 repository')
    const remote = path.join(root, 'remote.git')
    await fs.mkdir(repo)
    await run(root, ['init', '--bare', remote])
    await run(repo, ['init', '-b', 'main'])
    for (const [key, value] of [
      ['user.name', 'Bundled Git QA'],
      ['user.email', 'bundled@test.local'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.qa-hooks'],
    ])
      await run(repo, ['config', key, value])
    await fs.mkdir(path.join(repo, '.qa-hooks'))
    await fs.writeFile(
      path.join(repo, '.qa-hooks', 'pre-commit'),
      '#!/bin/sh\ngit --version > .qa-hook-version\n',
    )
    await fs.writeFile(path.join(repo, 'hello.txt'), 'initial\n')
    await run(repo, ['add', 'hello.txt'])
    await run(repo, ['commit', '-m', 'bundled runtime initial'])
    assert.equal(
      (await fs.readFile(path.join(repo, '.qa-hook-version'), 'utf8')).trim(),
      runtime.gitVersion,
    )
    checks.push('中文路径初始化、暂存、提交；shell hook 中的 Git 使用内置版本')
    await fs.writeFile(path.join(repo, 'hello.txt'), 'local draft\n')
    await run(repo, ['stash', 'push', '-m', 'bundled QA'])
    await run(repo, ['stash', 'pop'])
    assert.equal(await fs.readFile(path.join(repo, 'hello.txt'), 'utf8'), 'local draft\n')
    checks.push('贮藏与恢复保留本地修改')
    await run(repo, ['remote', 'add', 'origin', remote])
    await run(repo, ['push', '-u', 'origin', 'main'])
    assert.equal(
      await run(repo, ['rev-parse', 'HEAD']),
      await run(remote, ['rev-parse', 'refs/heads/main']),
    )
    checks.push('向临时本地裸仓库推送并建立上游')
    const ssh = await execute(path.join(resourcesPath, 'git', 'usr', 'bin', 'ssh.exe'), ['-V'], {
      env: isolated,
    })
    assert.equal(ssh.code, 0, ssh.stderr)
    await fs.access(path.join(resourcesPath, 'git', 'LICENSE.txt'))
    checks.push('SSH 可运行、许可证随包存在；未访问业务远端')

    const { _electron } = require('playwright-core')
    application = await _electron.launch({
      executablePath: path.join(appDirectory, 'GitCode.exe'),
      args: [`--user-data-dir=${path.join(root, 'profile')}`],
      env,
      timeout: 60000,
    })
    const page = await application.firstWindow()
    await page.waitForFunction(() => typeof window.gitk?.runtime === 'function')
    const actual = await page.evaluate(() => window.gitk.runtime())
    assert.equal(actual.gitSource, 'bundled')
    assert.equal(actual.gitAvailable, true, actual.gitError)
    // Open this newly created QA repository through the normal trust prompt.
    await page.getByRole('main', { name: '新标签页', exact: true }).waitFor()
    await page.keyboard.press('Control+o')
    const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
    await open.getByLabel('仓库路径', { exact: true }).fill(repo)
    await open.getByRole('button', { name: '打开仓库', exact: true }).click()
    const trust = page.getByRole('dialog', { name: '信任此仓库？', exact: true })
    await trust.getByRole('button', { name: '信任并打开', exact: true }).click()
    await trust.waitFor({ state: 'hidden' })
    await open.waitFor({ state: 'hidden' })
    const snapshot = await page.evaluate((directory) => window.gitk.snapshot(directory), repo)
    assert.equal(snapshot.branch, 'main')
    checks.push('真实打包 exe 的 runtime 与 snapshot IPC 成功，无系统 Git 依赖')
    await page.getByRole('menuitem', { name: '文件 File', exact: true }).click()
    await page.getByRole('menuitem', { name: /^设置…/ }).click()
    const preferences = page.getByRole('dialog', { name: '设置', exact: true })
    await preferences.getByRole('tab', { name: 'Git', exact: true }).click()
    await preferences.getByRole('button', { name: '配置 Git 运行环境…', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Git 运行环境', exact: true })
    await settings.getByText('应用内置', { exact: true }).waitFor()
    assert.ok((await settings.textContent()).includes(runtime.gitVersion))
    await page.screenshot({ path: path.join(appDirectory, '..', 'git-runtime-settings.png') })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    checks.push('原生窗口的文件菜单可打开设置，显示正确的内置来源、版本与路径')
    const before = await page.evaluate(() => window.gitk.gitSettings())
    assert.equal(before.selection.mode, 'auto')
    const saved = await page.evaluate(
      (custom) => window.gitk.gitSettings({ mode: 'custom', path: custom }),
      runtime.gitPath,
    )
    assert.equal(saved.restartRequired, true)
    assert.equal(
      (await page.evaluate(() => window.gitk.gitSettings())).selection.path,
      runtime.gitPath,
    )
    let invalidRejected = false
    try {
      await page.evaluate(() =>
        window.gitk.gitSettings({ mode: 'custom', path: 'relative-git.exe' }),
      )
    } catch {
      invalidRejected = true
    }
    assert.equal(invalidRejected, true)
    assert.equal(
      (await page.evaluate(() => window.gitk.gitSettings())).selection.path,
      runtime.gitPath,
    )
    await page.evaluate(() => window.gitk.gitSettings({ mode: 'auto' }))
    checks.push('真实 IPC 设置保存、路径校验和错误后原配置保留')
    const artifact = path.join(appDirectory, '..', 'bundled-git-validation.json')
    await fs.writeFile(artifact, JSON.stringify({ passed: true, runtime: actual, checks }, null, 2))
    console.log(JSON.stringify({ passed: true, runtime: actual, checks, artifact }, null, 2))
  } finally {
    if (application) await application.close()
    await git.shutdown()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

verify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
