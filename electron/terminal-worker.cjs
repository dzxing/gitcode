'use strict'
// The native addon and Shell processes never run inside the renderer/main thread.
const fs = require('node:fs')
const path = require('node:path')
const vendor = path.join(__dirname, 'vendor', 'node-pty')
const pty = process.env.GITCODE_TERMINAL_MODULE
  ? require(process.env.GITCODE_TERMINAL_MODULE)
  : fs.existsSync(vendor)
    ? require(vendor)
    : require('node-pty')
const sessions = new Map()
const send = (value) => {
  if (process.connected) process.send(value)
}
function close(id) {
  const terminal = sessions.get(id)
  if (!terminal) return
  sessions.delete(id)
  try {
    terminal.kill()
  } catch {}
}
process.on('message', (message) => {
  const { requestId, action, id } = message
  try {
    if (action === 'start') {
      const terminal = pty.spawn(message.executable, message.args, {
        name: 'xterm-256color',
        cols: message.cols,
        rows: message.rows,
        cwd: message.cwd,
        env: message.env,
      })
      sessions.set(id, terminal)
      terminal.onData((data) => send({ event: 'data', id, data }))
      terminal.onExit(({ exitCode }) => {
        sessions.delete(id)
        send({ event: 'exit', id, exitCode })
      })
    } else if (action === 'close') close(id)
    else {
      const terminal = sessions.get(id)
      if (!terminal) throw Error('终端进程已结束。')
      if (action === 'write') terminal.write(message.data)
      else if (action === 'resize') terminal.resize(message.cols, message.rows)
      else throw Error('不支持的终端操作。')
    }
    send({ requestId, ok: true })
  } catch (error) {
    send({ requestId, error: error.message })
  }
})
const shutdown = () => {
  for (const id of sessions.keys()) close(id)
  process.exit(0)
}
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
