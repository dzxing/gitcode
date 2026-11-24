import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] || fileURLToPath(new URL('../', import.meta.url))
const privateDirectories = new Set([
  'design',
  '.tmp',
  '.aws',
  '.ssh',
  '.codex',
  '.agents',
  '.gitcode-local',
  '.gitk-local',
  'release',
])

try {
  const objects = execFileSync('git', ['rev-list', '--objects', 'HEAD'], {
    cwd: path.resolve(root),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const blocked = new Set()
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator < 0) continue
    const file = line.slice(separator + 1)
    if (privateDirectories.has(file.split('/')[0])) blocked.add(file)
  }
  if (blocked.size) {
    console.error(`Public history contains ${blocked.size} private/generated paths.`)
    for (const file of [...blocked].slice(0, 8)) console.error(`  ${file}`)
    console.error('Publish from the cleaned GitHub main branch; do not merge the private history.')
    process.exitCode = 1
  } else console.log('Public history check passed.')
} catch (error) {
  console.error(`Public history could not be checked: ${error.message}`)
  process.exitCode = 1
}
