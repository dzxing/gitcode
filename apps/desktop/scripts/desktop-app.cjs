'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')

// Renderer dependencies are compiled into dist. The only native runtime dependency
// is explicitly vendored; development dependencies never enter the shipped app.
async function stageDesktopApp(
  root,
  {
    arch = process.arch,
    platform = process.platform,
    licenseRoot = path.resolve(root, '../..'),
  } = {},
) {
  await fs.access(path.join(root, 'dist', 'index.html'))
  await fs.access(path.join(root, 'electron', 'main.cjs'))
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const licenseFiles = ['LICENSE', 'THIRD_PARTY_NOTICES.md']
  for (const file of licenseFiles) await fs.access(path.join(licenseRoot, file))
  const parent = path.join(root, '.gitcode-local', 'desktop-apps')
  await fs.mkdir(parent, { recursive: true })
  const directory = await fs.mkdtemp(path.join(parent, 'app-'))
  try {
    const runtime = Object.fromEntries(
      [
        'name',
        'version',
        'description',
        'productName',
        'main',
        'type',
        'author',
        'license',
        'homepage',
        'repository',
      ]
        .filter((key) => metadata[key] !== undefined)
        .map((key) => [key, metadata[key]]),
    )
    runtime.private = true
    runtime.license = 'SEE LICENSE IN LICENSE'
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(runtime, null, 2) + '\n',
    )
    for (const file of licenseFiles)
      await fs.copyFile(path.join(licenseRoot, file), path.join(directory, file))
    await fs.cp(path.join(root, 'dist'), path.join(directory, 'dist'), { recursive: true })
    await fs.cp(path.join(root, 'assets'), path.join(directory, 'assets'), { recursive: true })
    if (
      await fs.access(path.join(root, 'third-party')).then(
        () => true,
        () => false,
      )
    )
      await fs.cp(path.join(root, 'third-party'), path.join(directory, 'third-party'), {
        recursive: true,
      })
    await fs.mkdir(path.join(directory, 'electron'))
    for (const file of await fs.readdir(path.join(root, 'electron'))) {
      if (file.endsWith('.cjs') || (file.endsWith('.json') && file !== 'package.json'))
        await fs.copyFile(path.join(root, 'electron', file), path.join(directory, 'electron', file))
    }
    if (metadata.dependencies?.['node-pty']) {
      const source = await require('./prepare-terminal.cjs').prepareTerminal(root, arch, platform)
      const target = path.join(directory, 'electron', 'vendor', 'node-pty')
      await fs.mkdir(target, { recursive: true })
      for (const entry of ['package.json', 'LICENSE', 'lib', 'prebuilds', 'build/Release']) {
        const from = path.join(source, entry)
        if (
          await fs.access(from).then(
            () => true,
            () => false,
          )
        )
          await fs.cp(from, path.join(target, entry), {
            recursive: true,
            filter: (file) => !/\.(?:pdb|map)$|\.test\.js$/.test(file),
          })
      }
      await fs.access(path.join(target, 'lib', 'index.js'))
      require('../electron/terminal-native.cjs').ensurePtyHelperExecutable(target, platform, arch)
    }
    return directory
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
    throw error
  }
}
module.exports = { stageDesktopApp }
