'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { fork } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { parseWslPath } = require('./wsl-path.cjs')
const { developmentPty } = require('./terminal-native.cjs')
const BUFFER = 512 * 1024
const READ = 64 * 1024
function dimensions(value) {
  if (
    !Number.isInteger(value.cols) ||
    value.cols < 2 ||
    value.cols > 500 ||
    !Number.isInteger(value.rows) ||
    value.rows < 1 ||
    value.rows > 300
  )
    throw Error('无效的终端尺寸。')
  return { cols: value.cols, rows: value.rows }
}
class TerminalService {
  constructor(git, options = {}) {
    this.git = git
    this.platform = options.platform || process.platform
    this.fork = options.fork || fork
    this.sessions = new Map()
    this.pending = new Map()
    this.next = 0
    this.creating = 0
    this.closing = false
    this.worker = null
  }
  shells(repo) {
    if (this.platform === 'win32' && parseWslPath(repo))
      return [{ id: 'default', label: 'WSL 默认 Shell' }]
    const result = []
    const add = (id, label, executable, args = []) => {
      if (executable && path.isAbsolute(executable) && fs.existsSync(executable))
        result.push({ id, label, executable, args })
    }
    if (this.platform === 'win32') {
      const system = process.env.SystemRoot || 'C:\\Windows'
      add(
        'powershell',
        'PowerShell',
        path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoExit'],
      )
      add('cmd', '命令提示符', path.join(system, 'System32/cmd.exe'), [])
      const git = this.git.gitPath
      if (git)
        add('git-bash', 'Git Bash', path.resolve(path.dirname(git), '../bin/bash.exe'), [
          '--login',
          '-i',
        ])
    } else {
      let login = ''
      try {
        login = os.userInfo().shell
      } catch {
        // Environment variables and the platform default remain valid fallbacks.
      }
      add(
        'default',
        path.basename(
          login || process.env.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
        ),
        login || process.env.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
        ['-l'],
      )
      add('bash', 'Bash', '/bin/bash', ['-l'])
      add('zsh', 'Zsh', '/bin/zsh', ['-l'])
      add('sh', 'Sh', '/bin/sh', [])
    }
    return result
  }
  startWorker() {
    if (this.worker) return this.worker
    // Electron's Node mode cannot execute an entry point inside the ASAR.
    const core = __dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.GITCODE_TERMINAL_MODULE
    if (process.versions.electron) {
      const vendor = path.join(core, 'vendor', 'node-pty')
      env.GITCODE_TERMINAL_MODULE = fs.existsSync(vendor)
        ? vendor
        : developmentPty(path.resolve(__dirname, '..'), process.versions.electron)
    }
    const child = this.fork(path.join(core, 'terminal-worker.cjs'), [], {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    })
    this.worker = child
    let diagnostic = ''
    child.stderr?.on('data', (data) => {
      diagnostic = (diagnostic + data).slice(-2000)
    })
    child.on('message', (message) => {
      const session = this.sessions.get(message.id)
      if (message.event === 'data' && session && typeof message.data === 'string') {
        session.output = (session.output + message.data).slice(-BUFFER)
        session.cursor += message.data.length
      } else if (message.event === 'exit' && session) {
        session.state = 'exited'
        session.exitCode = message.exitCode
      } else if (this.pending.has(message.requestId)) {
        const pending = this.pending.get(message.requestId)
        this.pending.delete(message.requestId)
        clearTimeout(pending.timer)
        message.error ? pending.reject(Error(message.error)) : pending.resolve()
      }
    })
    const fail = () => {
      if (this.worker !== child) return
      this.worker = null
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(
          Error(
            '终端服务已断开，请关闭此会话后重试。' + (diagnostic ? ' 请检查本地终端依赖。' : ''),
          ),
        )
      }
      this.pending.clear()
      for (const session of this.sessions.values()) {
        if (session.state === 'running') {
          session.state = 'exited'
          session.exitCode = -1
        }
      }
    }
    child.once('error', fail)
    child.once('exit', fail)
    return child
  }
  send(action, value) {
    const child = this.startWorker()
    return new Promise((resolve, reject) => {
      const requestId = ++this.next
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(Error('终端服务响应超时，请关闭此会话后重试。'))
      }, 10000)
      this.pending.set(requestId, { resolve, reject, timer })
      child.send({ action, requestId, ...value }, (error) => {
        if (!error || !this.pending.has(requestId)) return
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(Error('终端服务已断开。'))
      })
    })
  }
  async request(repo, value) {
    if (this.closing || this.git.closing) throw Error('应用正在退出。')
    if (
      typeof repo !== 'string' ||
      !repo ||
      repo.length > 32768 ||
      repo.includes('\0') ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw Error('无效的终端请求。')
    if (value.action === 'shells')
      return { shells: this.shells(repo).map(({ id, label }) => ({ id, label })) }
    if (value.action === 'create') {
      if (!Number.isSafeInteger(value.tabId) || value.tabId < 1) throw Error('无效的仓库标签。')
      const size = dimensions(value)
      if (this.sessions.size + this.creating >= 16)
        throw Error('最多同时打开 16 个终端，请先关闭不再使用的会话。')
      this.creating++
      let id
      try {
        const wsl = this.platform === 'win32' && parseWslPath(repo)
        let cwd
        if (wsl) {
          const trust = await this.git.wsl.invoke(wsl.distribution, 'repository-trust', [
            wsl.linuxPath,
          ])
          if (!trust.trusted) throw Error('请先信任并打开此 WSL 仓库。')
          cwd = os.homedir()
        } else cwd = await this.git.job((signal) => this.git.repository(repo, signal))
        if (this.closing || this.git.closing) throw Error('应用正在退出。')
        const shells = this.shells(repo)
        const shell = value.shell ? shells.find((s) => s.id === value.shell) : shells[0]
        if (!shell) throw Error('所选 Shell 不可用，请重新选择。')
        const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        delete env.ELECTRON_RUN_AS_NODE
        // A terminal uses the same installed Git as the selected repository core.
        if (!wsl && this.git.gitPath) {
          const key = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
          env[key] = path.dirname(this.git.gitPath) + path.delimiter + (env[key] || '')
        }
        id = randomUUID()
        const session = {
          id,
          repo,
          tabId: value.tabId,
          shell: shell.label,
          state: 'running',
          exitCode: null,
          output: '',
          cursor: 0,
        }
        this.sessions.set(id, session)
        await this.send('start', {
          id,
          cwd,
          env,
          ...size,
          executable: wsl ? this.git.wsl.wslExe : shell.executable,
          args: wsl ? ['--distribution', wsl.distribution, '--cd', wsl.linuxPath] : shell.args,
        })
        return { id, shell: session.shell }
      } catch (error) {
        if (id) {
          if (this.worker) void this.send('close', { id }).catch(() => {})
          this.sessions.delete(id)
        }
        throw error
      } finally {
        this.creating--
      }
    }
    const session = this.sessions.get(value.id)
    // A browser reconnect or renderer reload may already have disposed it.
    if (!session && value.action === 'close') return
    if (!session || session.repo !== repo) throw Error('终端会话已关闭或不属于此仓库。')
    if (value.action === 'read') {
      if (!Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > session.cursor)
        throw Error('无效的终端读取位置。')
      const start = session.cursor - session.output.length
      const from = Math.max(start, value.cursor)
      const data = session.output.slice(from - start, from - start + READ)
      return {
        data,
        cursor: from + data.length,
        dropped: value.cursor < start,
        more: from + data.length < session.cursor,
        state: session.state,
        exitCode: session.exitCode,
      }
    }
    if (value.action === 'close') {
      // Never restart a crashed host just to close one of its stale sessions.
      if (this.worker && session.state === 'running') await this.send('close', { id: session.id })
      this.sessions.delete(session.id)
      return
    }
    if (session.state !== 'running') throw Error('终端进程已结束。')
    if (value.action === 'write') {
      if (typeof value.data !== 'string' || value.data.length > 64 * 1024)
        throw Error('终端输入过大。')
      return this.send('write', { id: session.id, data: value.data })
    }
    if (value.action === 'resize')
      return this.send('resize', { id: session.id, ...dimensions(value) })
    throw Error('不支持的终端操作。')
  }
  async shutdown() {
    this.closing = true
    const child = this.worker
    if (!child) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (child.connected) child.disconnect()
      else {
        clearTimeout(timer)
        resolve()
      }
    })
    this.sessions.clear()
  }
}
module.exports = { TerminalService, dimensions }
