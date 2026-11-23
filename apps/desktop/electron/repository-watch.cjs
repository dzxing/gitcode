'use strict'
const fs = require('node:fs/promises')
const { watch } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Watch Git-visible directories rather than recursively crawling ignored build
// trees. Polling revisions is shared by the native and browser transports.
class RepositoryWatch {
  constructor(git, { watchDirectory = watch, limit = 512, now = Date.now } = {}) {
    this.git = git
    this.watchDirectory = watchDirectory
    this.limit = limit
    this.now = now
    this.entries = new Map()
    this.closed = false
    this.reaper = setInterval(() => {
      for (const [key, entry] of this.entries)
        if (this.now() - entry.touched > 60000) this.remove(key)
    }, 15000)
    this.reaper.unref?.()
  }
  validate(repo) {
    if (
      typeof repo !== 'string' ||
      !path.isAbsolute(repo) ||
      repo.length > 32768 ||
      repo.includes('\0')
    )
      throw Error('无效的仓库路径。')
  }
  remove(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.closed = true
    for (const value of entry.handles.values()) value.watcher.close()
    this.entries.delete(key)
  }
  close() {
    this.closed = true
    clearInterval(this.reaper)
    for (const key of this.entries.keys()) this.remove(key)
  }
  result(entry) {
    return {
      revision: `${entry.id}:${entry.revision}`,
      fallback: entry.fallback,
      watched: entry.handles.size,
    }
  }
  async status(repo) {
    this.validate(repo)
    if (this.closed || this.git.closing) return null
    let entry = this.entries.get(repo)
    if (!entry) {
      if (this.git.pendingJobs) return null
      while (this.entries.size >= 3) this.remove(this.entries.keys().next().value)
      entry = {
        id: randomUUID(),
        repo,
        revision: 0,
        handles: new Map(),
        touched: this.now(),
        fallback: false,
        closed: false,
        dirty: true,
        retryAt: 0,
      }
      this.entries.set(repo, entry)
    }
    entry.touched = this.now()
    if (
      !entry.initialized &&
      !entry.pending &&
      this.now() >= entry.retryAt &&
      !this.git.pendingJobs
    ) {
      entry.pending = true
      try {
        await this.git.job(
          async (signal) => {
            entry.repo = await this.git.repository(repo, signal)
            entry.gitDir = path.resolve(
              entry.repo,
              (
                await this.git.git(entry.repo, ['rev-parse', '--absolute-git-dir'], { signal })
              ).trim(),
            )
            entry.commonDir = path.resolve(
              entry.repo,
              (
                await this.git.git(entry.repo, ['rev-parse', '--git-common-dir'], { signal })
              ).trim(),
            )
            await this.inventory(entry, signal)
            entry.initialized = true
            entry.revision++
          },
          { background: true },
        )
      } catch {
        entry.fallback = true
        entry.retryAt = this.now() + 15000
      } finally {
        entry.pending = false
      }
    }
    return this.result(entry)
  }
  async inventory(entry, signal) {
    if (this.closed || entry.closed) return
    const files = (
      await this.git.git(
        entry.repo,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { signal },
      )
    ).split('\0')
    const directories = new Set([entry.repo, entry.gitDir, entry.commonDir])
    const add = (directory) => {
      if (directories.has(directory)) return true
      if (directories.size >= this.limit) {
        entry.fallback = true
        return false
      }
      directories.add(directory)
      return true
    }
    entry.fallback = false
    for (const file of files) {
      if (!file) continue
      let directory = path.dirname(path.resolve(entry.repo, file))
      const relative = path.relative(entry.repo, directory)
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        continue
      while (directory !== entry.repo && !directories.has(directory)) {
        if (!add(directory)) break
        directory = path.dirname(directory)
      }
    }
    const metadataRoots = new Set([entry.gitDir, entry.commonDir])
    const modules = new Set(
      (await this.git.git(entry.repo, ['ls-files', '--stage', '-z'], { signal }))
        .split('\0')
        .map((record) => record.match(/^160000 [a-f0-9]+ [0-3]\t([\s\S]+)$/)?.[1])
        .filter(Boolean),
    )
    // Watch initialized submodule metadata without recursively crawling build
    // folders or spawning Git once per submodule. Nested uncommitted edits keep
    // the polling fallback; any submodule commit/index change triggers promptly.
    if (modules.size) entry.fallback = true
    const smallFile = async (file) => {
      const stat = await fs.lstat(file).catch(() => null)
      return stat?.isFile() && stat.size <= 32768
        ? fs.readFile(file, 'utf8').catch(() => null)
        : null
    }
    let visited = 0
    for (const file of modules) {
      if (signal?.aborted) throw Error('仓库观察已取消。')
      if (visited++ >= 32) break
      const relative = path.relative(entry.repo, path.resolve(entry.repo, file))
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        continue
      let directory = entry.repo,
        safe = true
      for (const part of relative.split(path.sep)) {
        directory = path.join(directory, part)
        const stat = await fs.lstat(directory).catch(() => null)
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
          safe = false
          break
        }
      }
      if (!safe) continue
      const dotGit = path.join(directory, '.git')
      const gitFile = await smallFile(dotGit)
      const gitDir = gitFile?.startsWith('gitdir: ')
        ? path.resolve(directory, gitFile.slice(8).trim())
        : (await fs.lstat(dotGit).catch(() => null))?.isDirectory()
          ? dotGit
          : null
      if (!gitDir) continue
      const head = await smallFile(path.join(gitDir, 'HEAD'))
      if (!head || !/^(?:ref: refs\/|[a-f0-9]{40}(?:[a-f0-9]{24})?\s*$)/.test(head)) continue
      const common = await smallFile(path.join(gitDir, 'commondir'))
      const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir
      if (!add(directory) || !add(gitDir) || !add(commonDir)) break
      metadataRoots.add(gitDir)
      metadataRoots.add(commonDir)
    }
    // Reftable stores all branch/tag updates below this directory, without
    // touching HEAD or refs/. Watching only the metadata root misses them.
    for (const root of metadataRoots) add(path.join(root, 'reftable'))
    const queue = [...metadataRoots].map((dir) => path.join(dir, 'refs'))
    while (queue.length && directories.size < this.limit) {
      const directory = queue.shift()
      add(directory)
      const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const child of children)
        if (child.isDirectory()) queue.push(path.join(directory, child.name))
    }
    if (queue.length) entry.fallback = true
    for (const directory of [
      path.join(entry.gitDir, 'rebase-merge'),
      path.join(entry.gitDir, 'rebase-apply'),
    ])
      add(directory)
    for (const [directory, value] of entry.handles) {
      if (!directories.has(directory)) {
        value.watcher.close()
        entry.handles.delete(directory)
      }
    }
    for (const directory of directories) {
      if (this.closed || entry.closed) return
      const stat = await fs.stat(directory).catch(() => null)
      if (!stat?.isDirectory()) {
        entry.handles.get(directory)?.watcher.close()
        entry.handles.delete(directory)
        continue
      }
      const identity = `${stat.dev}:${stat.ino}`
      if (entry.handles.get(directory)?.identity === identity) continue
      entry.handles.get(directory)?.watcher.close()
      entry.handles.delete(directory)
      if (this.closed || entry.closed) return
      try {
        const watcher = this.watchDirectory(
          directory,
          { persistent: false },
          (_event, filename) => {
            if (entry.closed || (filename && String(filename).endsWith('.lock'))) return
            entry.revision++
            entry.dirty = true
          },
        )
        watcher.on('error', () => {
          if (!entry.closed) {
            entry.fallback = true
            entry.revision++
            entry.dirty = true
            if (entry.handles.get(directory)?.watcher === watcher) entry.handles.delete(directory)
            watcher.close()
          }
        })
        entry.handles.set(directory, { watcher, identity })
      } catch {
        entry.fallback = true
      }
    }
    entry.dirty = false
  }
  async read(repo, request) {
    this.validate(repo)
    if (request !== null && (typeof request !== 'object' || Array.isArray(request)))
      throw Error('无效的后台读取请求。')
    const file = request?.file
    if (
      file &&
      (typeof file.path !== 'string' || !['working', 'staged', 'unstaged'].includes(file.source))
    )
      throw Error('无效的差异读取请求。')
    if (this.closed || this.git.closing || this.git.pendingJobs)
      return { snapshot: null, deferred: 'busy' }
    const entry = this.entries.get(repo)
    if (entry?.gitDir && entry?.commonDir) {
      const locks = [
        path.join(entry.gitDir, 'index.lock'),
        path.join(entry.gitDir, 'HEAD.lock'),
        path.join(entry.commonDir, 'packed-refs.lock'),
        path.join(entry.commonDir, 'config.lock'),
      ]
      if (
        (
          await Promise.all(
            locks.map((file) =>
              fs.stat(file).then(
                () => true,
                () => false,
              ),
            ),
          )
        ).some(Boolean)
      )
        return { snapshot: null, deferred: 'locked' }
    }
    // Recheck after asynchronous filesystem probes; foreground work always wins.
    if (this.git.pendingJobs || this.git.closing) return { snapshot: null, deferred: 'busy' }
    return this.git
      .job(
        async (signal) => {
          const root = await this.git.repository(repo, signal)
          const snapshot = await this.git.snapshot(root, signal)
          if (entry && !entry.closed) {
            // A new directory or externally changed index may need additional watches.
            if (entry.gitDir && entry.commonDir) await this.inventory(entry, signal)
            entry.touched = this.now()
          }
          let diff = null
          if (file) {
            const staged = snapshot.staged.find((item) => item.path === file.path)
            const unstaged = snapshot.unstaged.find((item) => item.path === file.path)
            const found = file.source === 'staged' ? staged || unstaged : unstaged || staged
            if (found) {
              const source =
                file.source === 'working'
                  ? 'working'
                  : staged && (!unstaged || file.source === 'staged')
                    ? 'staged'
                    : 'unstaged'
              try {
                diff = {
                  file: found,
                  source,
                  ...(await this.git.diff(
                    root,
                    file.path,
                    source === 'working' ? 'working' : source === 'staged',
                    null,
                    signal,
                  )),
                }
              } catch (error) {
                diff = { file: found, source, error: this.git.safeError(error) }
              }
            }
          }
          return { snapshot, diff }
        },
        { background: true, preemptible: true },
      )
      .catch((error) => {
        if (error.code === 'READ_PREEMPTED') return { snapshot: null, deferred: 'busy' }
        throw error
      })
  }
}
module.exports = { RepositoryWatch }
