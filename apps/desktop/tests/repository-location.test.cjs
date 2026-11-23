const test = require('node:test')
const assert = require('node:assert/strict')
const { repositoryLocation } = require('../electron/repository-location.cjs')

test('location operations use the trusted canonical repository and never execute a path', async () => {
  const calls = [],
    signal = AbortSignal.timeout(1000)
  const git = {
    job: (work) => work(signal),
    repository: async (repo, actualSignal) => {
      assert.equal(repo, '/selected/repo')
      assert.equal(actualSignal, signal)
      return '/canonical/repo'
    },
  }
  const shell = { showItemInFolder: (path) => calls.push(['show', path]) }
  const clipboard = { writeText: (path) => calls.push(['copy', path]) }
  await repositoryLocation(git, shell, clipboard, '/selected/repo', 'copy-path')
  await repositoryLocation(git, shell, clipboard, '/selected/repo', 'show-folder')
  assert.deepEqual(calls, [
    ['copy', '/canonical/repo'],
    ['show', '/canonical/repo'],
  ])
})

test('invalid operations and untrusted repositories cannot reach the clipboard or OS shell', async () => {
  let reads = 0,
    sideEffects = 0
  const git = {
    job: (work) => work(),
    repository: async () => {
      reads++
      throw Error('repository is not trusted')
    },
  }
  const shell = { showItemInFolder: () => sideEffects++ },
    clipboard = { writeText: () => sideEffects++ }
  for (const action of ['execute', 'openPath', '', null])
    await assert.rejects(
      repositoryLocation(git, shell, clipboard, '/tmp/file.exe', action),
      /不支持/,
    )
  assert.equal(reads, 0)
  for (const action of ['copy-path', 'show-folder'])
    await assert.rejects(
      repositoryLocation(git, shell, clipboard, '/untrusted', action),
      /not trusted/,
    )
  assert.equal(reads, 2)
  assert.equal(sideEffects, 0)
})
