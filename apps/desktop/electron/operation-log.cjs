'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { hookReport } = require('./command-diagnostics.cjs')

const DAY = 86400000
const MAX_BYTES = 20 * 1024 * 1024
function redact(value) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1[已隐藏参数]')
    .replace(/(authorization\s*[:=]\s*)(?:Basic|Bearer)?\s*[^\r\n]+/gi, '$1[已隐藏]')
    .replace(
      /((?:password|passwd|token|secret|access[_-]?key|extraheader)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[已隐藏]',
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g,
      '[已隐藏]',
    )
}
function bounded(value, max = 16000) {
  const text = redact(value)
  return text.length > max ? '[前文已截断]\n' + text.slice(-max) : text
}
class OperationLog {
  constructor({ directory, now = Date.now, limit = 5000, bytes = MAX_BYTES } = {}) {
    this.file = directory ? path.join(directory, 'activity.json') : null
    this.now = now
    this.limit = limit
    this.bytes = bytes
    this.records = []
    this.fetches = {}
    this.settings = { autoFetchInterval: 1, extended: false }
    this.storageError = ''
    this.writes = Promise.resolve()
    this.leases = new Map()
    if (this.file) {
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) throw Error('日志文件超过大小限制')
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.records)) throw Error('日志格式不匹配')
        this.records = data.records.map((record) =>
          record.state === 'running'
            ? {
                ...record,
                state: 'unknown',
                finishedAt: now(),
                message: '上次会话未记录完成结果，请核对仓库状态，勿重复执行。',
              }
            : record,
        )
        this.fetches = data.fetches && typeof data.fetches === 'object' ? data.fetches : {}
        if (
          Number.isInteger(data.settings?.autoFetchInterval) &&
          data.settings.autoFetchInterval >= 0 &&
          data.settings.autoFetchInterval <= 60
        )
          this.settings.autoFetchInterval = data.settings.autoFetchInterval
        this.settings.extended = data.settings?.extended === true
      } catch (error) {
        if (error.code !== 'ENOENT') this.storageError = '无法读取旧日志，本次记录仍可查看。'
      }
    }
    this.trim()
  }
  trim() {
    const cutoff = this.now() - 7 * DAY
    this.records = this.records
      .filter(
        (r) => r.state === 'running' || (r.lastSeenAt || r.finishedAt || r.startedAt) >= cutoff,
      )
      .slice(-this.limit)
    const encode = () =>
      JSON.stringify({
        version: 1,
        settings: this.settings,
        fetches: this.fetches,
        records: this.records,
      })
    // Repository status is bounded independently from operation history.
    const keys = Object.keys(this.fetches).sort(
      (a, b) => this.fetches[b].lastAttempt - this.fetches[a].lastAttempt,
    )
    for (const key of keys.slice(500)) delete this.fetches[key]
    let data = encode()
    while (Buffer.byteLength(data) > this.bytes && this.records.length) {
      this.records.shift()
      data = encode()
    }
    while (Buffer.byteLength(data) > this.bytes && Object.keys(this.fetches).length) {
      delete this.fetches[Object.keys(this.fetches)[0]]
      data = encode()
    }
    return data
  }
  save() {
    const data = this.trim()
    if (!this.file) return Promise.resolve()
    this.pendingData = data
    if (this.saveScheduled) return this.writes
    this.saveScheduled = true
    this.writes = (async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      while (this.pendingData != null) {
        const batch = this.pendingData
        this.pendingData = null
        await fs.promises.writeFile(this.file + '.tmp', batch, { mode: 0o600 })
        await fs.promises.rename(this.file + '.tmp', this.file)
        this.storageError = ''
      }
    })()
      .catch(() => {
        this.pendingData = null
        this.storageError = '日志暂时无法保存到本机，当前会话仍可查看。'
      })
      .finally(() => {
        this.saveScheduled = false
        if (this.pendingData != null) return this.save()
      })
    return this.writes
  }
  start(operation, repo, { background = false, target = '' } = {}) {
    const record = {
      id: randomUUID(),
      operation: bounded(operation, 100),
      repo: String(repo || ''),
      target: bounded(target, 300),
      background,
      startedAt: this.now(),
      state: 'running',
      message: '',
      output: '',
      commands: '',
      truncated: false,
    }
    this.records.push(record)
    void this.save()
    return record
  }
  command(record, args, result, elapsed) {
    if (!record) return
    const displayArgs = args.map((arg, index) =>
      ['-m', '--message'].includes(args[index - 1]) ? '[提交说明已省略]' : arg,
    )
    const line = bounded(
      `git ${displayArgs.map((arg) => JSON.stringify(arg)).join(' ')}\n退出码 ${result.code} · ${elapsed}ms\n${result.stderr || ''}`,
      4000,
    )
    const next = record.commands + line + '\n'
    record.truncated ||= next.length > 64000
    record.commands = bounded(next, 64000)
  }
  diagnostic(record, result) {
    if (!record) return
    if (!record.commandDiagnostic)
      Object.defineProperty(record, 'commandDiagnostic', {
        value: { hooks: [], output: '' },
        enumerable: false,
      })
    const diagnostic = record.commandDiagnostic
    diagnostic.hooks.push(...result.hooks.slice(0, Math.max(0, 32 - diagnostic.hooks.length)))
    if (result.hooks.length || result.code !== 0)
      diagnostic.output = bounded(
        [diagnostic.output, result.stdout, result.stderr].filter(Boolean).join('\n'),
      )
  }
  finish(record, result = {}, error) {
    record.finishedAt = this.now()
    record.duration = record.finishedAt - record.startedAt
    record.state = error ? 'failed' : result.outcome || (result.warning ? 'partial' : 'succeeded')
    const steps = Array.isArray(result.steps) ? result.steps : []
    if (steps.length)
      record.steps = steps.map((step) => ({
        remote: bounded(step.remote, 300),
        ok: step.ok === true,
        ...(!step.ok && step.message ? { message: bounded(step.message, 4000) } : {}),
      }))
    if (result.refreshError) record.refreshError = bounded(result.refreshError)
    if (result.warning) record.warning = bounded(result.warning)
    const aggregateError =
      record.operation === 'fetch' &&
      steps.some((step) => !step.ok && step.message === result.error)
        ? ''
        : result.error
    record.message = bounded(
      [
        error?.message,
        aggregateError,
        result.warning,
        result.refreshError && `Git 已返回，但刷新失败：${result.refreshError}`,
        result.cleanupError,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    const diagnosticOutput = record.commandDiagnostic?.output || ''
    const distinctOutput = (value) => {
      const text = bounded(value).trim()
      return diagnosticOutput && text && diagnosticOutput.includes(text) ? '' : value
    }
    record.output = bounded(
      [
        distinctOutput(result.output),
        distinctOutput(result.details),
        record.commandDiagnostic?.hooks.length
          ? `Git Hook 检查\n${hookReport(record.commandDiagnostic.hooks)}`
          : '',
        diagnosticOutput,
        ...(record.operation === 'fetch'
          ? []
          : steps.map((s) => `${s.remote}：${s.ok ? '已获取' : s.message || '未完成'}`)),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    if (result.refreshError && record.state === 'succeeded') record.state = 'partial'
    record.truncated ||=
      [result.output, result.details].some((v) => String(v || '').length > 16000) ||
      steps.some((step) => String(step.message || '').length > 4000)
    if (record.background && ['failed', 'partial'].includes(record.state)) {
      const previous = this.records.findLast(
        (r) => r !== record && r.background && r.repo === record.repo,
      )
      if (
        previous &&
        previous.state === record.state &&
        previous.message === record.message &&
        previous.output === record.output &&
        JSON.stringify(previous.steps || []) === JSON.stringify(record.steps || [])
      ) {
        previous.repeatCount = (previous.repeatCount || 1) + 1
        previous.lastSeenAt = record.finishedAt
        this.records = this.records.filter((r) => r !== record)
      }
    }
    void this.save()
  }
  read(request) {
    if (
      !request ||
      !['application', 'repository'].includes(request.scope) ||
      (request.repo !== undefined && typeof request.repo !== 'string') ||
      (request.id !== undefined && (typeof request.id !== 'string' || request.id.length > 100)) ||
      (request.focus !== undefined && request.focus !== 'fetch-failure')
    )
      throw Error('无效的日志查询。')
    this.trim()
    const scoped = this.records
      .filter((r) => (request.scope === 'application' ? !r.repo : r.repo === request.repo))
      .filter(
        (r) =>
          this.settings.extended ||
          !r.background ||
          ['failed', 'partial', 'unknown'].includes(r.state),
      )
      .sort((a, b) => (a.lastSeenAt || a.startedAt) - (b.lastSeenAt || b.startedAt))
    const focused =
      request.focus === 'fetch-failure'
        ? scoped.findLast(
            (r) => r.operation === 'fetch' && ['failed', 'partial', 'unknown'].includes(r.state),
          )
        : null
    const targetId = request.id || focused?.id
    const recent = scoped.slice(-500)
    if (targetId && !recent.some((r) => r.id === targetId)) {
      const target = scoped.find((r) => r.id === targetId)
      if (target) recent.splice(0, 1, target)
    }
    return {
      records: recent
        .map((r) => ({
          ...r,
          detailLoaded: targetId === r.id,
          steps: targetId === r.id ? r.steps : undefined,
          output: targetId === r.id ? r.output : '',
          commands: targetId === r.id && this.settings.extended ? r.commands : '',
        }))
        .reverse(),
      settings: { ...this.settings },
      storageError: this.storageError,
    }
  }
  preferences(value) {
    if (value !== undefined) {
      if (
        !value ||
        !Number.isInteger(value.autoFetchInterval) ||
        value.autoFetchInterval < 0 ||
        value.autoFetchInterval > 60 ||
        typeof value.extended !== 'boolean' ||
        Object.keys(value).some((k) => !['autoFetchInterval', 'extended'].includes(k))
      )
        throw Error('自动获取间隔须为 0～60 分钟。')
      const changed =
        this.settings.autoFetchInterval !== value.autoFetchInterval ||
        this.settings.extended !== value.extended
      this.settings = { autoFetchInterval: value.autoFetchInterval, extended: value.extended }
      if (changed) {
        const event = this.start('activity-settings', '')
        this.finish(event, {
          output: `自动获取：${value.autoFetchInterval} 分钟；扩展日志：${value.extended ? '开启' : '关闭'}`,
        })
      }
      void this.save()
    }
    return { ...this.settings }
  }
  clear(request) {
    this.read(request)
    this.records = this.records.filter(
      (r) =>
        r.state === 'running' ||
        (request.scope === 'application' ? !!r.repo : r.repo !== request.repo),
    )
    void this.save()
  }
  status(repo) {
    return this.fetches[repo] || { lastAttempt: 0, lastSuccess: 0, remotes: {}, error: '' }
  }
  updateFetch(repo, result, signatures = {}) {
    const old = this.status(repo)
    const at = this.now()
    let remotes = { ...old.remotes }
    for (const step of result.steps || []) {
      const prior = remotes[step.remote] || {}
      remotes = {
        ...remotes,
        [step.remote]: {
          lastAttempt: at,
          lastSuccess: step.ok ? at : prior.lastSuccess || 0,
          error: step.ok ? '' : bounded(step.message, 2000),
          signature: signatures[step.remote] || prior.signature || '',
          paused:
            !step.ok &&
            /authentication|permission denied|could not read (?:username|password)|terminal prompts disabled|host key verification|认证|publickey|credential/i.test(
              step.message || '',
            ),
        },
      }
    }
    this.fetches[repo] = {
      ...old,
      lastAttempt: at,
      lastSuccess: result.outcome === 'succeeded' ? at : old.lastSuccess || 0,
      remotes,
      error:
        result.outcome === 'cancelled' ? old.error : bounded(result.error || result.warning || ''),
    }
    void this.save()
  }
}
module.exports = { OperationLog, redact }
