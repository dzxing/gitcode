'use strict'
const presets = require('./theme-presets.json')

function windowColors(palette, focused = true) {
  const tokens = presets[Object.hasOwn(presets, palette) ? palette : 'dark'].tokens
  return {
    background: tokens['--window-bg'] || tokens['--bg'],
    color: focused ? tokens['--surface-tabs'] : tokens['--window-inactive-bg'],
    symbolColor: focused ? tokens['--bright'] : tokens['--window-inactive-symbol'],
  }
}

class WindowAppearance {
  constructor(window, platform = process.platform) {
    this.window = window
    this.platform = platform
    this.palette = 'dark'
    this.applied = ''
  }

  apply(palette = this.palette) {
    this.palette = Object.hasOwn(presets, palette) ? palette : 'dark'
    if (this.window.isDestroyed()) return
    const focused = this.window.isFocused()
    const key = `${this.palette}:${focused}`
    if (this.applied === key) return
    const { background, ...overlay } = windowColors(this.palette, focused)
    this.window.setBackgroundColor(background)
    if (this.platform === 'win32') this.window.setTitleBarOverlay(overlay)
    this.applied = key
  }
}
module.exports = { WindowAppearance, windowColors }
