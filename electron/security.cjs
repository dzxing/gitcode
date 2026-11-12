'use strict'

const fs = require('node:fs')
const { fileURLToPath } = require('node:url')

function allowedNavigation(value, { development, indexUrl }) {
  try {
    const url = new URL(value)
    if (development) return url.origin === 'http://localhost:43187'
    if (url.href.split('#')[0] === indexUrl) return true
    const expected = new URL(indexUrl)
    if (
      url.protocol !== 'file:' ||
      expected.protocol !== 'file:' ||
      url.host !== expected.host ||
      url.pathname.startsWith('//') ||
      url.search !== expected.search
    )
      return false
    // Windows may expand an 8.3 installation path when navigating to the file.
    // Compare the actual trusted file, without accepting other pages or hosts.
    return fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(fileURLToPath(expected))
  } catch {
    return false
  }
}

function assertSender(event, window, options) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !allowedNavigation(event.senderFrame.url, options)
  ) {
    throw new Error('不允许从此页面执行桌面操作。')
  }
}

module.exports = { allowedNavigation, assertSender }
