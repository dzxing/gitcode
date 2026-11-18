'use strict'
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
module.exports = { developmentPty }
