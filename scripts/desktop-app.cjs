'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')

// Renderer dependencies are compiled into dist. Main/preload/core code uses
// Electron and Node builtins, so the shipped app has no external npm runtime tree.
async function stageDesktopApp(root) {
  await fs.access(path.join(root, 'dist', 'index.html'))
  await fs.access(path.join(root, 'electron', 'main.cjs'))
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
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
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(runtime, null, 2) + '\n',
    )
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
    return directory
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
    throw error
  }
}
module.exports = { stageDesktopApp }
