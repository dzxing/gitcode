'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const lifetime = 5 * 60_000
const digest = (value) => createHash('sha256').update(value).digest('hex')
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const missing = (error) => {
  if (error.code === 'ENOENT') return null
  throw error
}

class SelectedCommitOperations {
  constructor(git, validators) {
    this.git = git
    this.validators = validators
    this.plans = new Map()
  }

  async supported(repo, signal) {
    await this.git.discover()
    const version = this.git.gitVersion.match(/git version (\d+)\.(\d+)/)
    if (
      !this.git.gitPath ||
      !version ||
      Number(version[1]) < 2 ||
      (Number(version[1]) === 2 && Number(version[2]) < 46)
    )
      throw new Error('勾选提交需要 Git 2.46 或更高版本，请升级 Git 后重试。')
    // New Git versions may run configured hooks in addition to file hooks.
    // Forwarding them through our wrapper could run them twice, so defer this
    // configuration to the explicit native staging workflow until supported.
    const configuredHooks = await this.git.git(
      repo,
      ['config', '--null', '--get-regexp', '^hook\\..*\\.(event|command)$'],
      { signal, allowedCodes: [0, 1] },
    )
    if (
      configuredHooks.split('\0').some((record) => {
        const separator = record.indexOf('\n')
        return separator >= 0 && record.slice(separator + 1).trim() !== ''
      })
    )
      throw new Error('当前仓库使用配置式 hooks，勾选提交暂不支持，请使用暂存模式。')
    await this.git.noInProgress(repo, signal)
    for (const key of ['core.sparseCheckout', 'core.splitIndex']) {
      if (
        (
          await this.git.git(repo, ['config', '--bool', '--get', key], {
            signal,
            allowedCodes: [0, 1],
          })
        ).trim() === 'true'
      )
        throw new Error('当前稀疏或拆分暂存区暂不支持勾选提交，请使用暂存模式。')
    }
    const shared = (
      await this.git.git(repo, ['rev-parse', '--shared-index-path'], { signal })
    ).trim()
    if (shared) throw new Error('当前拆分暂存区暂不支持勾选提交，请使用暂存模式。')
    const indexPath = path.resolve(
      repo,
      (await this.git.git(repo, ['rev-parse', '--git-path', 'index'], { signal })).trim(),
    )
    const stat = await fs.lstat(indexPath).catch(missing)
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error('暂存区文件类型异常，不能安全进行勾选提交。')
    return indexPath
  }

  async fingerprint(repo, paths, signal) {
    const hash = createHash('sha256')
    for (const file of paths) {
      if (signal?.aborted) throw new Error('操作已取消，请重新复核提交。')
      const absolute = path.join(repo, file)
      // Parent symlinks would allow a Git path to address content outside the root.
      let parent = path.dirname(absolute)
      while (parent !== repo && parent.startsWith(repo + path.sep)) {
        if ((await fs.lstat(parent).catch(missing))?.isSymbolicLink())
          throw new Error('所选路径位于符号链接目录中，请先通过 Git 检查。')
        parent = path.dirname(parent)
      }
      const stat = await fs.lstat(absolute).catch(missing)
      hash.update(file).update('\0')
      if (!stat) {
        hash.update('missing\0')
        continue
      }
      if (stat.isSymbolicLink()) hash.update(`link\0${await fs.readlink(absolute)}\0`)
      else if (stat.isFile()) {
        if (stat.size > 64 * 1024 * 1024)
          throw new Error('所选文件超过 64 MiB，请使用暂存模式处理。')
        hash
          .update(`file\0${stat.mode & 0o111}\0`)
          .update(await fs.readFile(absolute, { signal }))
          .update('\0')
      } else throw new Error('所选项目包含目录或子模块，请使用暂存模式处理。')
    }
    return hash.digest('hex')
  }

  async capture(repo, paths, signal) {
    const state = await this.git.status(repo, signal)
    if ([...state.staged, ...state.unstaged].some((f) => f.status === 'U'))
      throw new Error('请先解决全部合并冲突。')
    const files = paths.map((file) => {
      const staged = state.staged.find((f) => f.path === file)
      const unstaged = state.unstaged.find((f) => f.path === file)
      if (!staged && !unstaged) throw new Error('所选文件状态已变化，请刷新后重新选择。')
      const value = unstaged || staged
      return {
        path: file,
        ...(value.oldPath || staged?.oldPath ? { oldPath: value.oldPath || staged.oldPath } : {}),
        status: value.status,
        partialStaged: !!staged && !!unstaged,
      }
    })
    const expanded = [
      ...new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))),
    ].sort()
    expanded.forEach(this.validators.filePath)
    return {
      files,
      expanded,
      status: digest(JSON.stringify(state)),
      content: await this.fingerprint(repo, expanded, signal),
      index: await this.git.indexFingerprint(repo, signal),
    }
  }

  async preparedTree(repo, head, expanded, temporary, signal) {
    const indexFile = path.join(temporary, 'index'),
      hooksPath = path.join(temporary, 'empty-hooks')
    await fs.mkdir(hooksPath, { recursive: true })
    const options = { indexFile, hooksPath, signal }
    await this.git.git(repo, ['read-tree', ...(head ? [head] : ['--empty'])], options)
    await this.git.git(repo, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...options,
      input: expanded.join('\0') + '\0',
    })
    return {
      tree: (await this.git.git(repo, ['write-tree'], options)).trim(),
      indexFile,
      hooksPath,
    }
  }

  async plan(repo, request, signal) {
    if (
      !request ||
      typeof request.expectedHead !== 'string' ||
      typeof request.expectedBranch !== 'string'
    )
      throw new Error('缺少仓库上下文，请刷新后重新选择。')
    if (
      !Array.isArray(request.paths) ||
      !request.paths.length ||
      request.paths.length > 2000 ||
      request.paths.some((p) => typeof p !== 'string') ||
      request.paths.join('\0').length > 250_000
    )
      throw new Error('请选择 1 至 2000 个文件。')
    const paths = [...new Set(request.paths)].sort()
    paths.forEach(this.validators.filePath)
    await this.git.checkContext(repo, request, signal)
    await this.supported(repo, signal)
    const original = await this.capture(repo, paths, signal)
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-commit-plan-'))
    try {
      const { tree } = await this.preparedTree(
        repo,
        request.expectedHead,
        original.expanded,
        temporary,
        signal,
      )
      const headTree = request.expectedHead
        ? (
            await this.git.git(repo, ['rev-parse', `${request.expectedHead}^{tree}`], { signal })
          ).trim()
        : (
            await this.git.git(repo, ['hash-object', '-t', 'tree', '--stdin'], {
              signal,
              input: '',
            })
          ).trim()
      if (tree === headTree) throw new Error('所选文件相对于 HEAD 没有可提交的更改。')
      await this.git.checkContext(repo, request, signal)
      const after = await this.capture(repo, paths, signal)
      if (
        after.content !== original.content ||
        after.index !== original.index ||
        after.status !== original.status
      )
        throw new Error('复核期间文件或暂存区发生变化，请重试。')
      const now = Date.now()
      for (const [id, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(id)
      while (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value)
      const plan = {
        id: randomUUID(),
        repo,
        expectedHead: request.expectedHead,
        expectedBranch: request.expectedBranch,
        paths,
        ...original,
        tree,
        expiresAt: now + lifetime,
      }
      this.plans.set(plan.id, plan)
      return {
        id: plan.id,
        expiresAt: plan.expiresAt,
        paths,
        files: original.files,
        partialPaths: original.files.filter((f) => f.partialStaged).map((f) => f.path),
        scope: 'working-tree',
        selectedCount: paths.length,
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  async hooks(repo, temporary, plan, signal) {
    const original = path.resolve(
      repo,
      (await this.git.git(repo, ['rev-parse', '--git-path', 'hooks'], { signal })).trim(),
    )
    const hooks = path.join(temporary, 'commit-hooks')
    await fs.mkdir(hooks)
    const names = new Set([
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'post-rewrite',
      'post-index-change',
      'reference-transaction',
      'pre-auto-gc',
    ])
    for (const name of await fs
      .readdir(original)
      .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error))))
      if (/^[\w.-]+$/.test(name) && !name.endsWith('.sample')) names.add(name)
    const git = quote(this.git.gitPath)
    for (const name of names) {
      const run = `${git} -c ${quote(`core.hooksPath=${original}`)} hook run --ignore-missing --to-stdin="$input" ${quote(name)} -- "$@"`
      // git hook run closes stdin unless --to-stdin is supplied. Preserve the
      // native hook input explicitly rather than relying on shell redirection.
      let script = `#!/bin/sh\ninput=${quote(path.join(temporary, `${name}-input`))}-$$\ncat > "$input" || exit 1\n${run}\nresult=$?\nrm -f "$input"\nexit "$result"\n`
      if (name === 'reference-transaction') {
        const ref =
          plan.expectedBranch === 'detached HEAD' ? 'HEAD' : `refs/heads/${plan.expectedBranch}`
        const old = plan.expectedHead || '0'.repeat(plan.tree.length)
        script = `#!/bin/sh
input=${quote(path.join(temporary, 'reference-input'))}-$$
cat > "$input" || exit 1
${run}
result=$?
if [ "$result" -ne 0 ]; then
  rm -f "$input"
  exit "$result"
fi
if [ "$1" = prepared ]; then
  while read -r old new ref; do
    if [ "$ref" = ${quote(ref)} ] || [ "$ref" = HEAD ]; then
      tree=$(${git} rev-parse "$new^{tree}") || exit 1
      index_tree=$(${git} write-tree) || exit 1
      parents=$(${git} show -s --format=%P "$new") || exit 1
      if [ "$old" != ${quote(old)} ] || [ "$tree" != ${quote(plan.tree)} ] || [ "$index_tree" != ${quote(plan.tree)} ] || [ "$parents" != ${quote(plan.expectedHead)} ]; then
        echo 'GitCode: hooks changed the reviewed commit content or HEAD; please review again.' >&2
        rm -f "$input"
        exit 1
      fi
    fi
  done < "$input"
fi
rm -f "$input"
exit 0
`
      }
      await fs.writeFile(path.join(hooks, name), script, { mode: 0o700 })
    }
    return hooks
  }

  async reconcile(repo, plan, indexPath, original, temporary, lock, newHead, signal) {
    if ((await this.git.indexFingerprint(repo, signal)) !== plan.index)
      throw new Error('提交已完成，但真实暂存区被外部修改，未覆盖其内容，请检查状态。')
    const nextIndex = path.join(temporary, 'reconciled-index')
    const options = { indexFile: nextIndex, hooksPath: path.join(temporary, 'empty-hooks'), signal }
    if (original.length) await fs.writeFile(nextIndex, original)
    else await this.git.git(repo, ['read-tree', '--empty'], options)
    await this.git.git(
      repo,
      ['reset', '--quiet', newHead, '--pathspec-from-file=-', '--pathspec-file-nul'],
      { ...options, input: plan.expanded.join('\0') + '\0' },
    )
    await this.git.checkContext(
      repo,
      { expectedHead: newHead, expectedBranch: plan.expectedBranch },
      signal,
    )
    if ((await this.git.indexFingerprint(repo, signal)) !== plan.index)
      throw new Error('提交已完成，但暂存区被外部修改，未覆盖其内容。')
    const held = await lock.stat(),
      current = await fs.stat(indexPath + '.lock')
    if (held.ino !== current.ino || held.dev !== current.dev)
      throw new Error('暂存区锁已变化，请检查提交结果。')
    await lock.writeFile(await fs.readFile(nextIndex))
    await lock.sync()
    await lock.close()
    await fs.rename(indexPath + '.lock', indexPath)
  }

  async execute(repo, request, signal) {
    const plan = this.plans.get(request.planId)
    if (!plan || plan.repo !== repo || plan.expiresAt <= Date.now())
      throw new Error('提交复核已过期或不存在，请重新复核。')
    if (plan.files.some((f) => f.partialStaged) && request.confirmPartial !== true)
      throw new Error('所选文件包含部分暂存内容，请明确确认提交完整工作区版本。')
    const message = this.validators.string(request.message, '提交说明', { max: 20_000 }).trim()
    if (!message) throw new Error('请填写提交说明。')
    if (
      request.expectedHead !== plan.expectedHead ||
      request.expectedBranch !== plan.expectedBranch
    )
      throw new Error('提交上下文与复核计划不一致。')
    this.plans.delete(plan.id)
    await this.git.checkContext(repo, plan, signal)
    const indexPath = await this.supported(repo, signal)
    let lock
    try {
      lock = await fs.open(indexPath + '.lock', 'wx', 0o600)
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('暂存区正在被其他 Git 操作使用，请稍后重试。')
      throw error
    }
    let temporary,
      lockIdentity,
      released = false,
      published = false,
      keepTemporary = false
    try {
      lockIdentity = await lock.stat()
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-commit-'))
      const original = await fs
        .readFile(indexPath)
        .catch((error) => (error.code === 'ENOENT' ? Buffer.alloc(0) : Promise.reject(error)))
      const indexStat = await fs.stat(indexPath).catch(missing)
      if (indexStat) await lock.chmod(indexStat.mode & 0o777)
      const now = await this.capture(repo, plan.paths, signal)
      if (now.index !== plan.index || now.content !== plan.content || now.status !== plan.status)
        throw new Error('复核后文件或暂存区已变化，请重新复核提交。')
      const prepared = await this.preparedTree(
        repo,
        plan.expectedHead,
        plan.expanded,
        temporary,
        signal,
      )
      if (prepared.tree !== plan.tree) throw new Error('所选文件转换后的内容已变化，请重新复核。')
      const hooksPath = await this.hooks(repo, temporary, plan, signal)
      await this.git.checkContext(repo, plan, signal)
      let output = '',
        failure
      try {
        output = await this.git.git(repo, ['commit', '-m', message], {
          indexFile: prepared.indexFile,
          hooksPath,
          signal,
          timeout: 300_000,
        })
      } catch (error) {
        failure = error
      }
      const recovery = AbortSignal.timeout(20_000)
      const newHead = await this.git.head(repo, recovery)
      if (newHead === plan.expectedHead) {
        if (failure) throw failure
        throw new Error('提交未产生新的 HEAD，请刷新检查。')
      }
      published = true
      const actualTree = (
        await this.git.git(repo, ['rev-parse', `${newHead}^{tree}`], { signal: recovery })
      ).trim()
      const parents = (
        await this.git.git(repo, ['show', '-s', '--format=%P', newHead], { signal: recovery })
      ).trim()
      if (actualTree !== plan.tree || parents !== plan.expectedHead)
        throw new Error('HEAD 已变化且提交内容与复核不一致，原暂存区保留，请检查，不要重复提交。')
      await this.reconcile(repo, plan, indexPath, original, temporary, lock, newHead, recovery)
      released = true
      const finalTree = await this.git
        .git(repo, ['write-tree'], {
          indexFile: prepared.indexFile,
          hooksPath: prepared.hooksPath,
          signal: recovery,
        })
        .then((s) => s.trim())
        .catch(() => '')
      let warning = failure
        ? `已检测到提交完成，但命令未正常结束：${this.git.safeError(failure)}。请检查，不要重复提交。`
        : ''
      if (finalTree !== plan.tree) {
        const directory = path.join(path.dirname(indexPath), 'gitcode-recovery')
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const recoveryFile = path.join(directory, `${plan.id}.index`)
        await fs.copyFile(prepared.indexFile, recoveryFile)
        await fs.writeFile(
          recoveryFile + '.json',
          JSON.stringify(
            { head: newHead, paths: plan.paths, reason: 'post-commit hook changed private index' },
            null,
            2,
          ),
          { mode: 0o600 },
        )
        warning = `提交已完成，但提交后的 hook 修改了额外暂存内容，恢复索引保存在 ${recoveryFile}；原未选暂存内容保持。请检查后再操作。`
      }
      return { output, outcome: warning ? 'partial' : 'succeeded', ...(warning ? { warning } : {}) }
    } catch (error) {
      if (published && temporary) {
        keepTemporary = true
        throw new Error(
          `${this.git.safeError(error)}；提交私有索引保留在 ${path.join(temporary, 'index')}，请检查后再操作。`,
        )
      }
      throw error
    } finally {
      if (!released) {
        const current = await fs.stat(indexPath + '.lock').catch(() => null)
        await lock.close().catch(() => {})
        if (
          lockIdentity &&
          current &&
          lockIdentity.ino === current.ino &&
          lockIdentity.dev === current.dev
        )
          await fs.rm(indexPath + '.lock', { force: true })
      }
      if (temporary && !keepTemporary)
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

module.exports = { SelectedCommitOperations }
