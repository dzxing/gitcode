'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { TextDecoder } = require('node:util')
const { createHash } = require('node:crypto')
const { SyncOperations } = require('./sync.cjs')
const { GitFlowOperations } = require('./gitflow.cjs')
const { SelectedCommitOperations } = require('./selected-commit.cjs')
const { StashOperations } = require('./stash.cjs')
const { NavigationOperations } = require('./navigation.cjs')
const { MergeOperations } = require('./merge.cjs')
const { RebaseOperations } = require('./rebase.cjs')
const { CheckoutOperations } = require('./checkout.cjs')
const { GitFlowFinishOperations } = require('./gitflow-finish.cjs')
const { AutoStashOperations } = require('./auto-stash.cjs')

const MAX_OUTPUT = 32 * 1024 * 1024
const MAX_DIFF = 300_000
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
      throw new Error('Windows 版本暂不支持 WSL 仓库，请选择 Windows 本地仓库。')
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
      } catch {}
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }
}

// No shell is involved. Output is drained asynchronously; cancellation kills
// Git's process group/tree so SSH and hooks cannot retain the output pipes.
function execute(
  executable,
  args,
  { cwd, timeout = 30_000, signal, env = process.env, input } = {},
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
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    let outBytes = 0,
      errBytes = 0,
      failure = null
    function stop(message) {
      if (failure) return
      failure = new Error(message)
      killTree(child)
    }
    const onAbort = () => stop(CANCELLED)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(
      () => stop('Git 操作超时，请检查认证或连接，并刷新仓库确认状态。'),
      timeout,
    )
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes <= MAX_OUTPUT) stdout.push(chunk)
      else stop('Git 输出超过 32 MiB，请缩小操作范围。')
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      if (errBytes <= MAX_OUTPUT) stderr.push(chunk)
      else stop('Git 错误输出超过 32 MiB。')
    })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    child.once('error', (error) => {
      cleanup()
      reject(new Error(`无法启动 Git：${error.message}`))
    })
    child.once('close', (code, termination) => {
      cleanup()
      if (failure) return reject(failure)
      let out
      try {
        out = decoder.decode(Buffer.concat(stdout))
      } catch {
        return reject(new Error('仓库包含无法用 UTF-8 表示的内容或路径，当前版本无法安全处理。'))
      }
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
  constructor() {
    this.gitPath = null
    this.gitVersion = ''
    this.discovery = null
    this.tail = Promise.resolve()
    this.current = null
    this.generation = 0
    this.closing = false
    this.lastDirectory = null
    this.sync = new SyncOperations(this, validRemote)
    this.flow = new GitFlowOperations(this)
    this.selectedCommit = new SelectedCommitOperations(this, { filePath, string })
    this.stash = new StashOperations(this, { filePath, string })
    this.autoStash = new AutoStashOperations(this)
    this.merge = new MergeOperations(this, { filePath, string })
    this.rebase = new RebaseOperations(this)
    this.flowFinish = new GitFlowFinishOperations(this)
    this.checkout = new CheckoutOperations(this)
    this.navigation = new NavigationOperations(this, { string, revision, filePath, validRemote })
  }

  async discover() {
    if (this.discovery) return this.discovery
    this.discovery = (async () => {
      const candidates =
        process.env.GITCODE_GIT_PATH || process.env.GITK_GIT_PATH
          ? [process.env.GITCODE_GIT_PATH || process.env.GITK_GIT_PATH]
          : [process.platform === 'win32' ? 'git.exe' : 'git']
      if (
        !(process.env.GITCODE_GIT_PATH || process.env.GITK_GIT_PATH) &&
        process.platform === 'win32'
      ) {
        for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'])
          if (process.env[key]) {
            candidates.push(
              path.join(process.env[key], 'Git', 'cmd', 'git.exe'),
              path.join(process.env[key], 'Programs', 'Git', 'cmd', 'git.exe'),
            )
          }
      }
      if (
        !(process.env.GITCODE_GIT_PATH || process.env.GITK_GIT_PATH) &&
        process.platform === 'darwin'
      )
        candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git')
      for (const executable of candidates) {
        try {
          const result = await execute(executable, ['--version'], { timeout: 3000 })
          if (
            result.code === 0 &&
            /^git version /.test(result.stdout) &&
            (() => {
              const match = result.stdout.match(/git version (\d+)\.(\d+)/)
              return (
                match &&
                (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 46))
              )
            })()
          ) {
            this.gitPath = executable
            this.gitVersion = result.stdout.trim()
            break
          }
        } catch {
          /* Try the next known installation. */
        }
      }
    })()
    return this.discovery
  }

  async runtime() {
    await this.discover()
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
      gitError: this.gitPath
        ? ''
        : '未找到 Git 2.46 或更高版本。请升级 Git 后重新启动 GitCode，或设置 GITCODE_GIT_PATH 为 Git 可执行文件路径。',
    }
  }

  // Capturing an epoch at enqueue time cancels both active and previously
  // queued operations. Requests made after cancellation may run normally.
  job(work) {
    const queuedAt = this.generation
    const pending = this.tail.then(async () => {
      if (this.closing || queuedAt !== this.generation) throw new Error(CANCELLED)
      const controller = new AbortController()
      this.current = controller
      try {
        return await work(controller.signal)
      } finally {
        if (this.current === controller) this.current = null
      }
    })
    this.tail = pending.catch(() => {})
    return pending
  }

  cancel() {
    this.generation++
    this.current?.abort()
  }
  async shutdown() {
    this.closing = true
    this.cancel()
    await this.tail
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
      indexFile,
      hooksPath,
      locale,
      rebasePlan,
    } = {},
  ) {
    await this.discover()
    if (!this.gitPath) throw new Error((await this.runtime()).gitError)
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    }
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ])
      delete env[key]
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key]
    if (locale) env.LC_ALL = locale
    if (indexFile) env.GIT_INDEX_FILE = indexFile
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
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    const result = await execute(
      this.gitPath,
      [
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
        ...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []),
        ...args,
      ],
      { cwd: repo, timeout, signal, env, input },
    )
    if (!allowedCodes.includes(result.code)) {
      if (optional && result.code === 1) return ''
      throw new Error(
        this.safeError(result.stderr.trim() || result.stdout.trim() || 'Git 操作失败。'),
      )
    }
    return result.stdout
  }

  async repository(value, signal) {
    const candidate = absolutePath(value)
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error('请选择本机仓库目录。')
    if (
      (await this.git(candidate, ['rev-parse', '--is-bare-repository'], { signal })).trim() ===
      'true'
    )
      throw new Error('暂不支持裸仓库，请打开带工作区的仓库。')
    const root = await this.git(candidate, ['rev-parse', '--show-toplevel'], { signal })
    return fs.realpath(root.replace(/[\r\n]+$/, ''))
  }

  safeError(error) {
    return String(error?.message || error)
      .replace(/(https?:\/\/)[^\s/@]+@/g, '$1…@')
      .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1')
  }

  async currentBranch(repo, signal) {
    return (
      await this.git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], {
        allowedCodes: [0, 1],
        signal,
      })
    ).trim()
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

  async noInProgress(repo, signal) {
    for (const name of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      const location = (await this.git(repo, ['rev-parse', '--git-path', name], { signal })).trim()
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
      await this.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal }),
    )
  }

  async snapshot(repo, signal) {
    const head = await this.head(repo, signal)
    const branch = await this.currentBranch(repo, signal)
    const rawRefs = await this.git(
      repo,
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(*objectname)%00%(symref)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      { signal },
    )
    const branches = rawRefs
      .split(/\r?\n/)
      .filter(Boolean)
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
    const commits = []
    if (head || branches.length) {
      const fields = (
        await this.git(
          repo,
          [
            'log',
            '--exclude=refs/gitcode/*',
            '--exclude=refs/gitk/*',
            '--exclude=refs/stash',
            '--all',
            ...(head ? ['HEAD'] : []),
            '--date-order',
            '-n',
            '250',
            '-z',
            '--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D',
          ],
          { signal },
        )
      ).split('\0')
      for (let i = 0; i + 6 < fields.length; i += 7) {
        const [hash, parents, subject, author, email, date, refs] = fields.slice(i, i + 7)
        commits.push({
          hash,
          parents: parents.split(' ').filter(Boolean),
          subject,
          author,
          email,
          date,
          refs: branches
            .filter((b) => b.commitHash === hash)
            .map((b) =>
              b.kind === 'tag'
                ? `tag: ${b.name}`
                : b.current && hash === head
                  ? `HEAD -> ${b.name}`
                  : b.name,
            ),
        })
      }
    }
    const state = await this.status(repo, signal)
    const total = Number(
      (
        await this.git(
          repo,
          [
            'rev-list',
            '--exclude=refs/gitcode/*',
            '--exclude=refs/gitk/*',
            '--exclude=refs/stash',
            '--all',
            ...(head ? ['HEAD'] : []),
            '--count',
          ],
          { signal },
        )
      ).trim(),
    )
    const gitflow = await this.flow.state(repo, branches, signal)
    const stash = await this.stash.list(repo, signal)
    const merge = await this.merge.state(repo, signal)
    return {
      path: repo,
      name: path.basename(repo) || 'repository',
      branch: branch || 'detached HEAD',
      head,
      commits,
      remotes: (await this.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean),
      branches,
      ...state,
      total,
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
    if (staged === 'working') {
      state = await this.status(repo, signal)
      const renamed = [...state.staged, ...state.unstaged].find(
        (entry) => entry.path === file && entry.oldPath,
      )
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
    const head = unstage && (await this.head(repo, signal))
    return this.git(
      repo,
      [
        ...(!unstage ? ['add'] : head ? ['restore', '--staged'] : ['rm', '--cached']),
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      { signal, input: [...expanded].join('\0') + '\0' },
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
      const head = await this.head(repo, signal)
      const branch = await this.currentBranch(repo, signal)
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
  }

  async sameDirectory(left, right) {
    // Canonicalize symlinks and Windows 8.3 aliases before comparing worktrees.
    const paths = await Promise.all([fs.realpath(left), fs.realpath(right)])
    return process.platform === 'win32'
      ? paths[0].toLowerCase() === paths[1].toLowerCase()
      : paths[0] === paths[1]
  }

  async action(repo, request, signal) {
    let result, failure, before
    try {
      if (request?.action && !['fetch', 'pull', 'push'].includes(request.action))
        before = {
          head: await this.head(repo, signal),
          branch: await this.currentBranch(repo, signal),
          index: await this.indexFingerprint(repo, signal),
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
    let snapshot = null
    try {
      snapshot = await this.snapshot(repo, recovery)
    } catch (error) {
      result.refreshError = this.safeError(error)
    }
    if (failure && before) {
      try {
        if (
          (snapshot ? snapshot.head : await this.head(repo, recovery)) !== before.head ||
          (snapshot
            ? snapshot.branch === 'detached HEAD'
              ? ''
              : snapshot.branch
            : await this.currentBranch(repo, recovery)) !== before.branch ||
          (await this.indexFingerprint(repo, recovery)) !== before.index
        ) {
          result.outcome = 'partial'
          result.warning = `${request.action === 'commit' ? '提交命令' : 'Git 操作'}未正常结束，但检测到 HEAD、分支或暂存区变化。结果待核实，请检查状态，不要重复执行。`
        }
      } catch {
        result.warning = 'Git 操作结果无法确认，请检查仓库状态，不要重复执行。'
      }
    }
    return { ...result, output: this.safeError(result.output || ''), snapshot }
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
    if (['fetch', 'pull', 'push'].includes(request.action))
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
        output = await this.git(repo, ['commit', '-m', message], { timeout: 300_000, signal })
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
          try {
            output = await this.git(
              repo,
              ['branch', request.force === true ? '-D' : '-d', '--', name],
              { signal, locale: 'C' },
            )
          } catch (error) {
            if (!request.force && !signal?.aborted && /not fully merged/i.test(error.message))
              return {
                output: '',
                outcome: 'failed',
                branchDeleteBlocked: 'unmerged',
                error:
                  '该分支未通过 Git 的合并检查。请确认是否删除未合并分支，再以强制删除方式重试。',
                details: this.safeError(error),
              }
            throw error
          }
        }
        break
      }
      default:
        throw new Error('不支持的 Git 操作。')
    }
    return { output, outcome: warning ? 'partial' : 'succeeded', ...(warning ? { warning } : {}) }
  }

  async create(request, signal) {
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
        await this.git(parent, ['init', '--initial-branch=main', '--', target], { signal })
      else
        await this.git(
          parent,
          [
            '-c',
            'protocol.ext.allow=never',
            'clone',
            '--no-recurse-submodules',
            '--no-local',
            '--',
            url,
            target,
          ],
          { timeout: 300_000, signal },
        )
    } catch (error) {
      throw new Error(
        `${this.safeError(error)}\n目标目录 ${target} 可能留有部分内容；请检查，不会自动删除或覆盖。`,
      )
    }
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
