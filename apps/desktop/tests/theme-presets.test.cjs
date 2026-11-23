const test = require('node:test')
const assert = require('node:assert/strict')
const presets = require('../electron/theme-presets.json')
const { sanitizeState } = require('../electron/menus.cjs')
function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}
test('software-inspired themes keep text, state labels and button hover readable', () => {
  for (const [id, preset] of Object.entries(presets)) {
    for (const value of Object.values(preset.tokens)) assert.match(value, /^#[a-f\d]{6}$/i)
    if (id === 'dark' || id === 'light') continue
    const colors = preset.tokens
    const pairs = [
      ['--text', '--bg'],
      ['--text', '--panel'],
      ['--muted', '--panel'],
      ['--accent', '--panel'],
      ['--accent-ink', '--button-primary-bg'],
      ['--accent-ink', '--button-primary-hover'],
      ['--view-selection-color', '--view-selection-bg'],
      ['--current-branch-color', '--current-branch-bg'],
      ['--git-added', '--panel'],
      ['--git-modified', '--panel'],
      ['--git-deleted', '--panel'],
    ]
    for (const [foreground, background] of pairs)
      assert.ok(
        contrast(colors[foreground], colors[background]) >= 4.5,
        `${id}: ${foreground} on ${background}`,
      )
  }
})
test('native palette uses a fixed allowlist and derives the correct light/dark source', () => {
  for (const [palette, preset] of Object.entries(presets)) {
    const state = sanitizeState({ enabled: [], recent: [], palette })
    assert.equal(state.palette, palette)
    assert.equal(state.resolvedTheme, preset.mode)
    assert.equal(state.theme, preset.mode)
  }
  assert.equal(sanitizeState({ enabled: [], recent: [], palette: '__proto__' }).palette, 'dark')
  assert.equal(
    sanitizeState({ enabled: [], recent: [], palette: 'unknown', resolvedTheme: 'light' }).palette,
    'light',
  )
  assert.equal(
    sanitizeState({ enabled: [], recent: [], theme: 'system', resolvedTheme: 'light' }).theme,
    'system',
  )
})

test('Islands main-window frame is distinct from its content panels', () => {
  for (const id of ['islands-dark', 'islands-light', 'islands-darcula']) {
    const preset = presets[id]
    const colors = preset.tokens
    assert.ok(contrast(colors['--window-bg'], colors['--panel']) >= 1.2, id)
    assert.equal(colors['--surface-tabs'], colors['--window-bg'])
    assert.equal(
      luminance(colors['--window-bg']) > luminance(colors['--panel']),
      preset.mode === 'dark',
    )
  }
})
