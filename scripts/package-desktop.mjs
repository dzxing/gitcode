import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const tools = createRequire(new URL('../electron/package.json', import.meta.url))
let cli
try {
  cli = tools.resolve('electron-builder/cli.js')
} catch {
  console.error('请先安装桌面工具：bun install --cwd electron')
  process.exit(1)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const child = spawn(
  process.execPath,
  [cli, '--projectDir', root, '--config', 'electron-builder.json', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
)
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code || 0
})
