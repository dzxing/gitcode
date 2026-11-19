const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)

test(
  'Windows installer detects exact executable paths, preserves cancellation and closes only the target',
  {
    skip: process.platform !== 'win32',
    timeout: 60000,
  },
  async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-installer-processes-'))
    t.after(() => fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const result = await execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'fixtures/installer-processes.ps1'),
        '-HelperSource',
        path.join(__dirname, '../scripts/installer-processes.ps1'),
        '-WorkDirectory',
        work,
      ],
      { windowsHide: true, timeout: 55000 },
    )
    assert.match(result.stdout, /INSTALLER_PROCESS_TESTS_PASSED/)
  },
)

test(
  'Windows installer launcher allocates no console, preserves quoted paths and forwards cancellation',
  {
    skip: process.platform !== 'win32',
    timeout: 60000,
  },
  async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-installer-launcher-'))
    t.after(() => fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const result = await execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'fixtures/installer-launcher.ps1'),
        '-ProjectSource',
        path.join(__dirname, '..'),
        '-WorkDirectory',
        work,
      ],
      { windowsHide: true, timeout: 55000 },
    )
    assert.match(result.stdout, /CONSOLE_FREE_LAUNCHER_TESTS_PASSED/)
  },
)

// Requires an interactive Windows desktop. Keep this opt-in for headless CI.
test(
  'Windows native installer dialog preserves defaults, keyboard cancellation and process isolation',
  {
    skip: process.platform !== 'win32' || process.env.GITCODE_INSTALLER_UI_TESTS !== '1',
    timeout: 150000,
  },
  async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-installer-dialog-'))
    t.after(() => fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const result = await execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'fixtures/installer-dialog.ps1'),
        '-ProjectSource',
        path.join(__dirname, '..'),
        '-WorkDirectory',
        work,
      ],
      { windowsHide: true, timeout: 140000 },
    )
    assert.match(result.stdout, /INSTALLER_TASK_DIALOG_TESTS_PASSED/)
  },
)
