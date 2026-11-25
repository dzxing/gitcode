'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { TextDecoder } = require('node:util')
const { createHash, randomUUID } = require('node:crypto')
const { progressParser } = require('./progress.cjs')
const { SyncOperations } = require('./sync.cjs')
const { FetchSettings } = require('./fetch-settings.cjs')
const { GitFlowOperations } = require('./gitflow.cjs')
const { SelectedCommitOperations } = require('./selected-commit.cjs')
const { StashOperations } = require('./stash.cjs')
const { NavigationOperations } = require('./navigation.cjs')
const { MergeOperations } = require('./merge.cjs')
const { RebaseOperations } = require('./rebase.cjs')
const { CommitOperations } = require('./commit-operations.cjs')
const { CheckoutOperations } = require('./checkout.cjs')
const { GitFlowFinishOperations } = require('./gitflow-finish.cjs')
const { AutoStashOperations } = require('./auto-stash.cjs')
const gitRuntime = require('./git-runtime.cjs')
const { OperationLog } = require('./operation-log.cjs')
const { autoFetch } = require('./auto-fetch.cjs')
const { RepositoryWatch } = require('./repository-watch.cjs')
const { RecoveryOperations } = require('./recovery.cjs')
const { PartialStageOperations } = require('./partial-stage.cjs')
const { diagnoseCommand, presentCommandFailure } = require('./command-diagnostics.cjs')

const { RepositoryTrust, TRUST_READ } = require('./repository-trust.cjs')

const { HistoryOperations } = require('./history.cjs')
const { HistoryTools } = require('./history-tools.cjs')

const MAX_OUTPUT = 32 * 1024 * 1024
const MAX_DIFF = 300_000
const READ_PREEMPTED = Symbol('background read yielded to foreground')
const CANCELLED = 'Git 操作已取消。取消不等于回滚，请刷新检查仓库状态。'
const decoder = new TextDecoder('utf-8', { fatal: true })

function string(value, label, { empty = false, max = 32_768 } = {}) {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0') || value.length > max)
    throw new Error(`无效的${label}。`)
  return value
}

function absolutePath(value) {
  string(value, '本机路径')
  if (value === '~') value = os.homedir()
  else if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2))
  if (!path.isAbsolute(value)) throw new Error('请输入当前操作系统中的绝对路径。')
  if (process.platform === 'win32') {
    const normalized = value
      .replaceAll('/', '\\')
      .toLowerCase()
      .replace(/^\\\\\?\\unc\\/, '\\\\')
    if (/^\\\\wsl(?:\.localhost|\$)\\/.test(normalized))
      throw new Error('WSL 仓库必须通过对应发行版的核心访问，请重新打开仓库。')
  }
  return path.normalize(value)
}

function filePath(value) {
  string(value, '仓库内文件路径')
  const parts = value.split(process.platform === 'win32' ? /[\\/]/ : '/')
  if (
    path.isAbsolute(value) ||
    parts.some((p) => p === '..' || p === '.' || !p) ||
    (process.platform === 'win32' && /^[a-z]:/i.test(value))
  )
    throw new Error('无效的仓库内文件路径。')
  return value
}

function revision(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value))
    throw new Error('无效的提交 ID。')
  return value
}

function validRemote(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes('\0') &&
    !value.startsWith('-') &&
    (path.isAbsolute(value) ||
      /^(?:https?|ssh|git|file):\/\//.test(value) ||
      /^[\w.-]+@[\w.-]+:.+/.test(value))
  )
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The child may already have exited before the fallback kill.
      }
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // The child may already have exited before the fallback kill.
      }
    }
  }
}

// No shell is involved. Output is drained asynchronously; cancellation kills
// Git's process group/tree so SSH and hooks cannot retain the output pipes.
function execute(
  executable,
  args,
  { cwd, timeout = 30_000, signal, env = process.env, input, onStderr, onStdout, onPrepared } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(CANCELLED))
    let child
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const stdout = [],
      stderr = []
    const preparedController = new AbortController()
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      if (onPrepared) child.stdin.write(input)
      else child.stdin.end(input)
    }
    let outBytes = 0,
      errBytes = 0,
      failure = null,
      prepared = false,
      commitSent = false,
      killTimer,
      preparationTask = null,
      stopping = false,
      protocol = ''
    function stop(message) {
      failure ||= message instanceof Error ? message : new Error(message)
      if (stopping) return
      stopping = true
      preparedController.abort(failure)
      if (onPrepared && !commitSent) {
        // Let Git abort its prepared transaction and release its own lock files.
        // A stuck reference-transaction hook still has a bounded cancellation.
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('abort\n')
        killTimer = setTimeout(() => killTree(child), 1500)
      } else killTree(child)
    }
    const onAbort = () => stop(CANCELLED)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(
      () => stop('Git 操作超时，请检查认证或连接，并刷新仓库确认状态。'),
      timeout,
    )
    child.stdout.on('data', (chunk) => {
      onStdout?.(chunk)
      outBytes += chunk.length
      if (outBytes <= MAX_OUTPUT) stdout.push(chunk)
      else stop('Git 输出超过 32 MiB，请缩小操作范围。')
      if (onPrepared && !prepared && !failure) {
        protocol = (protocol + chunk.toString('utf8')).slice(-4096)
        if (/(?:^|\n)prepare: ok\r?\n/.test(protocol)) {
          prepared = true
          preparationTask = Promise.resolve()
            .then(() => onPrepared(preparedController.signal))
            .then(
              () => {
                if (!failure && child.exitCode === null) {
                  commitSent = true
                  child.stdin.end('commit\n')
                }
              },
              (error) => {
                stop(error instanceof Error ? error : new Error(String(error)))
              },
            )
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      onStderr?.(chunk)
      errBytes += chunk.length
      if (errBytes <= MAX_OUTPUT) stderr.push(chunk)
      else stop('Git 错误输出超过 32 MiB。')
    })
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      preparedController.abort(error)
      reject(new Error(`无法启动 Git：${error.message}`))
    })
    child.once('close', async (code, termination) => {
      cleanup()
      if (!commitSent) preparedController.abort(new Error('Git 引用事务已结束。'))
      // Cooperative callbacks must finish before their owner releases index
      // locks or temporary files. Bound this wait if a callback ignores abort.
      if (preparationTask) {
        let settlementTimer
        try {
          await Promise.race([
            preparationTask,
            new Promise((resolve) => {
              settlementTimer = setTimeout(resolve, 1500)
            }),
          ])
        } catch (error) {
          failure ||= error instanceof Error ? error : new Error(String(error))
        } finally {
          clearTimeout(settlementTimer)
        }
      }
      if (failure) {
        failure.gitResult = {
          code,
          termination,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }
        return reject(failure)
      }
      let out
      try {
        out = decoder.decode(Buffer.concat(stdout))
      } catch {
        return reject(new Error('仓库包含无法用 UTF-8 表示的内容或路径，当前版本无法安全处理。'))
      }
      if (onPrepared && code === 0 && !/(?:^|\n)commit: ok\r?\n/.test(out))
        return reject(new Error('引用事务未确认提交，请核对仓库状态。'))
      resolve({ code, termination, stdout: out, stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

function parseStatus(raw) {
  if (raw && !raw.endsWith('\0')) throw new Error('Git 状态输出不完整。')
  const records = raw.split('\0'),
    staged = [],
    unstaged = []
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]
    if (!entry) continue
    if (entry.length < 4) throw new Error('无法解析 Git 文件状态。')
    const code = entry.slice(0, 2),
      file = { path: entry.slice(3) }
    if (/[RC]/.test(code)) {
      if (!records[i + 1]) throw new Error('重命名记录缺少原路径。')
      file.oldPath = records[++i]
    }
    if (code === '??') unstaged.push({ ...file, status: '?' })
    else if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code))
      unstaged.push({ ...file, status: 'U' })
    else {
      if (code[0] !== ' ') staged.push({ ...file, status: code[0] })
      if (code[1] !== ' ') unstaged.push({ ...file, status: code[1] })
    }
  }
  return { staged, unstaged }
}

class GitService {
  constructor(runtimeOptions = {}) {
    // Internal fixture helpers may use GitService directly. Both application
    // transports enforce trust; the renderer cannot change these options.
    this.runtimeOptions = runtimeOptions
    this.trust = new RepositoryTrust(this, { directory: runtimeOptions.dataDirectory })
    this.terminal = new (require('./terminal.cjs').TerminalService)(this)
    this.console = new (require('./git-console.cjs').GitConsole)()
    this.history = new HistoryOperations(this)
    this.historyTools = new HistoryTools(this, filePath)
    this.journal =
      runtimeOptions.journal || new OperationLog({ directory: runtimeOptions.dataDirectory })
    this.activeLog = null
    this.pendingJobs = 0
    this.background = false
    this.backgroundSsh = null
    this.activity = null
    this.gitSource = ''
    this.gitError = ''
    this.gitPath = null
    this.gitVersion = ''
    this.discovery = null
    this.runtimeRevision = 0
    this.commandHelpCache = new Map()
    this.tail = Promise.resolve()
    this.current = null
    this.generation = 0
    this.closing = false
    this.lastDirectory = null
    this.repositoryLocations = new Map()
    this.sync = new SyncOperations(this, validRemote)
    this.fetchSettings = new FetchSettings(this)
    this.flow = new GitFlowOperations(this)
    this.selectedCommit = new SelectedCommitOperations(this, { filePath, string })
    this.stash = new StashOperations(this, { filePath, string })
    this.autoStash = new AutoStashOperations(this)
    this.merge = new MergeOperations(this, { filePath, string })
    this.rebase = new RebaseOperations(this)
    this.commitOperations = new CommitOperations(this)
    this.flowFinish = new GitFlowFinishOperations(this)
    this.checkout = new CheckoutOperations(this)
    this.navigation = new NavigationOperations(this, { string, revision, filePath, validRemote })
    this.repositoryWatch = new RepositoryWatch(this)
    this.recovery = new RecoveryOperations(this)
    this.partialStage = new PartialStageOperations(this, { filePath })
    this.wsl =
      process.platform === 'win32'
        ? new (require('./wsl.cjs').WslManager)(this, runtimeOptions)
        : null
  }

  async discover() {
    if (this.discovery) return this.discovery
    const revision = this.runtimeRevision
    this.discovery = (async () => {
      const found = await gitRuntime.discover(execute, this.runtimeOptions)
      if (revision !== this.runtimeRevision) return
      this.gitPath = found.path || null
      this.gitVersion = found.version || ''
      this.gitSource = found.source || ''
      this.gitError = found.error || ''
    })()
    return this.discovery
  }

  async runtime() {
    await this.discover()
    return this.runtimeState()
  }

  runtimeState() {
    return {
      platform:
        process.platform === 'darwin'
          ? 'macos'
          : process.platform === 'win32'
            ? 'windows'
            : process.platform,
      gitAvailable: !!this.gitPath,
      gitVersion: this.gitVersion,
      gitPath: this.gitPath || '',
      gitSource: this.gitSource,
      gitError: this.gitError,
    }
  }

  async runtimeSettings() {
    await this.discover()
    return {
      selection: gitRuntime.preference(this.runtimeOptions.selection || { mode: 'auto' }),
      runtime: this.runtimeState(),
    }
  }

  async retryRuntime() {
    // Re-detect a failed startup probe after Git/tools have been installed.
    // A valid active executable is never switched beneath pending operations.
    if (this.closing) throw new Error('应用正在退出，无法重新检测 Git。')
    if (this.gitPath) return this.runtime()
    if (this.current || this.pendingJobs) throw new Error('请等待当前 Git 操作完成后重新检测。')
    const pending = this.discover()
    const discovery = this.discovery
    await pending
    if (!this.gitPath && this.discovery === discovery) {
      if (this.current || this.pendingJobs) throw new Error('请等待当前 Git 操作完成后重新检测。')
      this.discovery = null
    }
    return this.runtime()
  }

  async configureRuntime(value, persist = async () => {}) {
    const selection = gitRuntime.preference(value)
    if (this.closing || this.current || this.pendingJobs)
      throw Error('请等待当前 Git 操作完成后修改运行环境。')
    const env = this.runtimeOptions.env || process.env
    if (env.GITCODE_GIT_PATH || env.GITK_GIT_PATH)
      throw Error(
        '当前 Git 由环境变量指定，请先移除 GITCODE_GIT_PATH 或 GITK_GIT_PATH，再修改此设置。',
      )
    return this.job(async (signal) => {
      const found = await gitRuntime.discover(execute, { ...this.runtimeOptions, selection })
      if (!found.path) throw Error(found.error)
      if (signal.aborted) throw Error(CANCELLED)
      // Save before publishing the new runtime. A failed save leaves the
      // active executable and all cached state unchanged.
      await persist(selection)
      this.runtimeRevision++
      this.runtimeOptions = { ...this.runtimeOptions, selection }
      this.gitPath = found.path
      this.gitVersion = found.version
      this.gitSource = found.source
      this.gitError = ''
      this.discovery = Promise.resolve()
      this.repositoryLocations.clear()
      this.commandHelpCache.clear()
      this.flow.plans.clear()
      this.flow.validatedStateConfigs.clear()
      this.sync.plans.clear()
      this.selectedCommit.plans.clear()
      this.commitOperations.plans.clear()
      return this.runtimeSettings()
    })
  }

  // Capturing an epoch at enqueue time cancels both active and previously
  // queued operations. Requests made after cancellation may run normally.
  job(work, { background = false, preemptible = false } = {}) {
    if (!background && this.currentPreemptible) this.current?.abort(READ_PREEMPTED)
    if (!background)
      for (const lease of this.journal.leases.values()) {
        lease.interrupted = true
        lease.controller?.abort()
      }
    this.pendingJobs++
    const queuedAt = this.generation
    const pending = this.tail.then(async () => {
      if (this.closing || queuedAt !== this.generation) throw new Error(CANCELLED)
      const controller = new AbortController()
      this.current = controller
      this.background = background
      this.currentPreemptible = background && preemptible
      this.activity = null
      try {
        const value = await work(controller.signal)
        if (controller.signal.reason === READ_PREEMPTED) throw READ_PREEMPTED
        return value
      } catch (error) {
        if (controller.signal.reason === READ_PREEMPTED)
          throw Object.assign(new Error('后台读取已让位于前台操作。'), { code: 'READ_PREEMPTED' })
        throw error
      } finally {
        if (this.current === controller) {
          this.current = null
          this.background = false
          this.currentPreemptible = false
          if (this.activity) this.activity = { ...this.activity, state: 'finished' }
        }
      }
    })
    const tracked = pending.finally(() => {
      this.pendingJobs--
    })
    this.tail = tracked.catch(() => {})
    return tracked
  }

  startActivity(operation, repo) {
    this.activity = {
      id: this.activeLog?.id || randomUUID(),
      operation,
      repo,
      phase: '正在执行',
      percent: null,
      state: 'running',
    }
  }

  cancel() {
    this.generation++
    this.current?.abort()
    this.wsl?.cancel()
  }
  async shutdown() {
    this.closing = true
    await this.terminal.shutdown()
    this.repositoryWatch.close()
    this.cancel()
    await this.wsl?.shutdown()
    await this.tail
    await this.journal.writes
  }

  async git(
    repo,
    args,
    {
      optional = false,
      timeout = 30_000,
      signal,
      allowedCodes = [0],
      input,
      onPrepared,
      indexFile,
      hooksPath,
      locale,
      rebasePlan,
      skipEditor = false,
      diagnose = false,
      [TRUST_READ]: trustRead = false,
      creatingRepository = false,
      returnCode = false,
    } = {},
  ) {
    let trustedPath = typeof trustRead === 'string' ? trustRead : ''
    if (this.runtimeOptions.enforceRepositoryTrust && !trustRead && !creatingRepository)
      trustedPath = (await this.trust.assert(repo, signal)).path
    const safeDirectory =
      process.platform === 'win32' ? trustedPath.replaceAll('\\', '/') : trustedPath
    // Git interprets a terminal /* as a directory-wide wildcard. Do not turn a
    // literal POSIX directory named * into consent for its siblings.
    if (safeDirectory.endsWith('/*'))
      throw Error('无法为目录名为 * 的仓库设置精确的安全例外，请重命名该目录后重新打开。')
    await this.discover()
    if (!this.gitPath) throw new Error((await this.runtime()).gitError)
    const env = {
      ...gitRuntime.environmentForGit(process.env, this.gitPath, this.gitSource),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    }
    if (this.background) {
      env.GCM_INTERACTIVE = 'Never'
      env.GIT_ASKPASS = 'gitcode-no-interactive-credentials'
      env.SSH_ASKPASS = 'gitcode-no-interactive-credentials'
      env.SSH_ASKPASS_REQUIRE = 'never'
      if (this.backgroundSsh) env.GIT_SSH_COMMAND = this.backgroundSsh
    }
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_CONFIG',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ])
      delete env[key]
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key]
    if (creatingRepository) env.GIT_CEILING_DIRECTORIES = path.dirname(repo)
    if (locale) env.LC_ALL = locale
    if (indexFile) env.GIT_INDEX_FILE = indexFile
    if (skipEditor) env.GIT_EDITOR = 'true'
    if (rebasePlan !== undefined) {
      const quote = (value) => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"
      const helper = path.join(
        __dirname.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'),
        'rebase-editor.cjs',
      )
      const command = `${quote(process.execPath)} ${quote(helper)}`
      env.GIT_EDITOR = `${command} message`
      env.GIT_SEQUENCE_EDITOR = `${command} sequence`
      env.GITCODE_REBASE_PLAN = rebasePlan || ''
      env.GITCODE_REBASE_GIT = this.gitPath
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    const reportProgress = progressParser((value) => {
      if (this.activity?.state === 'running') this.activity = { ...this.activity, ...value }
    })
    const commandStarted = Date.now()
    // Capture the operation before asynchronous output; queue ownership must not drift.
    const record = this.activeLog
    const quiet = new Set([
      'rev-parse',
      'status',
      'diff',
      'diff-index',
      'diff-files',
      'ls-files',
      'ls-tree',
      'log',
      'show',
      'for-each-ref',
      'symbolic-ref',
      'merge-base',
      'check-ref-format',
      'cat-file',
      'rev-list',
      'ls-remote',
      'show-ref',
      'version',
      'check-attr',
      'check-ignore',
    ])
    const visible =
      record &&
      !this.background &&
      !trustRead &&
      !args.includes('-h') &&
      !quiet.has(args[0]) &&
      !(args[0] === 'remote' && (!args[1] || ['-v', 'get-url', 'show'].includes(args[1]))) &&
      !(args[0] === 'worktree' && args[1] === 'list') &&
      !(args[0] === 'stash' && ['list', 'show'].includes(args[1])) &&
      !(
        args[0] === 'branch' &&
        (!args[1] ||
          args.some((arg) => /^--(?:show-current|list|format|contains|merged|no-merged)/.test(arg)))
      ) &&
      !(
        args[0] === 'tag' &&
        (!args[1] || args.some((arg) => /^--(?:list|format|contains|merged)/.test(arg)))
      ) &&
      !(args[0] === 'config' && args.some((arg) => /^--(?:get|list|show|includes)/.test(arg)))
    const fullArgs = [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.quotePath=false',
      '-c',
      'color.ui=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.ext.allow=never',
      // Scope Git's ownership exception to the already-approved canonical root.
      // Clear inherited lists for this process only; never edit global config.
      ...(trustedPath ? ['-c', 'safe.directory=', '-c', `safe.directory=${safeDirectory}`] : []),
      ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
      ...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []),
      ...args,
    ]
    const run = async (commandEnv) => {
      const consoleCommand = visible
        ? this.console.start(record.repo || repo, record.id, this.gitPath, fullArgs)
        : null
      try {
        const result = await execute(this.gitPath, fullArgs, {
          cwd: repo,
          timeout,
          signal,
          env: commandEnv,
          input,
          onPrepared,
          onStdout: (chunk) => consoleCommand?.write('stdout', chunk),
          onStderr: (chunk) => {
            reportProgress(chunk)
            consoleCommand?.write('stderr', chunk)
          },
        })
        consoleCommand?.finish(result)
        return result
      } catch (error) {
        consoleCommand?.finish(error.gitResult, error, signal?.aborted === true)
        throw error
      }
    }
    const result = diagnose
      ? await diagnoseCommand(env, run, (diagnostic) => this.journal.diagnostic(record, diagnostic))
      : await run(env)
    if (!trustRead && !args.includes('-h'))
      this.journal.command(record, args, result, Date.now() - commandStarted)
    if (!allowedCodes.includes(result.code)) {
      if (optional && result.code === 1) return ''
      throw new Error(
        this.safeError(result.stderr.trim() || result.stdout.trim() || 'Git 操作失败。'),
      )
    }
    return returnCode ? result : result.stdout
  }

  async repository(value, signal) {
    const candidate = absolutePath(value)
    const cached =
      this.runtimeOptions.enforceRepositoryTrust && this.repositoryLocations.get(candidate)
    if (cached) {
      // Revalidate identity and effective config, including external includes.
      // Only the immutable location result is reused, never trust consent.
      const info = await this.trust.assert(candidate, signal)
      if (
        info.key === cached.key &&
        info.path === cached.root &&
        this.gitPath === cached.gitPath &&
        this.gitVersion === cached.gitVersion
      )
        return cached.root
      this.repositoryLocations.delete(candidate)
    }
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error('请选择本机仓库目录。')
    if (
      (await this.git(candidate, ['rev-parse', '--is-bare-repository'], { signal })).trim() ===
      'true'
    )
      throw new Error('暂不支持裸仓库，请打开带工作区的仓库。')
    const location = await this.git(candidate, ['rev-parse', '--show-toplevel'], { signal })
    const root = await fs.realpath(location.replace(/[\r\n]+$/, ''))
    if (this.runtimeOptions.enforceRepositoryTrust) {
      const info = await this.trust.identity(candidate)
      if (info.path === root) {
        if (this.repositoryLocations.size >= 16)
          this.repositoryLocations.delete(this.repositoryLocations.keys().next().value)
        this.repositoryLocations.set(candidate, {
          root,
          key: info.key,
          gitPath: this.gitPath,
          gitVersion: this.gitVersion,
        })
      }
    }
    return root
  }

  async commandHelp(repo, command, signal) {
    await this.discover()
    const key = JSON.stringify([this.runtimeRevision, this.gitPath, this.gitVersion, command])
    if (this.commandHelpCache.has(key)) return this.commandHelpCache.get(key)
    // -h prints builtin usage without executing the operation. Keep failures
    // uncached so cancellation or a transient runtime error can be retried.
    const result = await this.git(repo, [...command, '-h'], {
      signal,
      locale: 'C',
      allowedCodes: [0, 1, 129],
      returnCode: true,
    })
    const help = `${result.stdout}\n${result.stderr}`
    // Older releases may not have the subcommand at all. Treat that as a
    // missing capability, while preserving real probe failures for retry.
    if (result.code === 1 && !/is not a git command/.test(help))
      throw new Error(
        this.safeError(result.stderr.trim() || result.stdout.trim() || '无法检测 Git 命令能力。'),
      )
    if (this.commandHelpCache.size >= 32) this.commandHelpCache.clear()
    const supportedHelp = result.code === 1 ? '' : help.replaceAll('--[no-]', '--')
    this.commandHelpCache.set(key, supportedHelp)
    return supportedHelp
  }

  async gitPaths(repo, names, signal) {
    const raw = await this.git(
      repo,
      ['rev-parse', '--path-format=absolute', ...names.flatMap((name) => ['--git-path', name])],
      { signal },
    )
    const values = raw.replace(/\r?\n$/, '').split(/\r?\n/)
    if (values.length === names.length && values.every((value) => path.isAbsolute(value)))
      return new Map(names.map((name, i) => [name, values[i]]))
    // A directory name can contain a newline. Preserve that unusual case by
    // resolving each path separately rather than guessing field boundaries.
    const result = new Map()
    for (const name of names)
      result.set(
        name,
        path.resolve(
          repo,
          (await this.git(repo, ['rev-parse', '--git-path', name], { signal })).replace(
            /\r?\n$/,
            '',
          ),
        ),
      )
    return result
  }

  async historyGraphBasis(repo, signal, locations, replacements) {
    locations ||= await this.gitPaths(repo, ['shallow', 'info/grafts'], signal)
    if (replacements === undefined)
      replacements = (
        await this.git(
          repo,
          ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)', 'refs/replace'],
          { signal },
        )
      ).replace(/\r?\n$/, '')
    const read = async (name) =>
      fs.readFile(locations.get(name)).catch((error) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0)
        throw error
      })
    const [shallow, grafts] = await Promise.all([read('shallow'), read('info/grafts')])
    return createHash('sha256')
      .update(replacements)
      .update('\0')
      .update(shallow)
      .update('\0')
      .update(grafts)
      .digest('hex')
  }

  safeError(error) {
    return String(error?.message || error)
      .replace(/(https?:\/\/)[^\s/@]+@/g, '$1…@')
      .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1')
  }

  async currentBranch(repo, signal) {
    const ref = (
      await this.git(repo, ['symbolic-ref', '-q', 'HEAD'], {
        allowedCodes: [0, 1],
        signal,
      })
    ).trim()
    if (!ref) return ''
    if (!ref.startsWith('refs/heads/')) throw new Error('HEAD 未指向有效的本地分支。')
    return ref.slice('refs/heads/'.length)
  }

  async head(repo, signal) {
    const head = (
      await this.git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        allowedCodes: [0, 1],
        signal,
      })
    ).trim()
    if (!head) {
      const branch = await this.currentBranch(repo, signal)
      if (!branch) throw new Error('HEAD 无法解析，请先检查仓库状态。')
      const existing = (
        await this.git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
          allowedCodes: [0, 1],
          signal,
        })
      ).trim()
      if (existing) throw new Error('HEAD 指向的提交不可读取，不能当作空仓库。')
    }
    return head
  }

  async headContext(repo, signal) {
    const value = await this.git(
      repo,
      ['rev-parse', 'HEAD^{commit}', '--symbolic-full-name', 'HEAD'],
      { signal, allowedCodes: [0, 128], returnCode: true },
    )
    const fields = value.stdout.trim().split(/\r?\n/)
    if (
      value.code === 0 &&
      fields.length === 2 &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[0]) &&
      (fields[1] === 'HEAD' || fields[1].startsWith('refs/heads/'))
    )
      return {
        head: fields[0],
        branch: fields[1] === 'HEAD' ? '' : fields[1].replace(/^refs\/heads\//, ''),
      }
    // Preserve unborn/broken-HEAD handling instead of treating a failed parse as empty.
    return { head: await this.head(repo, signal), branch: await this.currentBranch(repo, signal) }
  }

  async noInProgress(repo, signal, locations) {
    const names = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'sequencer',
      'rebase-merge',
      'rebase-apply',
    ]
    locations ||= await this.gitPaths(repo, names, signal)
    const missingLocations = names.filter((name) => !locations.has(name))
    if (missingLocations.length)
      locations = new Map([...locations, ...(await this.gitPaths(repo, missingLocations, signal))])
    for (const name of names) {
      const location = locations.get(name)
      if (
        await fs.stat(path.resolve(repo, location)).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      )
        throw new Error('仓库有未完成的合并、变基或拣选，请先通过 Git 完成或中止。')
    }
  }

  async indexFingerprint(repo, signal) {
    const index = (await this.git(repo, ['rev-parse', '--git-path', 'index'], { signal })).trim()
    const data = await fs.readFile(path.resolve(repo, index)).catch((error) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0)
      throw error
    })
    return createHash('sha256').update(data).digest('hex')
  }

  async syncPlan(repo, kind, expected, signal) {
    try {
      return await this.sync.plan(repo, kind, expected, signal)
    } catch (error) {
      throw new Error(this.safeError(error))
    }
  }

  async selectedCommitPlan(repo, request, signal) {
    return this.selectedCommit.plan(repo, request, signal)
  }

  async status(repo, signal) {
    return parseStatus(
      await this.git(
        repo,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
        { signal },
      ),
    )
  }

  async referenceState(repo, signal, locations) {
    const { head, branch } = await this.headContext(repo, signal)
    const rawRefs = await this.git(
      repo,
      [
        'for-each-ref',
        '--sort=refname',
        '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(*objectname)%00%(symref)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
        'refs/replace',
      ],
      { signal },
    )
    const lines = rawRefs.split(/\r?\n/).filter(Boolean)
    const replacements = lines
      .filter((line) => line.startsWith('refs/replace/'))
      .map((line) => line.split('\0').slice(0, 2).join('\0'))
      .join('\n')
    const graphBasis = await this.historyGraphBasis(repo, signal, locations, replacements)
    const branches = lines
      .filter((line) => !line.startsWith('refs/replace/'))
      .map((line) => {
        const fields = line.split('\0')
        if (fields.length !== 7) throw new Error('Git 引用输出不完整。')
        const [ref, hash, current, upstream, track, peeled, symbolicTarget] = fields
        const [prefix, kind] = ref.startsWith('refs/heads/')
          ? ['refs/heads/', 'local']
          : ref.startsWith('refs/remotes/')
            ? ['refs/remotes/', 'remote']
            : ['refs/tags/', 'tag']
        return {
          fullRef: ref,
          commitHash: peeled || hash,
          symbolicTarget,
          name: ref.slice(prefix.length),
          hash,
          current: current === '*',
          upstream,
          track,
          kind,
        }
      })
    const worktreeRaw = await this.git(repo, ['worktree', 'list', '--porcelain', '-z'], { signal })
    let worktreePath = ''
    for (const field of worktreeRaw.split('\0')) {
      if (field.startsWith('worktree ')) worktreePath = field.slice(9)
      if (field.startsWith('branch ')) {
        const local = branches.find((item) => item.fullRef === field.slice(7))
        if (local) local.worktreePath = worktreePath
      }
    }
    const referenceSignature = createHash('sha256')
      .update(JSON.stringify([head, branch, rawRefs, worktreeRaw, graphBasis]))
      .digest('hex')
    return { head, branch, branches, graphBasis, referenceSignature }
  }

  async refreshReferences(repo, signature, signal) {
    if (typeof signature !== 'string' || (signature && !/^[a-f0-9]{64}$/.test(signature)))
      throw new Error('无效的仓库引用版本。')
    const references = await this.referenceState(repo, signal)
    return references.referenceSignature === signature
      ? null
      : this.snapshot(repo, signal, references)
  }

  async snapshot(repo, signal, references) {
    const locations = await this.gitPaths(
      repo,
      [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
        'gitcode-rebase.json',
        'gitcode-flow-finish.json',
        'config',
        'config.worktree',
        'shallow',
        'info/grafts',
      ],
      signal,
    )
    const { head, branch, branches, graphBasis, referenceSignature } =
      references || (await this.referenceState(repo, signal, locations))
    const history = await this.history.initial(repo, branches, head, signal, graphBasis)
    const state = await this.status(repo, signal)
    const gitflow = await this.flow.state(repo, branches, signal, locations)
    const stash = await this.stash.list(repo, signal)
    const merge = await this.merge.state(repo, signal, locations)
    return {
      path: repo,
      referenceSignature,
      name: path.basename(repo) || 'repository',
      branch: branch || 'detached HEAD',
      head,
      commits: history.commits,
      history: history.history,
      remotes: (await this.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean),
      branches,
      ...state,
      total: history.total,
      gitflow,
      merge,
      stashes: stash.entries,
      stashSignature: stash.signature,
    }
  }

  async base(repo, sha, signal) {
    revision(sha)
    const parents = (await this.git(repo, ['rev-list', '--parents', '-n', '1', sha], { signal }))
      .trim()
      .split(/\s+/)
    return (
      parents[1] ||
      (await this.git(repo, ['hash-object', '-t', 'tree', '--stdin'], { signal })).trim()
    )
  }

  async commitDetails(repo, sha, signal) {
    const base = await this.base(repo, sha, signal)
    const parts = (
      await this.git(
        repo,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-status',
          '-z',
          base,
          sha,
          '--',
        ],
        { signal },
      )
    ).split('\0')
    const files = []
    for (let i = 0; i + 1 < parts.length; i += 2)
      files.push({ status: parts[i], path: parts[i + 1] })
    return {
      files,
      body: (await this.git(repo, ['show', '-s', '--format=%B', sha], { signal })).trimEnd(),
    }
  }

  async diff(repo, file, staged, commit, signal) {
    filePath(file)
    if (typeof staged !== 'boolean' && staged !== 'working') throw new Error('无效的暂存区参数。')
    if (commit && staged === 'working') throw new Error('历史提交不能使用工作区差异来源。')
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color']
    let state,
      paths = [file]
    if (!commit) {
      state = await this.status(repo, signal)
      const candidates =
        staged === 'working'
          ? [...state.staged, ...state.unstaged]
          : staged
            ? state.staged
            : state.unstaged
      const renamed = candidates.find((entry) => entry.path === file && entry.oldPath)
      if (renamed) paths = [renamed.oldPath, file]
      args.push('--find-renames')
    }
    if (commit) args.push(await this.base(repo, commit, signal), commit)
    else if (staged === 'working')
      args.push(
        (await this.head(repo, signal)) ||
          (
            await this.git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: '', signal })
          ).trim(),
      )
    else if (staged) args.push('--cached')
    let output = await this.git(repo, [...args, '--', ...paths], { signal })
    if (
      !commit &&
      (staged === 'working' || !staged) &&
      !output &&
      (state || (await this.status(repo, signal))).unstaged.some(
        (f) => f.path === file && f.status === '?',
      )
    ) {
      output = await this.git(
        repo,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-index',
          '--',
          process.platform === 'win32' ? 'NUL' : '/dev/null',
          file,
        ],
        { signal, allowedCodes: [0, 1] },
      )
    }
    const chars = Array.from(output)
    return { diff: chars.slice(0, MAX_DIFF).join(''), truncated: chars.length > MAX_DIFF }
  }

  async updateIndex(repo, paths, unstage, signal) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 5000)
      throw new Error('请选择要操作的文件。')
    paths.forEach(filePath)
    const state = await this.status(repo, signal),
      files = unstage ? state.staged : state.unstaged
    const allowed = new Set(files.map((file) => file.path))
    if (paths.some((file) => !allowed.has(file))) throw new Error('文件状态已变化，请刷新后重试。')
    const expanded = new Set(paths)
    files.forEach((file) => {
      if (paths.includes(file.path) && file.oldPath) expanded.add(file.oldPath)
    })
    // Literal pathspecs still recurse into directories. Git also cannot keep
    // both a file and its children in one index: require the complete selection
    // for a file/directory transition instead of silently changing extra files.
    for (const file of files) {
      if (expanded.has(file.path)) continue
      const related = [...expanded].find(
        (selected) => file.path.startsWith(selected + '/') || selected.startsWith(file.path + '/'),
      )
      if (related)
        throw new Error(
          `路径 ${related} 与 ${file.path} 存在文件/目录关联。请一并选择关联文件后${unstage ? '取消暂存' : '暂存'}，未修改暂存内容。`,
        )
    }
    const head = unstage && (await this.head(repo, signal))
    // Once every related change is explicitly selected, pass the parent once.
    // `restore --staged parent child` fails when child did not exist in HEAD.
    const operands = [...expanded].filter((file) => {
      const parts = file.split('/')
      return !parts
        .slice(0, -1)
        .some((_part, index) => expanded.has(parts.slice(0, index + 1).join('/')))
    })
    return this.git(
      repo,
      [
        ...(!unstage ? ['add'] : head ? ['restore', '--staged'] : ['rm', '--cached']),
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      { signal, input: operands.join('\0') + '\0' },
    )
  }

  async branchName(repo, value, signal) {
    const name = string(value, '分支名称')
    if (name.startsWith('-')) throw new Error('无效的分支名称。')
    await this.git(repo, ['check-ref-format', '--branch', name], { signal })
    return name
  }

  async checkContext(repo, request, signal) {
    if (request.expectedHead !== undefined) {
      if (request.expectedHead !== '') revision(request.expectedHead)
      const { head, branch } = await this.headContext(repo, signal)
      if (head !== request.expectedHead || (branch || 'detached HEAD') !== request.expectedBranch)
        throw new Error('当前分支或 HEAD 已变化，请刷新后重新操作。')
    }
  }

  async checkReference(repo, fullRef, expectedOid, signal) {
    string(fullRef, '分支引用')
    if (!/^refs\/(heads|remotes)\//.test(fullRef)) throw new Error('不支持的分支引用。')
    revision(expectedOid)
    await this.git(repo, ['check-ref-format', fullRef], { signal })
    const actual = (
      await this.git(repo, ['rev-parse', '--verify', '--quiet', fullRef], {
        allowedCodes: [0, 1],
        signal,
      })
    ).trim()
    if (actual !== expectedOid) throw new Error('目标分支已变化或不存在，请刷新后重新操作。')
  }

  async checkWorktree(repo, fullRef, deleting, signal) {
    const raw = await this.git(repo, ['worktree', 'list', '--porcelain', '-z'], { signal })
    let location = ''
    for (const field of raw.split('\0')) {
      if (field.startsWith('worktree ')) location = field.slice(9)
      if (
        field === `branch ${fullRef}` &&
        (deleting || !(await this.sameDirectory(location, repo)))
      ) {
        throw new Error('该分支正被工作区使用，请先在对应工作区切换分支。')
      }
    }
    if (deleting) {
      // Rebase and bisect can detach HEAD while still owning the original
      // branch. Native `git branch -d/-D` protects these worktrees too.
      const common = path.resolve(
        repo,
        (await this.git(repo, ['rev-parse', '--git-common-dir'], { signal })).trim(),
      )
      const linked = await fs
        .readdir(path.join(common, 'worktrees'), { withFileTypes: true })
        .catch((error) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
      for (const directory of [
        common,
        ...linked
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(common, 'worktrees', entry.name)),
      ]) {
        for (const name of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
          const state = await fs
            .readFile(path.join(directory, name), { encoding: 'utf8', signal })
            .catch((error) => {
              if (error.code === 'ENOENT') return ''
              throw error
            })
          if ([fullRef, fullRef.slice('refs/heads/'.length)].includes(state.trim()))
            throw Error('该分支正被工作区的变基或二分查找使用，请先结束对应操作。')
        }
      }
    }
  }

  async sameDirectory(left, right) {
    // Canonicalize symlinks and Windows 8.3 aliases before comparing worktrees.
    const paths = await Promise.all([fs.realpath(left), fs.realpath(right)])
    return process.platform === 'win32'
      ? paths[0].toLowerCase() === paths[1].toLowerCase()
      : paths[0] === paths[1]
  }

  automaticFetch(repo) {
    return autoFetch(this, repo)
  }

  async recordOperation(operation, repo, work, target = '') {
    const record = this.journal.start(operation, repo, { target })
    this.activeLog = record
    try {
      const result = await work()
      this.journal.finish(record, result)
      if (operation === 'fetch') this.journal.updateFetch(repo, result)
      return { ...result, logId: record.id }
    } catch (error) {
      this.journal.finish(record, {}, error)
      throw error
    } finally {
      this.activeLog = null
    }
  }

  async action(repo, request, signal) {
    return this.recordOperation(
      request?.action || 'git',
      repo,
      () => this.trackedAction(repo, request, signal),
      request?.name || request?.branch || request?.ref || request?.sourceRef || '',
    )
  }

  async trackedAction(repo, request, signal) {
    this.startActivity(request?.action || 'git', repo)
    const commitAction = ['commit', 'commit-selected'].includes(request?.action)
    // Commit refreshes index stat caches even when a hook rejects it. Compare
    // staged entries rather than the index file's bytes for commit outcomes.
    const indexState = async (readSignal) =>
      commitAction
        ? createHash('sha256')
            .update(
              await this.git(
                repo,
                [
                  'diff',
                  '--cached',
                  '--raw',
                  '-z',
                  '--no-abbrev',
                  '--no-renames',
                  '--no-ext-diff',
                  '--no-textconv',
                ],
                { signal: readSignal },
              ),
            )
            .digest('hex')
        : this.indexFingerprint(repo, readSignal)
    let result, failure, before
    try {
      if (request?.action && !['fetch', 'pull', 'push'].includes(request.action))
        before = {
          ...(await this.headContext(repo, signal)),
          index: await indexState(signal),
        }
      result = await this.performAction(repo, request, signal)
    } catch (error) {
      failure = error
      result = {
        output: '',
        outcome: signal?.aborted ? 'cancelled' : 'failed',
        error: this.safeError(error),
      }
    }
    const recovery = AbortSignal.timeout(20000)
    let snapshot = null,
      worktree = null
    if (this.activity) this.activity = { ...this.activity, phase: '刷新仓库状态', percent: null }
    try {
      if (
        !failure &&
        result.outcome === 'succeeded' &&
        request.refresh === 'worktree' &&
        ['stage', 'unstage'].includes(request.action)
      ) {
        let cleanOperation = false
        try {
          await this.noInProgress(repo, recovery)
          cleanOperation = true
        } catch {
          /* Full refresh retains conflict / interrupted-operation details. */
        }
        if (cleanOperation) {
          const state = await this.status(repo, recovery)
          const context = await this.headContext(repo, recovery)
          if (
            context.head === request.expectedHead &&
            (context.branch || 'detached HEAD') === request.expectedBranch
          )
            worktree = {
              path: repo,
              head: context.head,
              branch: context.branch || 'detached HEAD',
              ...state,
            }
        }
      }
      if (!worktree) snapshot = await this.snapshot(repo, recovery)
    } catch (error) {
      result.refreshError = this.safeError(error)
    }
    if (failure && before) {
      try {
        const afterHead = snapshot ? snapshot.head : await this.head(repo, recovery)
        if (
          afterHead !== before.head ||
          (snapshot
            ? snapshot.branch === 'detached HEAD'
              ? ''
              : snapshot.branch
            : await this.currentBranch(repo, recovery)) !== before.branch ||
          (await indexState(recovery)) !== before.index
        ) {
          result.outcome = 'partial'
          result.warning =
            request.action === 'commit'
              ? afterHead !== before.head
                ? '提交命令未正常结束，但 HEAD 已变化，仓库可能已产生新提交。请核对提交树，不要重复提交。'
                : '提交未生成，但分支或暂存内容已变化。请核对差异和暂存内容，不要直接重复提交。'
              : 'Git 操作未正常结束，但检测到 HEAD、分支或暂存区变化。结果待核实，请检查状态，不要重复执行。'
        }
      } catch {
        result.warning = 'Git 操作结果无法确认，请检查仓库状态，不要重复执行。'
      }
    }
    const hooks = this.activeLog?.commandDiagnostic?.hooks || []
    const presentation = presentCommandFailure(request?.action, result, hooks)
    if (presentation.error && result.error)
      result.details = [result.details, this.safeError(result.error)].filter(Boolean).join('\n')
    Object.assign(result, presentation)
    return {
      ...result,
      output: this.safeError(result.output || ''),
      snapshot,
      ...(worktree ? { worktree } : {}),
    }
  }

  async performAction(repo, request, signal) {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('无效的 Git 操作。')
    let output, warning
    if (
      ([
        'stage',
        'unstage',
        'stash-create',
        'stash-apply',
        'stash-pop',
        'stash-drop',
        'commit',
        'commit-selected',
        'branch',
        'checkout',
        'checkout-remote',
        'checkout-remote-confirm',
        'stash-checkout',
        'rename-branch',
        'set-upstream',
        'delete-branch',
      ].includes(request.action) ||
        (['create-branch', 'track-branch'].includes(request.action) && request.switchAfter)) &&
      (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
    )
      throw new Error('缺少仓库上下文，请刷新后重新操作。')
    await this.checkContext(repo, request, signal)
    if (['commit-operation', 'commit-sequence', 'checkout-revision'].includes(request.action)) {
      if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
        throw Error('缺少提交操作上下文。')
      return this.commitOperations.execute(repo, request, signal)
    }
    if (request.action === 'partial-stage') return this.partialStage.execute(repo, request, signal)
    if (['recovery-undo', 'recovery-restore'].includes(request.action)) {
      if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
        throw Error('缺少恢复操作上下文。')
      return this.recovery.execute(repo, request, signal)
    }
    if (
      ['rebase-start', 'rebase-continue', 'rebase-skip', 'rebase-abort'].includes(request.action)
    ) {
      if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
        throw new Error('缺少变基上下文，请刷新后重新操作。')
      if (await this.flowFinish.state(repo, signal))
        throw new Error('请先完成或停止 GitFlow 流程，再变基。')
      return this.rebase.execute(repo, request, signal)
    }
    if (['merge-resolve', 'merge-finish', 'merge-abort'].includes(request.action)) {
      if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
        throw new Error('缺少合并上下文，请刷新。')
      const result = await this.merge.execute(repo, request, signal)
      if (request.action === 'merge-finish' && result.outcome === 'succeeded') {
        const finish = await this.flowFinish.state(repo, signal)
        if (finish?.signature) {
          const next = await this.flowFinish.execute(
            repo,
            {
              action: 'gitflow-finish-continue',
              finishSignature: finish.signature,
              expectedHead: await this.head(repo, signal),
              expectedBranch: await this.currentBranch(repo, signal),
            },
            signal,
          )
          return { ...next, output: [result.output, next.output].filter(Boolean).join('\n') }
        }
      }
      return result
    }
    if (
      ['gitflow-finish', 'gitflow-finish-continue', 'gitflow-finish-stop'].includes(request.action)
    )
      return this.flowFinish.execute(repo, request, signal)
    if (await this.flowFinish.state(repo, signal))
      throw new Error('GitFlow 完成流程尚未结束，请先继续或停止后续步骤。')
    if (['gitflow-save', 'gitflow-init', 'gitflow-start'].includes(request.action))
      return this.flow.execute(repo, request, signal)
    if (
      request.action === 'stage' &&
      (await this.status(repo, signal)).unstaged.some(
        (file) => file.status === 'U' && request.paths?.includes(file.path),
      )
    )
      throw new Error('请通过冲突处理界面保存并标记解决。')
    if (
      [
        'stage',
        'unstage',
        'branch',
        'checkout',
        'checkout-remote',
        'checkout-remote-confirm',
        'create-branch',
        'track-branch',
        'rename-branch',
        'set-upstream',
        'delete-branch',
      ].includes(request.action)
    )
      await this.noInProgress(repo, signal)
    if (
      ['merge-branch', 'fast-forward', 'create-tag', 'delete-remote-branch'].includes(
        request.action,
      )
    )
      return this.navigation.execute(repo, request, signal)
    if (request.action === 'stash-checkout')
      return this.checkout.stashAndSwitch(repo, request, signal)
    if (request.action === 'checkout-remote') return this.checkout.remote(repo, request, signal)
    if (request.action === 'checkout-remote-confirm')
      return this.checkout.confirmRemote(repo, request, signal)
    if (['set-fetch-scope', 'unshallow'].includes(request.action))
      return this.fetchSettings.execute(repo, request, signal)
    if (['fetch', 'pull', 'push', 'pull-and-push'].includes(request.action))
      return this.sync.execute(repo, request, signal)
    if (['stash-create', 'stash-apply', 'stash-pop', 'stash-drop'].includes(request.action))
      return this.stash.execute(repo, request, signal)
    switch (request.action) {
      case 'stage':
      case 'unstage':
        output = await this.updateIndex(repo, request.paths, request.action === 'unstage', signal)
        break
      case 'commit-selected':
        return this.selectedCommit.execute(repo, request, signal)
      case 'commit': {
        await this.noInProgress(repo, signal)
        const message = string(request.message, '提交说明', { max: 20_000 }).trim()
        if (!message || !(await this.status(repo, signal)).staged.length)
          throw new Error('请填写说明，并先暂存需要提交的文件。')
        output = await this.git(repo, ['commit', '-m', message], {
          timeout: 300_000,
          signal,
          diagnose: true,
        })
        break
      }
      case 'branch':
      case 'checkout': {
        const name = string(request.name, '分支名称')
        if (name.startsWith('-')) throw new Error('无效的分支名称。')
        await this.git(repo, ['check-ref-format', '--branch', name], { signal })
        if (request.action === 'checkout')
          return this.checkout.switch(
            repo,
            {
              ...request,
              name,
              expectedOid:
                request.expectedOid ||
                (
                  await this.git(repo, ['rev-parse', '--verify', `refs/heads/${name}`], { signal })
                ).trim(),
            },
            signal,
          )
        output = await this.git(
          repo,
          [
            '-c',
            'submodule.recurse=false',
            'switch',
            '--no-overwrite-ignore',
            '--no-guess',
            ...(request.action === 'branch' ? ['-c'] : []),
            name,
            ...(request.action === 'branch' ? [request.expectedHead] : []),
          ],
          { signal },
        )
        break
      }
      case 'create-branch':
      case 'track-branch': {
        const name = await this.branchName(repo, request.name, signal)
        if (typeof request.switchAfter !== 'boolean') throw new Error('请选择是否切换分支。')
        if (request.action === 'track-branch') {
          if (typeof request.fullRef !== 'string' || !request.fullRef.startsWith('refs/remotes/'))
            throw new Error('请选择远程分支。')
          await this.checkReference(repo, request.fullRef, request.expectedOid, signal)
          output = await this.git(repo, ['branch', '--track', '--', name, request.fullRef], {
            signal,
          })
        } else {
          const start = revision(request.startOid)
          const commit = (
            await this.git(repo, ['rev-parse', '--verify', `${start}^{commit}`], { signal })
          ).trim()
          output = await this.git(repo, ['branch', '--no-track', '--', name, commit], { signal })
        }
        if (request.switchAfter) {
          try {
            output += await this.git(
              repo,
              [
                '-c',
                'submodule.recurse=false',
                'switch',
                '--no-overwrite-ignore',
                '--no-guess',
                name,
              ],
              { signal },
            )
          } catch (error) {
            warning = `分支 ${name} 已创建，但切换失败：${error.message}。请刷新确认当前分支，不要重复创建。`
          }
        }
        break
      }
      case 'set-upstream': {
        const name = await this.branchName(repo, request.name, signal)
        await this.checkReference(repo, `refs/heads/${name}`, request.expectedOid, signal)
        if (typeof request.fullRef !== 'string' || !request.fullRef.startsWith('refs/remotes/'))
          throw new Error('请选择明确的远程上游分支。')
        await this.checkReference(repo, request.fullRef, request.upstreamOid, signal)
        const symbolic = (
          await this.git(repo, ['symbolic-ref', '-q', request.fullRef], {
            signal,
            allowedCodes: [0, 1],
          })
        ).trim()
        if (symbolic) throw new Error('不能将远程符号引用设为上游。')
        output = await this.git(
          repo,
          ['branch', `--set-upstream-to=${request.fullRef}`, '--', name],
          { signal },
        )
        break
      }
      case 'rename-branch':
      case 'delete-branch': {
        const name = await this.branchName(repo, request.name, signal)
        const fullRef = `refs/heads/${name}`
        await this.checkReference(repo, fullRef, request.expectedOid, signal)
        await this.checkWorktree(repo, fullRef, request.action === 'delete-branch', signal)
        if (request.action === 'rename-branch') {
          const newName = await this.branchName(repo, request.newName, signal)
          output = await this.git(repo, ['branch', '-m', '--', name, newName], { signal })
        } else {
          if (request.force !== undefined && typeof request.force !== 'boolean')
            throw new Error('无效的强制删除选项。')
          return this.recovery.deleteBranch(repo, { ...request, name }, signal)
        }
        break
      }
      default:
        throw new Error('不支持的 Git 操作。')
    }
    return { output, outcome: warning ? 'partial' : 'succeeded', ...(warning ? { warning } : {}) }
  }

  async create(request, signal) {
    return this.recordOperation(
      request?.kind === 'clone' ? 'clone' : 'init',
      request?.path || '',
      () => this.trackedCreate(request, signal),
    )
  }

  async trackedCreate(request, signal) {
    this.startActivity(
      request?.kind === 'clone' ? 'clone' : 'init',
      typeof request?.path === 'string' ? request.path : '',
    )
    if (!request || !['clone', 'init'].includes(request.kind))
      throw new Error('请选择创建或克隆仓库。')
    const requested = absolutePath(request.path)
    try {
      await fs.lstat(requested)
      throw new Error('目标目录已存在，请选择尚未创建的新目录。')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = await fs.realpath(path.dirname(requested))
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('父目录不是目录。')
    const target = path.join(parent, path.basename(requested)),
      url = typeof request.url === 'string' ? request.url.trim() : ''
    if (request.kind === 'clone' && !validRemote(url))
      throw new Error('请使用 HTTPS、SSH 地址或本地仓库绝对路径。')
    await this.discover()
    if (!this.gitPath) throw new Error((await this.runtime()).gitError)
    if (signal?.aborted) throw new Error(CANCELLED)
    await fs.mkdir(target) // Exclusive, never reinitialize an existing directory.
    try {
      if (request.kind === 'init')
        await this.git(target, ['init', '--initial-branch=main', '--', target], {
          signal,
          creatingRepository: true,
        })
      else
        await this.git(
          target,
          [
            '-c',
            'protocol.ext.allow=never',
            'clone',
            '--progress',
            '--no-recurse-submodules',
            '--no-local',
            '--',
            url,
            target,
          ],
          { timeout: 300_000, signal, locale: 'C', creatingRepository: true },
        )
    } catch (error) {
      throw new Error(
        `${this.safeError(error)}\n目标目录 ${target} 可能留有部分内容；请检查，不会自动删除或覆盖。`,
      )
    }
    if (this.runtimeOptions.enforceRepositoryTrust)
      return { snapshot: null, path: target, requiresTrust: true }
    if (this.activity) this.activity = { ...this.activity, phase: '读取新仓库状态', percent: null }
    try {
      return {
        snapshot: await this.snapshot(
          await this.repository(target, AbortSignal.timeout(20000)),
          AbortSignal.timeout(20000),
        ),
        path: target,
      }
    } catch (error) {
      return {
        snapshot: null,
        path: target,
        warning: `仓库目录已创建，但读取失败：${this.safeError(error)}。请打开该目录检查，不要重复创建。`,
      }
    }
  }

  async listDirectory(value) {
    let requested = value ? absolutePath(value) : this.lastDirectory || os.homedir()
    if (!value && !(await fs.stat(requested).catch(() => null))?.isDirectory())
      requested = os.homedir()
    const current = await fs.realpath(requested)
    if (!(await fs.stat(current)).isDirectory()) throw new Error('请选择目录。')
    const entries = await fs.readdir(current, { withFileTypes: true }),
      folders = []
    let truncated = false
    // Batches avoid flooding the filesystem pool on large repositories.
    for (let i = 0; i < entries.length; i += 32) {
      const batch = await Promise.all(
        entries.slice(i, i + 32).map(async (entry) => {
          if (entry.name === '.git') return null
          const target = path.join(current, entry.name)
          try {
            if (
              !entry.isDirectory() &&
              !(entry.isSymbolicLink() && (await fs.stat(target)).isDirectory())
            )
              return null
            const marker = await fs.stat(path.join(target, '.git')).catch(() => null)
            return {
              name: entry.name,
              path: target,
              isGit: !!marker && (marker.isDirectory() || marker.isFile()),
              hidden: entry.name.startsWith('.'),
              symlink: entry.isSymbolicLink(),
            }
          } catch {
            return null
          }
        }),
      )
      folders.push(...batch.filter(Boolean))
      if (folders.length >= 2000) {
        folders.length = 2000
        truncated = true
        break
      }
    }
    folders.sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }),
    )
    const parent = path.dirname(current),
      root = path.parse(current).root
    this.lastDirectory = current
    return {
      path: current,
      parent: parent === current ? null : parent,
      home: os.homedir(),
      root,
      folders,
      truncated,
    }
  }
}

module.exports = {
  GitService,
  execute,
  parseStatus,
  absolutePath,
  filePath,
  revision,
  validRemote,
  MAX_DIFF,
}
