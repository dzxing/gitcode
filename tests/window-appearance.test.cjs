const test = require('node:test')
const assert = require('node:assert/strict')
const presets = require('../electron/theme-presets.json')
const { WindowAppearance, windowColors } = require('../electron/window-appearance.cjs')

function fakeWindow() {
  return {
    focused: true,
    destroyed: false,
    overlays: [],
    backgrounds: [],
    isFocused() {
      return this.focused
    },
    isDestroyed() {
      return this.destroyed
    },
    setBackgroundColor(color) {
      this.backgrounds.push(color)
    },
    setTitleBarOverlay(colors) {
      this.overlays.push(colors)
    },
  }
}

test('Windows caption icons retain each selected palette across focus, blur and inactive theme changes', () => {
  const window = fakeWindow(),
    appearance = new WindowAppearance(window, 'win32')
  for (const [palette, { tokens }] of Object.entries(presets)) {
    for (const focused of [true, false, true, false]) {
      window.focused = focused
      appearance.apply(palette)
      assert.deepEqual(window.overlays.at(-1), {
        color: tokens[focused ? '--surface-tabs' : '--window-inactive-bg'],
        symbolColor: tokens[focused ? '--bright' : '--window-inactive-symbol'],
      })
      assert.equal(window.backgrounds.at(-1), tokens['--window-bg'] || tokens['--bg'])
    }
    const count = window.overlays.length
    appearance.apply()
    assert.equal(
      window.overlays.length,
      count,
      'resize without a palette/focus change does not overwrite caption colors',
    )
  }
  window.destroyed = true
  const count = window.overlays.length
  appearance.apply('light')
  assert.equal(window.overlays.length, count)
})

test('macOS and Linux share the window background but never receive Windows caption overrides', () => {
  for (const platform of ['darwin', 'linux']) {
    const window = fakeWindow(),
      appearance = new WindowAppearance(window, platform)
    for (const palette of Object.keys(presets)) {
      appearance.apply(palette)
      window.focused = !window.focused
      appearance.apply()
      assert.equal(window.backgrounds.at(-1), windowColors(palette).background)
    }
    assert.deepEqual(window.overlays, [])
  }
  assert.deepEqual(windowColors('__proto__'), windowColors('dark'))
})
