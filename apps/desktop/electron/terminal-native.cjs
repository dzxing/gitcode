'use strict'
const fs = require('node:fs')
const path = require('node:path')
function developmentPty(root, version, platform = process.platform, arch = process.arch) {
  return path.join(
    root,
    '.gitcode-local',
    'terminal-native',
    `${version}-${platform}-${arch}`,
    'node_modules',
    'node-pty',
  )
}
// node-pty 1.1.0 publishes Darwin spawn-helper without execute bits (upstream #919).
// Repair trusted dependency copies before spawning or packaging; preserve other mode bits.
function ensurePtyHelperExecutable(root, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return
  let found = false
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]) {
    const native = path.join(root, directory, 'pty.node')
    if (!fs.existsSync(native)) continue
    found = true
    const helper = path.join(root, directory, 'spawn-helper')
    const info = fs.lstatSync(helper)
    if (!info.isFile()) throw Error('macOS 终端辅助程序必须是普通文件。')
    if ((info.mode & 0o111) !== 0o111) fs.chmodSync(helper, (info.mode & 0o777) | 0o111)
  }
  if (!found) throw Error('缺少 macOS 终端原生组件，请重新安装依赖或重新打包。')
}
module.exports = { developmentPty, ensurePtyHelperExecutable }
