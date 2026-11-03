'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const digest = (value) => createHash('sha256').update(value).digest('hex')
class NavigationOperations {
  constructor(git, validators) {
    this.git = git
    this.validators = validators
  }
  async reference(repo, request, signal) {
    const git = this.git
    if (
      !request ||
      typeof request.expectedHead !== 'string' ||
      typeof request.expectedBranch !== 'string'
    )
      throw new Error('缺少仓库上下文，请重新打开菜单。')
    await git.checkContext(repo, request, signal)
    const ref = this.validators.string(request.fullRef, '引用')
    this.validators.revision(request.expectedOid)
    let actual
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)) {
      if (ref !== request.expectedOid) throw new Error('提交对象不一致。')
      actual = ref
    } else {
      if (!/^refs\/(heads|remotes|tags)\//.test(ref)) throw new Error('请选择分支或标签。')
      await git.git(repo, ['check-ref-format', ref], { signal })
      actual = (
        await git.git(repo, ['rev-parse', '--verify', '--quiet', ref], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim()
      if (actual !== request.expectedOid)
        throw new Error('目标引用已变化或不存在，请刷新后重新操作。')
    }
    const oid = (
      await git.git(repo, ['rev-parse', '--verify', `${ref}^{commit}`], { signal })
    ).trim()
    const head = await git.head(repo, signal),
      branch = await git.currentBranch(repo, signal)
    const bases = head
      ? (await git.git(repo, ['merge-base', '--all', head, oid], { signal, allowedCodes: [0, 1] }))
          .trim()
          .split('\n')
          .filter(Boolean)
      : []
    return {
      fullRef: ref,
      referenceOid: actual,
      oid,
      head,
      branch,
      canFastForward: !!head && head !== oid && bases.includes(head),
      alreadyMerged: !!head && bases.includes(oid),
      related: !!bases.length,
    }
  }
  async remote(repo, info, signal) {
    const git = this.git
    const originalConfig = await git.git(repo, ['config', '--null', '--list', '--includes'], {
      signal,
    })
    if (!info.fullRef.startsWith('refs/remotes/')) throw new Error('请选择远程分支。')
    const symbolic = (
      await git.git(repo, ['symbolic-ref', '-q', info.fullRef], { signal, allowedCodes: [0, 1] })
    ).trim()
    if (symbolic) throw new Error('不能删除远程默认分支的符号引用。')
    const remotes = (await git.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean)
    const candidates = remotes.filter((remote) =>
      info.fullRef.startsWith(`refs/remotes/${remote}/`),
    )
    if (candidates.length !== 1) throw new Error('远程命名空间不明确，请检查远程配置。')
    const remote = candidates[0]
    const fetchUrls = (await git.git(repo, ['remote', 'get-url', '--all', remote], { signal }))
      .trim()
      .split('\n')
    const pushUrls = (
      await git.git(repo, ['remote', 'get-url', '--push', '--all', remote], { signal })
    )
      .trim()
      .split('\n')
    if (
      fetchUrls.length !== 1 ||
      pushUrls.length !== 1 ||
      fetchUrls[0] !== pushUrls[0] ||
      !this.validators.validRemote(pushUrls[0])
    )
      throw new Error('删除要求远程具有唯一且一致的获取与推送地址，请先检查配置。')
    // A literal URL must be a fixed point of the configured rewrite rules.
    // Otherwise checking one address and pushing it could expand it again.
    for (const record of originalConfig.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\n')
      const key = record.slice(0, separator),
        prefix = record.slice(separator + 1)
      if (
        separator >= 0 &&
        /^url\..*\.(?:insteadof|pushinsteadof)$/i.test(key) &&
        prefix &&
        pushUrls[0].startsWith(prefix)
      )
        throw new Error('远程地址存在多级重写，无法可靠确定删除目标。请使用明确的远程地址。')
    }
    const mappings = (
      await git.git(repo, ['config', '--get-all', `remote.${remote}.fetch`], {
        signal,
        allowedCodes: [0, 1],
      })
    )
      .trim()
      .split('\n')
    const matches = []
    for (const mapping of mappings) {
      const [from, to, extra] = mapping.replace(/^\+/, '').split(':')
      if (
        extra !== undefined ||
        !from?.startsWith('refs/heads/') ||
        !to?.startsWith(`refs/remotes/${remote}/`)
      )
        continue
      if (!to.includes('*') && to === info.fullRef && !from.includes('*')) matches.push(from)
      else if ((to.match(/\*/g) || []).length === 1 && (from.match(/\*/g) || []).length === 1) {
        const [prefix, suffix] = to.split('*')
        if (info.fullRef.startsWith(prefix) && info.fullRef.endsWith(suffix)) {
          const middle = info.fullRef.slice(prefix.length, suffix ? -suffix.length : undefined)
          if (middle) matches.push(from.replace('*', middle))
        }
      }
    }
    const unique = [...new Set(matches)]
    if (unique.length !== 1) throw new Error('无法唯一确定远程服务器上的分支，未执行删除。')
    const remoteRef = unique[0]
    await git.git(repo, ['check-ref-format', remoteRef], { signal })
    const raw = await git.git(repo, ['ls-remote', '--refs', '--', pushUrls[0], remoteRef], {
      signal,
      timeout: 30000,
    })
    const tips = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((row) => row.split('\t'))
      .filter((row) => row[1] === remoteRef)
    if (tips.length !== 1 || tips[0][0] !== info.referenceOid)
      throw new Error('远程分支已更新或删除。请先获取并刷新，再重新确认删除。')
    const config = await git.git(repo, ['config', '--null', '--list', '--includes'], { signal })
    if (config !== originalConfig) throw new Error('核对期间远程配置发生变化，请重新读取。')
    return {
      remote,
      remoteRef,
      oid: tips[0][0],
      signature: digest(config),
      checkedAt: Date.now(),
      url: pushUrls[0],
    }
  }
  async read(repo, request, signal) {
    if (
      !['info', 'rebase', 'delete-remote', 'compare-head', 'compare-working'].includes(
        request?.kind,
      )
    )
      throw new Error('不支持的导航读取操作。')
    const info = await this.reference(repo, request, signal)
    if (request.kind === 'rebase')
      return { ...info, rebase: await this.git.rebase.plan(repo, info, signal) }
    if (request.kind === 'delete-remote') {
      const value = await this.remote(repo, info, signal)
      const { url: _url, ...remote } = value
      return { ...info, remote }
    }
    if (request.kind === 'info') return info
    const working = request.kind === 'compare-working'
    if (!working && !info.head) throw new Error('当前分支尚无提交。')
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      info.oid,
      ...(working ? [] : [info.head]),
      '--',
    ]
    const parts = (await this.git.git(repo, args, { signal })).split('\0'),
      files = []
    for (let i = 0; i + 1 < parts.length; i += 2)
      files.push({ status: parts[i], path: parts[i + 1] })
    const state = working ? await this.git.status(repo, signal) : null
    for (const file of state?.unstaged.filter((file) => file.status === '?') || []) {
      const existing = files.find((item) => item.path === file.path)
      if (existing) existing.status = 'M'
      else files.push({ ...file })
    }
    let diff = null
    if (request.file !== undefined) {
      this.validators.filePath(request.file)
      if (!files.some((file) => file.path === request.file))
        throw new Error('该文件不在比较结果中。')
      let output
      if (
        working &&
        state.unstaged.some((file) => file.path === request.file && file.status === '?')
      ) {
        const stat = await fs.lstat(path.join(repo, request.file))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
          throw new Error('该未跟踪文件类型或大小不支持文本比较。')
        await this.git.merge.safePath(repo, request.file)
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-compare-'))
        try {
          const entry = (
            await this.git.git(repo, ['ls-tree', '-z', info.oid, '--', request.file], { signal })
          ).split('\0')[0]
          const match = entry.match(/^(100(?:644|755)) blob ([a-f0-9]+)\t/)
          let base = ''
          if (match) {
            const size = Number(
              (await this.git.git(repo, ['cat-file', '-s', match[2]], { signal })).trim(),
            )
            if (size > 4 * 1024 * 1024) throw new Error('基础文件过大，暂不支持文本比较。')
            base = await this.git.git(repo, ['cat-file', 'blob', match[2]], { signal })
          } else if (entry) throw new Error('该基础文件类型不支持文本比较。')
          const before = match
              ? path.join(directory, 'before')
              : process.platform === 'win32'
                ? 'NUL'
                : '/dev/null',
            after = path.join(directory, 'after')
          if (match) {
            await fs.writeFile(before, base)
            await fs.chmod(before, match[1] === '100755' ? 0o755 : 0o644)
          }
          await fs.copyFile(path.join(repo, request.file), after)
          output = await this.git.git(
            repo,
            [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-color',
              '--no-index',
              '--',
              before,
              after,
            ],
            { signal, allowedCodes: [0, 1] },
          )
          const left = JSON.stringify(`a/${request.file}`),
            right = JSON.stringify(`b/${request.file}`)
          output = output
            .split('\n')
            .map((line) =>
              line.startsWith('diff --git ')
                ? `diff --git ${left} ${right}`
                : line.startsWith('--- ')
                  ? `--- ${match ? left : '/dev/null'}`
                  : line.startsWith('+++ ')
                    ? `+++ ${right}`
                    : line.startsWith('Binary files ')
                      ? `Binary files ${left} and ${right} differ`
                      : line,
            )
            .join('\n')
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      } else
        output = await this.git.git(
          repo,
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-color',
            info.oid,
            ...(working ? [] : [info.head]),
            '--',
            request.file,
          ],
          { signal },
        )
      const chars = Array.from(output)
      diff = { diff: chars.slice(0, 300000).join(''), truncated: chars.length > 300000 }
    }
    await this.git.checkContext(repo, request, signal)
    return { ...info, files, diff }
  }
  async execute(repo, request, signal) {
    const info = await this.reference(repo, request, signal),
      git = this.git
    await git.noInProgress(repo, signal)
    if (request.action === 'merge-branch' || request.action === 'fast-forward') {
      if (request.confirm !== true) throw new Error('请确认合并的来源与目标分支。')
      if (!info.branch || !info.head) throw new Error('请先检出一个已有提交的本地分支。')
      if (info.alreadyMerged) throw new Error('目标分支的提交已包含在当前分支中，无需合并。')
      if (!info.related) throw new Error('未找到共同历史，请先检查仓库历史是否完整；未执行合并。')
      if (request.action === 'fast-forward' && !info.canFastForward)
        throw new Error('当前状态不能快进，未修改分支。可改用合并。')
      return git.merge.integrate(repo, info.oid, signal, {
        ffOnly: request.action === 'fast-forward',
      })
    }
    if (request.action === 'create-tag') {
      const name = this.validators.string(request.name, '标签名称', { max: 1000 })
      if (name.startsWith('-')) throw new Error('无效的标签名称。')
      await git.git(repo, ['check-ref-format', `refs/tags/${name}`], { signal })
      if (typeof request.annotated !== 'boolean') throw new Error('请选择标签类型。')
      const message = this.validators.string(request.message, '标签说明', {
        empty: true,
        max: 20000,
      })
      if (request.annotated && !message.trim()) throw new Error('附注标签需要填写说明。')
      const output = await git.git(
        repo,
        [
          '-c',
          'tag.gpgSign=false',
          'tag',
          ...(request.annotated ? ['-a', '-m', message] : []),
          '--',
          name,
          info.oid,
        ],
        { signal },
      )
      return { output, outcome: 'succeeded' }
    }
    if (request.action === 'delete-remote-branch') {
      if (request.confirm !== true || typeof request.remoteSignature !== 'string')
        throw new Error('请先核对并确认远程分支删除。')
      const remote = await this.remote(repo, info, signal)
      if (remote.signature !== request.remoteSignature)
        throw new Error('远程配置已变化，请重新核对删除目标。')
      let output
      try {
        output = await git.git(
          repo,
          [
            '-c',
            `remote.${remote.remote}.mirror=false`,
            '-c',
            'push.followTags=false',
            'push',
            '--porcelain',
            '--no-follow-tags',
            '--recurse-submodules=no',
            `--force-with-lease=${remote.remoteRef}:${remote.oid}`,
            '--',
            remote.url,
            `:${remote.remoteRef}`,
          ],
          { signal, timeout: 300000 },
        )
      } catch (failure) {
        // A dropped connection may happen after the server has deleted the ref.
        // Never retry a deletion automatically or report a definite failure then.
        try {
          const recovery = AbortSignal.timeout(15000)
          const actual = await git.git(
            repo,
            ['ls-remote', '--refs', '--', remote.url, remote.remoteRef],
            { signal: recovery, timeout: 15000 },
          )
          if (!actual.trim())
            return {
              output: '',
              outcome: 'partial',
              warning:
                '服务器上的分支已不存在，但删除请求未正常结束。请核对远程状态后刷新本地跟踪引用；不要重复执行。',
            }
        } catch {}
        throw failure
      }
      try {
        const current = (
          await git.git(repo, ['rev-parse', '--verify', '--quiet', info.fullRef], {
            signal,
            allowedCodes: [0, 1],
          })
        ).trim()
        if (current === info.referenceOid)
          await git.git(repo, ['update-ref', '-d', info.fullRef, info.referenceOid], { signal })
        else if (current)
          return {
            output,
            outcome: 'partial',
            warning: '远程分支已删除，但本地跟踪引用在操作期间有更新，已保留，请刷新核对。',
          }
        return { output, outcome: 'succeeded' }
      } catch (error) {
        return {
          output,
          outcome: 'partial',
          warning: `远程分支已删除，本地远程跟踪引用需要刷新核对：${git.safeError(error)}`,
        }
      }
    }
    throw new Error('不支持的导航操作。')
  }
}
module.exports = { NavigationOperations }
