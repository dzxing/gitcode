import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const catalog = workspace.workspaces.catalog
const definitions = [
  ['apps/desktop', ['@gitcode/brand']],
  ['packages/brand', []],
]
const failures = []
for (const [directory, allowed] of definitions) {
  const base = path.join(root, directory)
  const manifest = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const require = createRequire(path.join(base, 'package.json'))
  for (const name of ['vue', '@vue/server-renderer']) {
    if (!dependencies[name]) continue
    let installed
    try {
      installed = require.resolve(`${name}/package.json`)
    } catch {
      // A filtered install may omit this application's dependencies.
      continue
    }
    const actual = JSON.parse(await readFile(installed, 'utf8')).version
    if (actual !== catalog[name])
      failures.push(
        `${directory}: 本地 ${name} ${actual} 与锁定的 ${catalog[name]} 不符，请移除该模块旧 node_modules 后在根目录重新安装。`,
      )
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (catalog[name] && version !== 'catalog:')
      failures.push(`${directory}: ${name} 必须引用统一的 catalog: 版本`)
    if (
      (name.startsWith('@gitcode/') || version.startsWith('workspace:')) &&
      !allowed.includes(name)
    )
      failures.push(`${directory}: 不允许依赖 ${name}`)
  }
  async function inspect(folder) {
    const ignored = new Set([
      'node_modules',
      '.nuxt',
      '.output',
      '.gitcode-local',
      '.gitk-local',
      '.tmp',
      '.data',
      'design',
      'dist',
      'test-results',
      'playwright-report',
    ])
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await inspect(file)
      else if (/\.(?:[cm]?[jt]s|vue)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8')
        for (const match of source.matchAll(
          /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
        )) {
          const specifier = match[1]
          if (specifier.startsWith('.')) {
            const resolved = path.resolve(path.dirname(file), specifier)
            const portal = path.join(root, 'apps/website')
            if (resolved === portal || resolved.startsWith(portal + path.sep))
              failures.push(`${path.relative(root, file)}: 公开模块不得依赖私有门户源码`)
            for (const [other] of definitions)
              if (other !== directory && resolved.startsWith(path.join(root, other) + path.sep))
                failures.push(`${path.relative(root, file)}: 请通过 workspace 包导入 ${specifier}`)
          }
          if (specifier.startsWith('@gitcode/')) {
            const name = specifier.split('/').slice(0, 2).join('/')
            if (!allowed.includes(name) || !dependencies[name])
              failures.push(`${path.relative(root, file)}: 未声明或不允许导入 ${name}`)
          }
        }
      }
    }
  }
  await inspect(base)
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else console.log('Workspace boundaries passed: desktop → brand.')
