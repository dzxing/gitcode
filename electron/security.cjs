'use strict'

function allowedNavigation(value, { development, indexUrl }) {
  try {
    const url = new URL(value)
    return development
      ? url.origin === 'http://localhost:43187'
      : url.href.split('#')[0] === indexUrl
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
