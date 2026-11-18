'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { developmentPty } = require('../electron/terminal-native.cjs')

async function prepareTerminal(root, arch = process.arch, platform = process.platform) {
  if (platform !== process.platform)
    throw Error(
      '终端原生组件需要在目标操作系统构建。请在 Windows 构建 Windows 安装包，在 macOS 构建 macOS 安装包。',
    )
  const tools = createRequire(path.join(root, 'electron/package.json'))
  const version = tools('electron/package.json').version
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, 'node_modules/node-pty/package.json'), 'utf8'),
  )
  const target = developmentPty(root, version, process.platform, arch)
  const parent = path.dirname(path.dirname(target))
  const stamp = path.join(parent, 'runtime.json')
  const expected = { electron: version, pty: metadata.version, platform: process.platform, arch }
  try {
    const saved = JSON.parse(await fs.readFile(stamp, 'utf8'))
    if (Object.keys(expected).every((key) => saved[key] === expected[key])) {
      await fs.access(
        path.join(
          target,
          saved.source === 'prebuilt' ? `prebuilds/${process.platform}-${arch}` : 'build/Release',
          process.platform === 'win32' ? 'conpty.node' : 'pty.node',
        ),
      )
      return target
    }
  } catch {
    /* Build a separate addon; never replace the browser core's Node addon. */
  }
  const base = path.dirname(parent)
  await fs.mkdir(base, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(base, 'prepare-'))
  try {
    await fs.mkdir(path.join(temporary, 'node_modules'), { recursive: true })
    for (const name of ['node-pty', 'node-addon-api'])
      await fs.cp(
        path.join(root, 'node_modules', name),
        path.join(temporary, 'node_modules', name),
        {
          recursive: true,
          filter: (file) => !file.startsWith(path.join(root, 'node_modules', name, 'build')),
        },
      )
    await fs.writeFile(
      path.join(temporary, 'package.json'),
      JSON.stringify({
        name: 'gitcode-terminal-runtime',
        private: true,
        dependencies: { 'node-pty': metadata.version },
      }),
    )
    console.log(`准备 Electron ${version} 的终端原生模块 (${process.platform}/${arch})…`)
    const compatible = () => {
      if (arch !== process.arch) return false
      const result = spawnSync(
        tools('electron'),
        [
          '-e',
          `require(${JSON.stringify(path.join(temporary, 'node_modules/node-pty'))});process.stdout.write('gitcode-pty-ready');process.exit(0)`,
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        },
      )
      return result.status === 0 && result.stdout === 'gitcode-pty-ready'
    }
    let source = 'prebuilt'
    if (!compatible()) {
      source = 'built'
      const { rebuild } = tools('@electron/rebuild')
      await rebuild({
        buildPath: temporary,
        electronVersion: version,
        arch,
        force: true,
        onlyModules: ['node-pty'],
        mode: 'sequential',
      })
      if (arch === process.arch && !compatible())
        throw Error('终端原生模块无法在当前 Electron 中加载，停止启动或打包。')
    }
    await fs.writeFile(
      path.join(temporary, 'runtime.json'),
      JSON.stringify({ ...expected, source }),
    )
    await fs.rm(parent, { recursive: true, force: true })
    await fs.rename(temporary, parent)
    return target
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}
module.exports = { prepareTerminal }
if (require.main === module)
  prepareTerminal(path.resolve(__dirname, '..')).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
