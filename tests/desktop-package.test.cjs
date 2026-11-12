const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { stageDesktopApp } = require('../scripts/desktop-app.cjs')

test('desktop staging includes built renderer/fonts and every runtime core file without development dependencies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-package-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const directory of [
    'dist/fonts',
    'electron/node_modules/dev-only',
    'assets',
    'third-party/jetbrains-graph',
  ])
    await fs.mkdir(path.join(root, directory), { recursive: true })
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'gitcode-qa',
      version: '1.0.1',
      main: 'electron/main.cjs',
      type: 'module',
      dependencies: { vue: 'test', pinia: 'test' },
      devDependencies: { electron: 'test' },
      scripts: { build: 'test' },
    }),
  )
  for (const [file, content] of [
    ['dist/index.html', '<html/>'],
    ['dist/fonts/test.woff2', 'font'],
    ['assets/icon.ico', 'icon'],
    ['third-party/jetbrains-graph/NOTICE.txt', 'Attribution'],
    ['electron/main.cjs', "require('./operation-log.cjs')"],
    ['electron/operation-log.cjs', 'module.exports = {}'],
    ['electron/menu-schema.json', '[]'],
    ['electron/theme-presets.json', '{"dark":{"mode":"dark"}}'],
    ['electron/package.json', '{"devDependencies":{}}'],
    ['electron/node_modules/dev-only/private.txt', 'do not package'],
  ])
    await fs.writeFile(path.join(root, file), content)
  for (const file of [
    'platform.cjs',
    'platform-windows.cjs',
    'platform-macos.cjs',
    'platform-linux.cjs',
  ])
    await fs.copyFile(
      path.join(__dirname, '..', 'electron', file),
      path.join(root, 'electron', file),
    )
  const app = await stageDesktopApp(root)
  const packagedPlatform = require(path.join(app, 'electron/platform.cjs'))
  assert.equal(packagedPlatform.getPlatform('win32').id, 'windows')
  assert.equal(packagedPlatform.getPlatform('darwin').id, 'macos')
  assert.equal(packagedPlatform.getPlatform('linux').id, 'linux')
  const metadata = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'))
  assert.equal(metadata.main, 'electron/main.cjs')
  assert.equal(metadata.version, '1.0.1')
  assert.equal(metadata.dependencies, undefined)
  assert.equal(metadata.devDependencies, undefined)
  assert.equal(metadata.scripts, undefined)
  for (const file of [
    'dist/index.html',
    'dist/fonts/test.woff2',
    'assets/icon.ico',
    'third-party/jetbrains-graph/NOTICE.txt',
    'electron/main.cjs',
    'electron/operation-log.cjs',
    'electron/menu-schema.json',
    'electron/theme-presets.json',
  ])
    await fs.access(path.join(app, file))
  await assert.rejects(fs.access(path.join(app, 'electron/node_modules')))
  await assert.rejects(fs.access(path.join(app, 'electron/package.json')))
})

test('desktop staging refuses a missing frontend build before creating an app directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-package-empty-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await assert.rejects(stageDesktopApp(root), /ENOENT/)
  await assert.rejects(fs.access(path.join(root, '.gitcode-local')))
})
