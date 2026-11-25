const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { ensurePtyHelperExecutable } = require('../electron/terminal-native.cjs')

const posix = { skip: process.platform === 'win32' }
async function fixture(t, locations) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-pty-helper-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const location of locations) {
    const directory = path.join(root, location)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'pty.node'), 'native fixture')
    await fs.writeFile(path.join(directory, 'spawn-helper'), 'helper bytes')
    await fs.chmod(path.join(directory, 'spawn-helper'), 0o644)
  }
  return root
}
test(
  'Darwin prebuilt helper becomes executable without changing bytes or another architecture',
  posix,
  async (t) => {
    const root = await fixture(t, ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64'])
    const helper = path.join(root, 'prebuilds/darwin-arm64/spawn-helper')
    ensurePtyHelperExecutable(root, 'darwin', 'arm64')
    assert.equal((await fs.stat(helper)).mode & 0o777, 0o755)
    assert.equal(await fs.readFile(helper, 'utf8'), 'helper bytes')
    assert.equal(
      (await fs.stat(path.join(root, 'prebuilds/darwin-x64/spawn-helper'))).mode & 0o777,
      0o644,
    )
    const before = (await fs.stat(helper)).ctimeMs
    ensurePtyHelperExecutable(root, 'darwin', 'arm64')
    assert.equal((await fs.stat(helper)).ctimeMs, before)
  },
)
test(
  'Darwin rebuilt and packaged copies repair helper modes and reject missing helpers',
  posix,
  async (t) => {
    const root = await fixture(t, ['build/Release'])
    const helper = path.join(root, 'build/Release/spawn-helper')
    ensurePtyHelperExecutable(root, 'darwin', 'x64')
    assert.equal((await fs.stat(helper)).mode & 0o111, 0o111)
    await fs.rm(helper)
    assert.throws(() => ensurePtyHelperExecutable(root, 'darwin', 'x64'), /ENOENT/)
  },
)
test('other platforms do not access or change Darwin helper files', async (t) => {
  const root = await fixture(t, ['prebuilds/darwin-arm64'])
  const helper = path.join(root, 'prebuilds/darwin-arm64/spawn-helper')
  const before = await fs.stat(helper)
  ensurePtyHelperExecutable(root, 'win32', 'x64')
  ensurePtyHelperExecutable(root, 'linux', 'arm64')
  assert.equal((await fs.stat(helper)).mode, before.mode)
  assert.equal((await fs.stat(helper)).ctimeMs, before.ctimeMs)
})
