const test = require('node:test')
const assert = require('node:assert/strict')
const { getPlatform } = require('../electron/platform.cjs')
const { candidates, discover, environmentForGit } = require('../electron/git-runtime.cjs')

for (const [platform, id] of [
  ['win32', 'windows'],
  ['darwin', 'macos'],
  ['linux', 'linux'],
]) {
  test(`${platform} adapter implements the same Git and font contracts`, async () => {
    const adapter = getPlatform(platform)
    assert.equal(adapter.id, id)
    assert.equal(getPlatform(platform), adapter)
    assert.ok(Object.isFrozen(adapter.git))
    for (const method of ['candidates', 'probeOptions', 'defer', 'environment'])
      assert.equal(typeof adapter.git[method], 'function')
    assert.equal(typeof adapter.fonts.read, 'function')
    const locations = candidates({ platform, env: {}, selection: { mode: 'auto' } })
    assert.ok(locations.length > 0)
    for (const candidate of locations) {
      assert.equal(typeof candidate.path, 'string')
      assert.equal(candidate.source, 'system')
    }
    const calls = []
    const selected = await discover(
      async (file, args) => {
        calls.push(file)
        assert.deepEqual(args, ['--version'])
        return { code: 0, stdout: 'git version 2.54.0', stderr: '' }
      },
      { platform, env: {}, selection: { mode: 'custom', path: '/selected/git' } },
    )
    assert.equal(selected.path, '/selected/git')
    assert.deepEqual(calls, ['/selected/git'])
    const old = await discover(
      async () => ({ code: 0, stdout: 'git version 2.45.0', stderr: '' }),
      { platform, env: {}, selection: { mode: 'custom', path: '/selected/git' } },
    )
    assert.equal(old.path, '/selected/git')
    assert.equal(old.version, 'git version 2.45.0')
    if (platform !== 'win32') {
      const env = { PATH: '/my/bin', GIT_EXEC_PATH: '/my/git/core' }
      assert.equal(environmentForGit(env, '/selected/git', 'system', platform), env)
    }
  })
}
test('unsupported platforms are explicitly rejected rather than executing Linux commands', () => {
  for (const platform of ['freebsd', 'constructor', '__proto__'])
    assert.throws(() => getPlatform(platform), /尚不受支持/)
})
test('Linux and Windows candidate lists do not inherit macOS developer-tool paths', () => {
  const env = { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
  assert.deepEqual(candidates({ platform: 'linux', env }), [{ path: 'git', source: 'system' }])
  assert.ok(
    candidates({ platform: 'win32', env }).every((candidate) => !candidate.path.includes('Xcode')),
  )
})
