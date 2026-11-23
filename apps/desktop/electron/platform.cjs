'use strict'
// OS selection lives at this boundary. Adapters never import Electron or make
// system calls while loading; services explicitly invoke each capability.
const adapters = Object.freeze({
  win32: require('./platform-windows.cjs'),
  darwin: require('./platform-macos.cjs'),
  linux: require('./platform-linux.cjs'),
})
function getPlatform(platform = process.platform) {
  if (!Object.hasOwn(adapters, platform)) throw new Error(`当前操作系统尚不受支持：${platform}`)
  return adapters[platform]
}
module.exports = { getPlatform }
