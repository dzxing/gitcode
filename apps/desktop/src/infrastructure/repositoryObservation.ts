import type { BackgroundReadResult, RepositoryChanges } from '../shared/contracts'

interface Options {
  context(): string | null
  allowed(): boolean
  status(key: string): Promise<RepositoryChanges | null>
  read(key: string): Promise<BackgroundReadResult>
  apply(key: string, result: BackgroundReadResult): Promise<boolean>
  reading(value: boolean): void
  error(value: unknown): void
  deferred(value: boolean): void
  now?: () => number
}

export function createRepositoryObservation(options: Options) {
  const now = options.now || Date.now
  let disposed = false,
    inFlight = false,
    current: string | null = null
  let revision = '',
    dirty = true,
    requested = 0,
    lastAttempt = -Infinity,
    lastRead = -Infinity
  function request() {
    dirty = true
    requested++
  }
  async function tick() {
    if (disposed || inFlight) return
    const key = options.context()
    if (key !== current) {
      current = key
      revision = ''
      lastAttempt = -Infinity
      lastRead = -Infinity
      request()
      options.error(null)
      options.deferred(false)
    }
    if (!key || !options.allowed()) return
    inFlight = true
    try {
      const state = await options.status(key)
      if (disposed || key !== options.context() || !options.allowed() || !state) return
      if (state.revision !== revision) {
        revision = state.revision
        dirty = true
      }
      if (now() - lastRead >= (state.fallback ? 10000 : 30000)) dirty = true
      if (!dirty || now() - lastAttempt < 1500) return
      const generation = requested
      dirty = false
      lastAttempt = now()
      options.reading(true)
      const result = await options.read(key)
      if (disposed || key !== options.context()) return
      if (!options.allowed() || generation !== requested) {
        dirty = true
        return
      }
      if (!result.snapshot) {
        dirty = true
        options.deferred(result.deferred === 'locked')
        return
      }
      if (!(await options.apply(key, result))) {
        dirty = true
        return
      }
      lastRead = now()
      options.error(null)
      options.deferred(false)
      if (generation !== requested) dirty = true
    } catch (error) {
      if (!disposed && key === options.context()) {
        dirty = true
        options.error(error)
      }
    } finally {
      inFlight = false
      if (!disposed) options.reading(false)
    }
  }
  return {
    request,
    tick,
    dispose: () => {
      disposed = true
      options.reading(false)
    },
  }
}
