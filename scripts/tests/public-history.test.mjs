import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkPublicHistory } from '../check-public-history.mjs'

test('legacy portal history is retained but new public commits cannot reintroduce it', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'gitcode-public-scope-'))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  try {
    git('init', '-b', 'main')
    for (const [key, value] of [
      ['user.name', 'Scope QA'],
      ['user.email', 'scope@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      git('config', key, value)
    await mkdir(path.join(repo, 'apps/website'), { recursive: true })
    await writeFile(path.join(repo, 'apps/website/package.json'), '{}\n')
    git('add', '.')
    git('commit', '-m', 'legacy portal publication')
    const baseline = git('rev-parse', 'HEAD')
    assert.throws(() => checkPublicHistory(repo, baseline), /apps\/website/)
    git('rm', '--cached', 'apps/website/package.json')
    await writeFile(path.join(repo, '.gitignore'), '/apps/website/\n')
    git('add', '.gitignore')
    git('commit', '-m', 'exclude portal without rewriting history')
    assert.doesNotThrow(() => checkPublicHistory(repo, baseline))
    await writeFile(path.join(repo, 'apps/website/package.json'), '{"name":"private-site"}\n')
    git('add', '--force', 'apps/website/package.json')
    assert.throws(() => checkPublicHistory(repo, baseline), /apps\/website/)
    git('commit', '-m', 'accidental portal reintroduction')
    git('rm', '--cached', 'apps/website/package.json')
    git('commit', '-m', 'delete current copy only')
    assert.throws(() => checkPublicHistory(repo, baseline), /apps\/website/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
