import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'

interface LocalCore {
  middleware: Connect.NextHandleFunction
  drain(): Promise<void>
  close(): Promise<void>
}
const requireCore = createRequire(import.meta.url)
const coreEntry = requireCore.resolve('../electron/local-core.cjs')
const coreDirectory = dirname(coreEntry)
function isCoreFile(file: string) {
  return dirname(resolve(file)) === coreDirectory && extname(file) === '.cjs'
}
function loadCore() {
  // Vite restarts reuse this process, including Node's CommonJS module cache.
  for (const file of Object.keys(requireCore.cache))
    if (isCoreFile(file)) delete requireCore.cache[file]
  return requireCore(coreEntry) as {
    createLocalCore: (options: { port?: number }) => LocalCore
  }
}

export function localCorePlugin(): Plugin {
  return {
    name: 'gitcode-local-core',
    apply: 'serve',
    configureServer(server) {
      const { createLocalCore } = loadCore()
      const core = createLocalCore({ port: server.config.server.port })
      server.middlewares.use(core.middleware)
      server.watcher.add(coreDirectory)
      let timer: ReturnType<typeof setTimeout> | undefined
      let restarting = false
      let disposed = false
      const changed = (file: string) => {
        if (!isCoreFile(file) || restarting || disposed) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          restarting = true
          // Finish any in-flight Git operation before invalidating its session.
          void core
            .drain()
            .then(async () => {
              if (disposed) return
              server.config.logger.info('Git 核心已更新，正在重新加载开发服务…')
              await server.restart()
              server.ws.send({ type: 'full-reload' })
            })
            .catch((error: unknown) => {
              server.config.logger.error(`Git 核心重新加载失败：${String(error)}`)
            })
        }, 200)
      }
      server.watcher.on('change', changed)
      server.watcher.on('add', changed)
      server.watcher.on('unlink', changed)
      const close = server.close.bind(server)
      server.close = async () => {
        disposed = true
        clearTimeout(timer)
        server.watcher.off('change', changed)
        server.watcher.off('add', changed)
        server.watcher.off('unlink', changed)
        await core.close()
        await close()
      }
    },
    handleHotUpdate({ file }) {
      if (isCoreFile(file)) return []
      return undefined
    },
  }
}
