'use strict'
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { createHash, randomUUID } = require('node:crypto')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const absent = (error) => {
  if (error.code === 'ENOENT') return null
  throw error
}
class GitFlowFinishOperations {
  constructor(git) {
    this.git = git
  }
  async location(repo, signal) {
    return path.resolve(
      repo,
      (
        await this.git.git(repo, ['rev-parse', '--git-path', 'gitcode-flow-finish.json'], {
          signal,
        })
      ).trim(),
    )
  }
  async read(repo, signal) {
    const file = await this.location(repo, signal),
      stat = await fs.lstat(file).catch(absent)
    if (!stat) return null
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw new Error('GitFlow 执行记录异常，请通过外部工具检查。')
    const raw = await fs.readFile(file, 'utf8'),
      value = JSON.parse(raw)
    if (
      value.version !== 1 ||
      value.repo !== repo ||
      !['feature', 'release', 'hotfix'].includes(value.type) ||
      !Array.isArray(value.steps) ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index > value.steps.length ||
      value.steps.length > 4
    )
      throw new Error('GitFlow 执行记录无法识别。')
    const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
    if (
      !value.config ||
      typeof value.branch !== 'string' ||
      !oid.test(value.sourceOid) ||
      !value.expected ||
      value.expected[value.branch] !== value.sourceOid ||
      Object.values(value.expected).some((v) => typeof v !== 'string' || !oid.test(v))
    )
      throw new Error('GitFlow 引用记录无效。')
    const targets =
      value.type === 'feature'
        ? [value.config.develop]
        : [value.config.production, value.config.develop]
    const layout = [
      { kind: 'merge', target: targets[0], from: 'source' },
      ...(value.tagName ? [{ kind: 'tag' }] : []),
      ...(value.type === 'feature'
        ? []
        : [{ kind: 'merge', target: value.config.develop, from: 'production' }]),
      { kind: 'cleanup' },
    ]
    if (
      JSON.stringify(targets) !== JSON.stringify(value.targets) ||
      layout.length !== value.steps.length ||
      layout.some(
        (s, i) =>
          s.kind !== value.steps[i].kind ||
          s.target !== value.steps[i].target ||
          s.from !== value.steps[i].from,
      ) ||
      Object.keys(value.expected).length !== new Set([value.branch, ...targets]).size ||
      targets.some((name) => !Object.hasOwn(value.expected, name))
    )
      throw new Error('GitFlow 步骤记录无效。')
    if (value.pending) {
      const step = layout[value.index]
      if (
        step?.kind !== 'merge' ||
        value.pending.target !== step.target ||
        value.pending.before !== value.expected[step.target] ||
        value.pending.incoming !==
          (step.from === 'source' ? value.sourceOid : value.expected[value.config.production])
      )
        throw new Error('GitFlow 暂停点记录无效。')
    }
    return { file, value, signature: digest(raw) }
  }
  async state(repo, signal) {
    try {
      const r = await this.read(repo, signal)
      if (!r) return null
      const v = r.value
      return {
        id: v.id,
        signature: r.signature,
        type: v.type,
        branch: v.branch,
        index: v.index,
        steps: v.steps.map((s) => ({ label: s.label, done: !!s.done })),
        current: v.steps[v.index]?.label || '完成',
        error: v.error || '',
        tagName: v.tagName,
        deleteBranch: v.deleteBranch,
        pending: !!v.pending,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        signature: '',
        branch: '',
        type: 'feature',
        index: 0,
        steps: [],
        current: '记录需要检查',
        error: this.git.safeError(error),
        blocked: true,
      }
    }
  }
  async save(file, value) {
    const tmp = file + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      await fs.rename(tmp, file)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  async locked(repo, signal, work) {
    const file = await this.location(repo, signal),
      lock = file + '.run-lock'
    let handle
    try {
      handle = await fs.open(lock, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const raw = await fs.readFile(lock, 'utf8')
      const pid = Number(raw)
      let alive = true
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') alive = false
        }
      }
      if (alive) throw new Error('另一项 GitFlow 完成操作正在执行，请稍后刷新。')
      if ((await fs.readFile(lock, 'utf8')) !== raw) throw new Error('执行锁已变化，请重试。')
      await fs.unlink(lock)
      handle = await fs.open(lock, 'wx', 0o600)
    }
    try {
      await handle.writeFile(String(process.pid))
      return await work(file)
    } finally {
      await handle.close()
      await fs.rm(lock, { force: true })
    }
  }
  async oid(repo, name, signal) {
    await this.git.branchName(repo, name, signal)
    return (
      await this.git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
        signal,
        allowedCodes: [0, 1],
      })
    ).trim()
  }
  async tag(repo, name, signal) {
    return (
      await this.git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], {
        signal,
        allowedCodes: [0, 1],
      })
    ).trim()
  }
  async ancestor(repo, source, target, signal) {
    return (
      (
        await this.git.git(repo, ['merge-base', source, target], { signal, allowedCodes: [0, 1] })
      ).trim() === source
    )
  }
  async clean(repo, signal) {
    await this.git.noInProgress(repo, signal)
    const status = await this.git.status(repo, signal)
    if (status.staged.length || status.unstaged.length)
      throw new Error('请先提交或贮藏工作区修改，再完成 GitFlow 分支。')
  }
  async context(repo, request, signal) {
    if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
      throw new Error('缺少 GitFlow 仓库上下文。')
    await this.git.checkContext(repo, request, signal)
  }
  async begin(repo, request, file, signal) {
    if (await this.read(repo, signal))
      throw new Error('已有未完成的 GitFlow 操作，请先继续或停止后续步骤。')
    await this.clean(repo, signal)
    const data = await this.git.flow.guarded(repo, request, signal)
    if (!data.complete) throw new Error('请先初始化 GitFlow。')
    const config = await this.git.flow.validate(repo, data.config, signal)
    const branch = await this.git.branchName(repo, request.branch, signal),
      type = ['feature', 'release', 'hotfix'].find(
        (t) => branch.startsWith(config[t]) && branch.length > config[t].length,
      )
    if (!type || [config.production, config.develop].includes(branch))
      throw new Error('请选择功能、发布或热修复分支。')
    if (typeof request.deleteBranch !== 'boolean' || typeof request.createTag !== 'boolean')
      throw new Error('请确认分支清理与标签选项。')
    if (type === 'feature' && request.createTag) throw new Error('功能分支完成不创建版本标签。')
    const targets = type === 'feature' ? [config.develop] : [config.production, config.develop],
      expected = {}
    await this.git.checkReference(repo, `refs/heads/${branch}`, request.sourceOid, signal)
    expected[branch] = request.sourceOid
    for (const target of targets) {
      await this.git.checkReference(
        repo,
        `refs/heads/${target}`,
        request.targetOids?.[target],
        signal,
      )
      await this.git.checkWorktree(repo, `refs/heads/${target}`, false, signal)
      expected[target] = request.targetOids[target]
    }
    if (request.deleteBranch) {
      const worktrees = await this.git.git(repo, ['worktree', 'list', '--porcelain', '-z'], {
        signal,
      })
      let location = ''
      for (const field of worktrees.split('\0')) {
        if (field.startsWith('worktree ')) location = field.slice(9)
        if (field === `branch refs/heads/${branch}` && path.resolve(location) !== repo)
          throw new Error('源分支正在其他工作区使用，无法删除。')
      }
    }
    let tagName = '',
      tagMessage = ''
    if (request.createTag) {
      tagName = request.tagName
      if (
        typeof tagName !== 'string' ||
        !tagName ||
        tagName.startsWith('-') ||
        tagName.length > 200
      )
        throw new Error('请输入有效的版本标签。')
      await this.git.git(repo, ['check-ref-format', `refs/tags/${tagName}`], { signal })
      if (await this.tag(repo, tagName, signal))
        throw new Error(`标签 ${tagName} 已存在，不能覆盖。`)
      tagMessage = request.tagMessage
      if (
        typeof tagMessage !== 'string' ||
        !tagMessage.trim() ||
        tagMessage.includes('\0') ||
        tagMessage.length > 20000
      )
        throw new Error('请填写标签说明。')
    }
    const steps = [
      {
        kind: 'merge',
        target: targets[0],
        from: 'source',
        label: `合并 ${branch} → ${targets[0]}`,
      },
    ]
    if (tagName) steps.push({ kind: 'tag', label: `创建标签 ${tagName}` })
    if (type !== 'feature')
      steps.push({
        kind: 'merge',
        target: config.develop,
        from: 'production',
        label: `回合 ${config.production} → ${config.develop}`,
      })
    steps.push({
      kind: 'cleanup',
      label: request.deleteBranch ? `删除本地分支 ${branch}` : `保留本地分支 ${branch}`,
    })
    const value = {
      version: 1,
      id: randomUUID(),
      repo,
      branch,
      type,
      sourceOid: request.sourceOid,
      config,
      configSignature: data.signature,
      expected,
      targets,
      steps,
      index: 0,
      pending: null,
      error: '',
      tagName,
      tagMessage,
      tagOid: '',
      deleteBranch: request.deleteBranch,
      deleting: false,
    }
    await this.context(repo, request, signal)
    await this.save(file, value)
    return value
  }
  async verifyRefs(repo, v, signal) {
    const data = await this.git.flow.configuration(repo, signal)
    if (data.signature !== v.configSignature)
      throw new Error('Git 配置已变化，停止后续步骤；请核对后保留已完成结果。')
    const config = await this.git.flow.validate(repo, data.config, signal)
    if (JSON.stringify(config) !== JSON.stringify(v.config)) throw new Error('GitFlow 规则已变化。')
    if (
      !v.branch.startsWith(config[v.type]) ||
      [config.production, config.develop].includes(v.branch)
    )
      throw new Error('GitFlow 源分支记录异常。')
    for (const [name, oid] of Object.entries(v.expected)) {
      const actual = await this.oid(repo, name, signal)
      if (name === v.branch && v.deleting && !actual) continue
      if (actual !== oid) throw new Error(`分支 ${name} 已被外部修改，停止执行，请核对。`)
    }
    if (v.tagOid && (await this.tag(repo, v.tagName, signal)) !== v.tagOid)
      throw new Error('本次创建的版本标签已被外部修改或删除，停止后续步骤。')
  }
  async reconcile(repo, v, file, signal) {
    if (!v.pending) return
    const p = v.pending,
      merge = await this.git.merge.state(repo, signal),
      current = await this.oid(repo, p.target, signal)
    if (merge?.active) {
      if (merge.incoming !== p.incoming || merge.branch !== p.target || merge.head !== p.before)
        throw new Error('当前合并不属于这项 GitFlow 操作，请先检查。')
      return 'waiting'
    }
    if (current !== p.before) {
      const parents = (await this.git.git(repo, ['show', '-s', '--format=%P', current], { signal }))
        .trim()
        .split(' ')
      if (parents.length !== 2 || parents[0] !== p.before || parents[1] !== p.incoming)
        throw new Error('无法确认当前合并结果，停止后续步骤。')
      v.expected[p.target] = current
      v.steps[v.index].done = true
      v.index++
    }
    v.pending = null
    await this.save(file, v)
  }
  async advance(repo, v, file, signal) {
    if ((await this.reconcile(repo, v, file, signal)) === 'waiting')
      return {
        outcome: 'partial',
        output: '',
        warning: '请先解决当前合并冲突并完成当前合并，再继续 GitFlow。',
      }
    while (v.index < v.steps.length) {
      if (signal?.aborted) throw new Error('GitFlow 操作已暂停，已完成步骤不会回滚。')
      await this.verifyRefs(repo, v, signal)
      await this.clean(repo, signal)
      const step = v.steps[v.index]
      if (step.kind === 'merge') {
        const incoming = step.from === 'source' ? v.sourceOid : v.expected[v.config.production]
        if (!(await this.ancestor(repo, incoming, v.expected[step.target], signal))) {
          await this.git.checkWorktree(repo, `refs/heads/${step.target}`, false, signal)
          await this.git.git(repo, ['switch', step.target], { signal })
          await this.verifyRefs(repo, v, signal)
          v.pending = { target: step.target, before: v.expected[step.target], incoming }
          await this.save(file, v)
          const result = await this.git.merge.start(repo, incoming, signal, { noFF: true }),
            merge = await this.git.merge.state(repo, signal)
          if (merge?.files.length)
            return {
              outcome: 'partial',
              output: '',
              warning: `GitFlow 已暂停在 ${step.target} 的合并，等待解决 ${merge.files.length} 个冲突。`,
            }
          if (merge?.active) {
            const committed = await this.git.merge.execute(
              repo,
              {
                action: 'merge-finish',
                expectedHead: merge.head,
                expectedBranch: merge.branch,
                mergeSignature: merge.signature,
                message: `Merge ${v.branch} into ${step.target}`,
              },
              signal,
            )
            if (committed.outcome !== 'succeeded')
              throw new Error(committed.error || '合并提交未完成。')
          }
          if ((await this.reconcile(repo, v, file, signal)) === 'waiting')
            return { outcome: 'partial', output: '', warning: '请先完成当前合并。' }
          if (v.pending === null && v.steps[v.index] !== step) continue
          // A no-op merge may leave HEAD unchanged; the next ancestry check will skip it.
          if (
            !(await this.ancestor(
              repo,
              incoming,
              await this.oid(repo, step.target, signal),
              signal,
            ))
          )
            throw new Error(result.error || '合并没有完成。')
        }
      } else if (step.kind === 'tag') {
        const existing = await this.tag(repo, v.tagName, signal)
        if (existing && existing !== v.tagOid)
          throw new Error(
            `标签 ${v.tagName} 已出现且无法确认来源，未覆盖标签；请停止后续步骤并核对。`,
          )
        if (!existing) {
          await this.git.git(
            repo,
            ['tag', '-a', v.tagName, v.expected[v.config.production], '-m', v.tagMessage],
            { signal, timeout: 300000 },
          )
          v.tagOid = await this.tag(repo, v.tagName, signal)
          await this.save(file, v)
        }
      } else if (step.kind === 'cleanup') {
        await this.git.checkWorktree(repo, `refs/heads/${v.config.develop}`, false, signal)
        await this.git.git(repo, ['switch', v.config.develop], { signal })
        if (v.deleteBranch) {
          for (const target of v.targets)
            if (!(await this.ancestor(repo, v.sourceOid, v.expected[target], signal)))
              throw new Error('源分支尚未完整合入所有目标，不能删除。')
          await this.git.checkWorktree(repo, `refs/heads/${v.branch}`, true, signal)
          if (await this.oid(repo, v.branch, signal)) {
            v.deleting = true
            await this.save(file, v)
            await this.git.git(repo, ['update-ref', '-d', `refs/heads/${v.branch}`, v.sourceOid], {
              signal,
            })
          }
          if (await this.oid(repo, v.branch, signal))
            throw new Error('源分支被重新创建，未清理该分支的配置。')
          const section = `branch.${v.branch}`
          const raw = await this.git.git(
            repo,
            [
              'config',
              '--local',
              '--get-regexp',
              `^branch\\.${v.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`,
            ],
            { signal, allowedCodes: [0, 1] },
          )
          if (raw)
            await this.git.git(repo, ['config', '--local', '--remove-section', section], { signal })
        }
      } else throw new Error('无法识别 GitFlow 执行步骤。')
      step.done = true
      v.index++
      await this.save(file, v)
    }
    await fs.unlink(file)
    return {
      outcome: 'succeeded',
      output: `已完成 ${v.branch}；本地合并${v.tagName ? '及标签' : ''}已完成，${v.deleteBranch ? '已删除' : '保留'}本地分支。未推送，也未删除远端分支。`,
    }
  }
  async execute(repo, request, signal) {
    await this.context(repo, request, signal)
    return this.locked(repo, signal, async (file) => {
      let v
      try {
        if (request.action === 'gitflow-finish') v = await this.begin(repo, request, file, signal)
        else {
          const read = await this.read(repo, signal)
          if (!read || read.signature !== request.finishSignature)
            throw new Error('GitFlow 进度已变化，请刷新后重试。')
          v = read.value
        }
        if (request.action === 'gitflow-finish-stop') {
          await this.git.noInProgress(repo, signal)
          await fs.unlink(file)
          return {
            outcome: 'succeeded',
            output: '已停止后续步骤。已完成的合并、标签及当前工作区修改均保留，未回滚任何提交。',
          }
        }
        return await this.advance(repo, v, file, signal)
      } catch (error) {
        if (v) {
          v.error = this.git.safeError(error)
          await this.save(file, v).catch(() => {})
          return {
            outcome: signal?.aborted ? 'cancelled' : 'partial',
            output: '',
            error: v.error,
            warning:
              'GitFlow 尚未完成。已完成步骤保留，源分支只在所有目标合入后清理；请核对进度，不要重新开始。',
          }
        }
        throw error
      }
    })
  }
}
module.exports = { GitFlowFinishOperations }
