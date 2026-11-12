const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { fitBounds, WindowState } = require('../electron/window-state.cjs')

const display = (id, x, y, width, height, scaleFactor = 1) => ({
  id,
  scaleFactor,
  workArea: { x, y, width, height },
})
const primary = display(1, 0, 0, 1920, 1032)
function inside(result, area) {
  assert.ok(result.x >= area.x && result.y >= area.y)
  assert.ok(result.x + result.width <= area.x + area.width)
  assert.ok(result.y + result.height <= area.y + area.height)
}
test('DIP work areas constrain startup and minimum sizes without applying DPI twice', () => {
  for (const screen of [
    primary,
    display(1, 0, 0, 1093, 566, 1.25),
    display(1, 0, 0, 960, 492, 2),
    display(1, 0, 0, 600, 400, 2),
  ]) {
    const result = fitBounds(null, [screen], screen)
    inside(result, screen.workArea)
    assert.equal(result.minWidth, Math.min(720, screen.workArea.width - 16))
    assert.equal(result.minHeight, Math.min(480, screen.workArea.height - 16))
    assert.equal(result.width, Math.min(1440, screen.workArea.width))
  }
})
test('restore keeps negative-coordinate monitors, but recovers removed or resized displays', () => {
  const second = display(2, -1600, -200, 1600, 860, 1.5)
  const saved = { x: -1500, y: -150, width: 1000, height: 700 }
  const kept = fitBounds(saved, [primary, second], primary)
  assert.equal(kept.x, saved.x)
  assert.equal(kept.y, saved.y)
  inside(fitBounds(saved, [primary], primary), primary.workArea)
  inside(
    fitBounds({ x: 1900, y: 1000, width: 5000, height: 3000 }, [primary], primary),
    primary.workArea,
  )
  const broken = fitBounds({ x: NaN, y: 0, width: Infinity, height: -1 }, [primary], primary)
  assert.equal(broken.width, 1440)
})
test('window state persists normal bounds and maximized intent without saving minimized bounds', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-window-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'window-state.json')
  fs.writeFileSync(file, '{invalid')
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [primary],
    getPrimaryDisplay: () => primary,
  })
  const state = new WindowState(file, screen)
  assert.equal(state.saved, null)
  let minimized = false,
    maximized = false
  const normal = { x: 100, y: 80, width: 1000, height: 700 }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isMaximized: () => maximized,
    isFullScreen: () => false,
    getNormalBounds: () => normal,
    setMinimumSize: () => {},
    setBounds: () => {},
  })
  const tracking = state.track(window)
  maximized = true
  tracking.flush()
  minimized = true
  maximized = false
  tracking.flush()
  const restored = new WindowState(file, screen)
  assert.deepEqual(restored.saved, { bounds: normal, maximized: true })
  assert.equal(restored.options().width, 1000)
  window.emit('closed')
  assert.equal(screen.listenerCount('display-removed'), 0)
})
test('display removal moves an existing window into the remaining work area', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-window-displays-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [primary],
    getPrimaryDisplay: () => primary,
  })
  let bounds = { x: 2400, y: 100, width: 1400, height: 900 }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => bounds,
    setMinimumSize: () => {},
    setBounds: (value) => {
      bounds = value
    },
  })
  new WindowState(path.join(directory, 'state.json'), screen).track(window)
  screen.emit('display-removed')
  await new Promise((resolve) => setTimeout(resolve, 240))
  inside(bounds, primary.workArea)
  window.emit('close')
  window.emit('closed')
})

test('native setters can re-emit move without recursive minimum-size updates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-window-native-events-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [primary],
    getPrimaryDisplay: () => primary,
  })
  let updates = 0
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => ({ x: 100, y: 100, width: 1000, height: 700 }),
    setMinimumSize: () => {
      updates++
      assert.ok(updates < 3)
      window.emit('move')
    },
    setBounds: () => {},
  })
  new WindowState(path.join(directory, 'state.json'), screen).track(window)
  window.emit('move')
  window.emit('move')
  assert.equal(updates, 1)
  window.emit('closed')
})

test('restore corrects native non-client rounding without accumulating size across launches', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-window-rounding-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [primary],
    getPrimaryDisplay: () => primary,
  })
  let bounds = { x: 100, y: 100, width: 1006, height: 703 },
    updates = 0
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => bounds,
    getBounds: () => bounds,
    setMinimumSize: () => {},
    setBounds: (requested) => {
      updates++
      bounds = { ...requested, width: requested.width + 2, height: requested.height + 1 }
    },
  })
  const tracking = new WindowState(path.join(directory, 'state.json'), screen).track(window)
  const intended = { x: 100, y: 100, width: 1000, height: 700 }
  tracking.restore(intended)
  assert.deepEqual(bounds, intended)
  assert.equal(updates, 2)
  tracking.restore(intended)
  assert.equal(updates, 2)
  window.emit('closed')
})
