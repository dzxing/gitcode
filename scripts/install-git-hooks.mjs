import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const marker = '# GitCode managed credential check'
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function install(repoRoot = root, { ci = Boolean(process.env.CI) } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (ci) {
    console.log('CI uses the independent required secret-scan job; local hooks were not installed.')
    return
  }
  try {
    git('rev-parse', '--git-dir')
  } catch {
    console.log('No Git metadata; local hooks were not installed in this source archive.')
    return
  }
  const custom = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (custom.error || ![0, 1].includes(custom.status))
    throw new Error('Cannot read Git hooks configuration.')
  if (custom.stdout.trim())
    throw new Error(
      'Custom core.hooksPath detected. Integrate check:secrets:staged and check:secrets in those hooks; it was not overwritten.',
    )
  const hooks = path.resolve(repoRoot, git('rev-parse', '--git-path', 'hooks'))
  await mkdir(hooks, { recursive: true })
  for (const [name, mode] of [
    ['pre-commit', 'staged'],
    ['pre-push', 'history'],
  ]) {
    const hook = path.join(hooks, name)
    const backup = `${hook}.before-gitcode-secrets`
    const previous = await readOptional(hook)
    if (previous !== null && !previous.includes(marker)) {
      if ((await readOptional(backup)) !== null)
        throw new Error(`Cannot replace existing hook backup: ${backup}`)
      await rename(hook, backup)
    }
    const content = `#!/bin/sh\n${marker}\nnode "$(git rev-parse --show-toplevel)/scripts/check-secrets.mjs" ${mode} || exit $?\nif [ -x ${quote(backup)} ]; then\n  exec ${quote(backup)} "$@"\nfi\n`
    await writeFile(hook, content)
    await chmod(hook, 0o755)
  }
  console.log(
    'Installed staged pre-commit and full-history pre-push scans; existing hooks were preserved and chained.',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
