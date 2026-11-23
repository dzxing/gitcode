import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createSocket } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import { createServer } from 'vite'
import { createRequire } from 'node:module'

test('core edits reload a CommonJS dependency in the same Vite process', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-core-reload-'))
  let server
  try {
    await mkdir(root + '/scripts')
    await mkdir(root + '/electron')
    await symlink(
      path.dirname(path.dirname(createRequire(import.meta.url).resolve('vite/package.json'))),
      root + '/node_modules',
      'dir',
    )
    await copyFile(
      project + '/scripts/local-core-plugin.ts',
      root + '/scripts/local-core-plugin.ts',
    )
    await writeFile(root + '/index.html', '<html><body>Core reload test</body></html>')
    await writeFile(root + '/electron/sync.cjs', "exports.revision = 'before'\n")
    await writeFile(
      root + '/electron/local-core.cjs',
      `
const { revision } = require('./sync.cjs')
exports.createLocalCore = () => ({
  middleware(req, res, next) {
    if (req.url !== '/__test_revision') return next()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ revision, pid: process.pid }))
  },
  async drain() {},
  async close() {},
})\n`,
    )
    const socket = createSocket()
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    )
    await writeFile(
      root + '/vite.config.ts',
      `
import { localCorePlugin } from './scripts/local-core-plugin'
export default { root: ${JSON.stringify(root)}, plugins: [localCorePlugin()], server: {
  host: '127.0.0.1', port: ${port}, strictPort: true,
  watch: { ignored: ['**/electron/node_modules/**'] },
} }\n`,
    )
    server = await createServer({ configFile: root + '/vite.config.ts', logLevel: 'error' })
    await server.listen()
    const url = `http://127.0.0.1:${port}/__test_revision`
    const read = async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).json()
    const initial = await read()
    assert.equal(initial.revision, 'before')
    for (const revision of ['after', 'after-second-edit']) {
      await writeFile(root + '/electron/sync.cjs', `exports.revision = '${revision}'\n`)
      let current
      for (let attempt = 0; attempt < 100; attempt++) {
        await pause(100)
        current = await read().catch(() => null)
        if (current?.revision === revision) break
      }
      assert.equal(
        current?.revision,
        revision,
        'Watcher restart must clear the transitive CJS cache',
      )
      assert.equal(current.pid, initial.pid, 'The cache must also refresh on an in-process restart')
    }
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
