import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tools = createRequire(new URL('../electron/package.json', import.meta.url))
let executable
try {
  executable = tools('electron')
} catch {
  console.error('尚未安装 Electron 桌面运行环境。请先执行：bun install --cwd electron')
  process.exit(1)
}
const url = 'http://localhost:43187'
let vite = null,
  electron = null,
  stopped = false
function stop(code = 0) {
  if (stopped) return
  stopped = true
  electron?.kill('SIGTERM')
  vite?.kill('SIGTERM')
  process.exitCode = code
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

try {
  let existing = false
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
    const html = await response.text()
    if (!response.ok || !html.includes('GitCode')) throw new Error('端口 43187 被其他服务占用。')
    existing = true
  } catch (error) {
    if (error.message.includes('被其他服务占用')) throw error
  }
  if (!existing) {
    const require = createRequire(import.meta.url)
    const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
    require.resolve('vite')
    vite = spawn(
      process.execPath,
      [viteCli, '--host', '127.0.0.1', '--port', '43187', '--strictPort'],
      { cwd: root, stdio: 'inherit' },
    )
    let failure = null
    vite.once('error', (error) => {
      failure = error
    })
    vite.once('exit', (code) => {
      if (!stopped) {
        failure = new Error(`Vite 退出：${code}`)
        if (electron) stop(1)
      }
    })
    let ready = false
    for (let i = 0; i < 100 && !stopped; i++) {
      if (failure) throw failure
      try {
        const result = await fetch(url, { signal: AbortSignal.timeout(500) })
        if (result.ok) {
          ready = true
          break
        }
      } catch {
        /* Wait for Vite. */
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (!ready) throw new Error('前端开发服务器启动超时。')
  } else console.log('复用已运行的 GitCode 前端开发服务器。')
  if (!stopped) {
    electron = spawn(executable, [root], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        GITCODE_DEV_URL: url,
        ...(process.argv.includes('--wsl') ? { GITCODE_SOFTWARE_RENDERING: '1' } : {}),
      },
    })
    electron.once('error', (error) => {
      console.error(error.message)
      stop(1)
    })
    electron.once('exit', (code) => stop(code || 0))
  }
} catch (error) {
  console.error(error.message)
  stop(1)
}
