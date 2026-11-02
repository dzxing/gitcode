import { createRequire } from 'node:module'
import type { Connect, Plugin } from 'vite'

interface LocalCore {
  middleware: Connect.NextHandleFunction
  close(): Promise<void>
}
const { createLocalCore } = createRequire(import.meta.url)('../electron/local-core.cjs') as {
  createLocalCore: (options: { port?: number }) => LocalCore
}

export function localCorePlugin(): Plugin {
  return {
    name: 'gitcode-local-core',
    apply: 'serve',
    configureServer(server) {
      const core = createLocalCore({ port: server.config.server.port })
      server.middlewares.use(core.middleware)
      const close = server.close.bind(server)
      server.close = async () => {
        await core.close()
        await close()
      }
    },
  }
}
