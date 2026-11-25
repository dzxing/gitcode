import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ensureScanner, scanArguments, version } from '../check-secrets.mjs'
import { install } from '../install-git-hooks.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const config = path.join(root, '.gitleaks.toml')
const credential = 'audit-fixture-value'
const assignment = `${['pass', 'word'].join('')} = ${JSON.stringify(credential)}\n`

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

test('scan modes require redaction and do not trust inline or fingerprint suppressions', () => {
  const staged = scanArguments('staged', '/repo', '/trusted/config', '/trusted/empty')
  assert.ok(staged.includes('--staged'))
  assert.ok(staged.includes('--pre-commit'))
  assert.ok(staged.includes('--redact=100'))
  assert.ok(staged.includes('--ignore-gitleaks-allow'))
  assert.equal(staged[staged.indexOf('--gitleaks-ignore-path') + 1], '/trusted/empty')
  assert.ok(scanArguments('history', '/repo', config, '/empty').includes('--log-opts=--all'))
  assert.throws(() => scanArguments('unexpected', '/repo', config, '/empty'))
})

test('real scanner blocks staged secrets, removed historical secrets and native Git hooks', async () => {
  const scanner = await ensureScanner()
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gitcode-secret-policy-'))
  const repo = path.join(temp, 'working copy')
  const remote = path.join(temp, 'remote.git')
  await mkdir(repo)
  try {
    assert.equal(git(repo, 'init', '-b', 'main').status, 0)
    assert.equal(git(repo, 'config', 'user.name', 'Policy Test').status, 0)
    assert.equal(git(repo, 'config', 'user.email', 'policy@example.test').status, 0)
    assert.equal(git(repo, 'config', '--local', '--unset-all', 'core.hooksPath').status, 5)
    const empty = path.join(temp, 'empty-ignore')
    await writeFile(empty, '')
    const detect = (mode) =>
      spawnSync(scanner, scanArguments(mode, repo, config, empty), { cwd: repo, encoding: 'utf8' })
    await writeFile(path.join(repo, 'sample.txt'), 'safe content\n')
    assert.equal(git(repo, 'add', '.').status, 0)
    assert.equal(detect('staged').status, 0)
    await writeFile(path.join(repo, 'sample.txt'), assignment + '# gitleaks:allow\n')
    assert.equal(git(repo, 'add', '.').status, 0)
    await writeFile(path.join(repo, 'sample.txt'), 'safe content\n')
    const staged = detect('staged')
    assert.equal(staged.status, 10, 'scan must inspect the staged version, not the working file')
    assert.ok(!(staged.stdout + staged.stderr).includes(credential), 'reports must redact values')
    assert.equal(git(repo, 'add', '.').status, 0)

    // Exercise the actual installed hooks with the real scanner and an existing user hook.
    await mkdir(path.join(repo, 'scripts'), { recursive: true })
    await copyFile(
      path.join(root, 'scripts/check-secrets.mjs'),
      path.join(repo, 'scripts/check-secrets.mjs'),
    )
    await copyFile(config, path.join(repo, '.gitleaks.toml'))
    const cache = path.join(
      repo,
      '.gitcode-local',
      'tools',
      'gitleaks',
      version,
      `${process.platform}-${process.arch}`,
    )
    await mkdir(cache, { recursive: true })
    const binary = path.join(cache, path.basename(scanner))
    await copyFile(scanner, binary)
    await chmod(binary, 0o755)
    const hooks = path.join(repo, '.git/hooks')
    const previousHook = '#!/bin/sh\nprintf old-hook-ran\\n\ncat > .git/old-push-input\n'
    await writeFile(path.join(hooks, 'pre-push'), previousHook)
    await chmod(path.join(hooks, 'pre-push'), 0o755)
    await install(repo, { ci: false })
    await install(repo, { ci: false })
    assert.equal(
      await readFile(path.join(hooks, 'pre-push.before-gitcode-secrets'), 'utf8'),
      previousHook,
    )
    assert.equal(git(repo, 'commit', '-m', 'clean baseline').status, 0)
    assert.equal(git(repo, 'init', '--bare', remote).status, 0)
    assert.equal(git(repo, 'remote', 'add', 'origin', remote).status, 0)
    const cleanPush = git(repo, 'push', 'origin', 'main')
    assert.equal(cleanPush.status, 0, cleanPush.stderr)
    assert.match(
      await readFile(path.join(repo, '.git/old-push-input'), 'utf8'),
      /refs\/heads\/main/,
    )

    await writeFile(path.join(repo, 'sample.txt'), assignment)
    assert.equal(git(repo, 'add', 'sample.txt').status, 0)
    const rejected = git(repo, 'commit', '-m', 'must be blocked')
    assert.notEqual(rejected.status, 0, 'native pre-commit must reject a low-entropy secret')
    assert.ok(!(rejected.stdout + rejected.stderr).includes(credential))
    assert.equal(
      git(
        repo,
        '-c',
        'core.hooksPath=' + path.join(temp, 'no-hooks'),
        'commit',
        '-m',
        'bypass only inside isolated test',
      ).status,
      0,
    )
    await writeFile(path.join(repo, 'sample.txt'), 'safe content\n')
    assert.equal(git(repo, 'add', 'sample.txt').status, 0)
    assert.equal(git(repo, 'commit', '-m', 'remove fixture credential').status, 0)
    assert.equal(
      detect('history').status,
      10,
      'deleting a secret must not hide it from history scanning',
    )
    assert.notEqual(
      git(repo, 'push', 'origin', 'main').status,
      0,
      'native pre-push must reject historical secrets',
    )
    const badConfig = spawnSync(
      scanner,
      scanArguments('staged', repo, path.join(temp, 'missing.toml'), empty),
      { encoding: 'utf8' },
    )
    assert.notEqual(badConfig.status, 0, 'missing configuration must fail closed')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
