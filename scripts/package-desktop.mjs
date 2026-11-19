import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { stageDesktopApp } = require('./desktop-app.cjs')
const { archiveReleaseArtifacts } = require('./release-artifacts.cjs')
const tools = createRequire(new URL('../electron/package.json', import.meta.url))
let cli
try {
  cli = tools.resolve('electron-builder/cli.js')
} catch {
  console.error('请先安装桌面工具：bun install --cwd electron')
  process.exit(1)
}
const root = fileURLToPath(new URL('../', import.meta.url))
let directory
try {
  const targetArch = process.argv.includes('--arm64')
    ? 'arm64'
    : process.argv.includes('--x64')
      ? 'x64'
      : process.arch
  const targetPlatform = process.argv.includes('--win')
    ? 'win32'
    : process.argv.includes('--mac')
      ? 'darwin'
      : process.argv.includes('--linux')
        ? 'linux'
        : process.platform
  if (targetPlatform === 'win32') {
    if (process.platform !== 'win32') throw new Error('请在 Windows 上构建 Windows 安装包。')
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fileURLToPath(new URL('./prepare-installer.ps1', import.meta.url)),
          '-ProjectRoot',
          root,
        ],
        { cwd: root, windowsHide: true, stdio: 'inherit' },
      )
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('安装器启动器编译失败。')),
      )
    })
  }
  directory = await stageDesktopApp(root, { arch: targetArch, platform: targetPlatform })
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const archived = await archiveReleaseArtifacts(root, version)
  if (archived) console.log(`同版本既有产物已归档：${archived}`)
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        '--projectDir',
        root,
        '--config',
        'electron-builder.json',
        `--config.directories.app=${directory}`,
        ...process.argv.slice(2),
      ],
      { cwd: root, stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (error) => console.error(`临时打包目录清理失败：${error.message}`),
    )
}
