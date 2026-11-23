'use strict'

const fs = require('node:fs')
const path = require('node:path')

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
function rectangle(value) {
  return (
    value &&
    ['x', 'y', 'width', 'height'].every((key) => finite(value[key])) &&
    Math.abs(value.x) < 100000 &&
    Math.abs(value.y) < 100000 &&
    value.width > 0 &&
    value.height > 0 &&
    value.width < 32768 &&
    value.height < 32768
  )
}
function intersection(a, b) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  )
}

// Electron screen/workArea and BrowserWindow bounds are already in DIP.
// Multiplying by scaleFactor here would apply Windows scaling twice.
function fitBounds(saved, displays, preferred) {
  saved = rectangle(saved) ? saved : null
  const valid = displays.filter((display) => rectangle(display.workArea))
  if (!valid.length) throw new Error('没有可用的屏幕工作区。')
  let display = valid.find((item) => item.id === preferred?.id) || valid[0]
  if (rectangle(saved)) {
    const ranked = valid.map((item) => [item, intersection(saved, item.workArea)])
    ranked.sort((a, b) => b[1] - a[1])
    if (ranked[0][1] > 0) display = ranked[0][0]
  }
  const area = display.workArea
  // Leave room for non-client rounding even on work areas below the usual minimum.
  const minWidth = Math.min(720, Math.max(1, Math.floor(area.width) - 16))
  const minHeight = Math.min(480, Math.max(1, Math.floor(area.height) - 16))
  const width = Math.min(
    Math.floor(area.width),
    Math.max(minWidth, Math.round(saved?.width || 1440)),
  )
  const height = Math.min(
    Math.floor(area.height),
    Math.max(minHeight, Math.round(saved?.height || 960)),
  )
  const left = Math.round(area.x),
    top = Math.round(area.y)
  const x = rectangle(saved) ? saved.x : left + (area.width - width) / 2
  const y = rectangle(saved) ? saved.y : top + (area.height - height) / 2
  return {
    x: Math.max(left, Math.min(Math.round(x), left + Math.floor(area.width) - width)),
    y: Math.max(top, Math.min(Math.round(y), top + Math.floor(area.height) - height)),
    width,
    height,
    minWidth,
    minHeight,
  }
}

class WindowState {
  constructor(file, screen, warn = (error) => console.warn(`无法保存窗口布局：${error.message}`)) {
    Object.assign(this, { file, screen, warn })
    this.saved = null
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (value.version === 1 && rectangle(value.bounds))
        this.saved = { bounds: value.bounds, maximized: value.maximized === true }
    } catch {
      // Corrupt/missing layout preferences must never prevent startup.
    }
  }
  options() {
    return fitBounds(
      this.saved?.bounds,
      this.screen.getAllDisplays(),
      this.screen.getPrimaryDisplay(),
    )
  }
  track(window) {
    let timer,
      displayTimer,
      minimum = window.getMinimumSize?.(),
      disposed = false
    const remember = () => {
      if (disposed || window.isDestroyed() || window.isMinimized()) return
      const bounds = window.getNormalBounds()
      if (rectangle(bounds)) this.saved = { bounds, maximized: window.isMaximized() }
    }
    const flush = () => {
      clearTimeout(timer)
      remember()
      if (!this.saved) return
      const temporary = `${this.file}.${process.pid}.tmp`
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...this.saved }) + '\n')
        fs.renameSync(temporary, this.file)
      } catch (error) {
        this.warn(error)
      } finally {
        try {
          fs.rmSync(temporary, { force: true })
        } catch {
          /* Optional preference cleanup. */
        }
      }
    }
    const schedule = () => {
      remember()
      clearTimeout(timer)
      timer = setTimeout(flush, 180)
    }
    const adjust = (clamp, intended) => {
      if (disposed || window.isDestroyed()) return
      const current = window.getNormalBounds()
      const fitted = fitBounds(
        intended || current,
        this.screen.getAllDisplays(),
        this.screen.getPrimaryDisplay(),
      )
      if (minimum?.[0] !== fitted.minWidth || minimum?.[1] !== fitted.minHeight) {
        // Native setters can emit move/resize again, so update the cache first.
        minimum = [fitted.minWidth, fitted.minHeight]
        window.setMinimumSize(...minimum)
      }
      if (clamp && !window.isMaximized() && !window.isFullScreen() && !window.isMinimized()) {
        const bounds = Object.fromEntries(
          ['x', 'y', 'width', 'height'].map((key) => [key, fitted[key]]),
        )
        if (Object.keys(bounds).some((key) => bounds[key] !== current[key])) {
          const requested = { ...bounds }
          // Native non-client rounding at fractional DPI can add a few DIP.
          // Correct against measured bounds, with a strict bound on attempts.
          for (let attempt = 0; attempt < 3; attempt++) {
            window.setBounds(requested)
            const actual = window.getBounds?.() || window.getNormalBounds()
            if (Object.keys(bounds).every((key) => bounds[key] === actual[key])) break
            for (const key of Object.keys(bounds)) requested[key] += bounds[key] - actual[key]
            requested.width = Math.max(1, requested.width)
            requested.height = Math.max(1, requested.height)
          }
        }
      }
      schedule()
    }
    const moved = () => adjust(false)
    const changedDisplays = () => {
      clearTimeout(displayTimer)
      displayTimer = setTimeout(() => adjust(true), 180)
    }
    const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed']
    for (const event of displayEvents) this.screen.on(event, changedDisplays)
    window.on('move', moved)
    const restored = () => adjust(true)
    for (const event of ['resize', 'maximize']) window.on(event, schedule)
    for (const event of ['unmaximize', 'restore', 'leave-full-screen']) window.on(event, restored)
    window.on('close', flush)
    window.once('closed', () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(displayTimer)
      for (const event of displayEvents) this.screen.removeListener(event, changedDisplays)
    })
    return { flush, restore: (bounds) => adjust(true, bounds) }
  }
}

module.exports = { fitBounds, WindowState }
