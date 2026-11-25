import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// Legacy portal publication is retained; new portal commits are prohibited.
const portalHistoryBaseline = '2595c491b63b7800de7f6f49a5271f7db2912f76'
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

export function checkPublicHistory(directory, legacyPortalCommit = portalHistoryBaseline) {
  const cwd = path.resolve(directory)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const blocked = new Set()
  for (const line of git('rev-list', '--objects', 'HEAD').split('\n')) {
    const separator = line.indexOf(' ')
    if (separator < 0) continue
    const file = line.slice(separator + 1)
    if (privateDirectories.has(file.split('/')[0])) blocked.add(file)
  }
  for (const file of git('ls-files', '-z', '--', 'apps/website').split('\0'))
    if (file) blocked.add(file)
  let exclude = []
  try {
    git('cat-file', '-e', `${legacyPortalCommit}^{commit}`)
    exclude = ['--not', legacyPortalCommit]
  } catch {
    // Independent repositories receive no legacy portal exception.
  }
  const changed = git(
    'log',
    '-m',
    '--format=',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACMRT',
    'HEAD',
    ...exclude,
    '--',
    'apps/website',
  )
  for (const file of changed.split('\n')) if (file) blocked.add(file)
  if (blocked.size)
    throw new Error(
      `Public scope contains ${blocked.size} private/generated paths:\n${[...blocked].slice(0, 8).join('\n')}\nKeep apps/website private; publish from the cleaned GitHub branch.`,
    )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkPublicHistory(process.argv[2] || root)
    console.log('Public history and module scope checks passed.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
