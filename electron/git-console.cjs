'use strict'
const { randomUUID } = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')
const path = require('node:path')
const { redact } = require('./operation-log.cjs')

// Memory only. This viewer never schedules or executes Git work.
class GitConsole {
  constructor({ bytes = 2 * 1024 * 1024, limit = 6000 } = {}) {
    this.epoch = randomUUID()
    this.sequence = 0
    this.entries = []
    this.bytes = 0
    this.maximum = bytes
    this.limit = limit
    this.running = new Map()
  }
  append(context, kind, text, extra = {}) {
    const entry = {
      ...context,
      kind,
      text: redact(text).slice(0, 16384),
      ...extra,
      sequence: ++this.sequence,
      at: Date.now(),
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry))
    this.entries.push({ entry, bytes })
    this.bytes += bytes
    while (this.entries.length && (this.bytes > this.maximum || this.entries.length > this.limit))
      this.bytes -= this.entries.shift().bytes
  }
  start(repo, operationId, executable, args) {
    const context = { repo, operationId, commandId: randomUUID() }
    // Commit text and editor input are not diagnostic output.
    const safeArgs = args.map((arg, index) =>
      ['-m', '--message'].includes(args[index - 1]) || /^--message=/.test(arg)
        ? '[提交说明已隐藏]'
        : arg,
    )
    const command = [executable, ...safeArgs]
      .map((arg) => (/^[A-Za-z0-9_./:=@,+%-]+$/.test(arg) ? arg : JSON.stringify(arg)))
      .join(' ')
    this.running.set(context.commandId, {
      ...context,
      command: redact(command).slice(0, 16384),
      at: Date.now(),
    })
    this.append(context, 'start', command)
    const streams = new Map()
    let ended = false
    const emit = (kind, state, final = false) => {
      // Hold incomplete lines before redaction, including credentials split across chunks.
      for (;;) {
        const index = state.pending.search(/[\r\n]/)
        if (index < 0) break
        const line = state.pending.slice(0, index)
        const progress = state.pending[index] === '\r' && state.pending[index + 1] !== '\n'
        state.pending = state.pending.slice(
          index + (state.pending.slice(index, index + 2) === '\r\n' ? 2 : 1),
        )
        if (!state.skipping && line) this.append(context, kind, line, { progress })
        state.skipping = false
      }
      if (state.pending.length > 16384) {
        if (!state.skipping) this.append(context, kind, '[过长输出行已省略]')
        state.pending = ''
        state.skipping = true
      }
      if (final && state.pending && !state.skipping) this.append(context, kind, state.pending)
      if (final) state.pending = ''
    }
    return {
      write: (kind, chunk) => {
        if (ended) return
        if (!streams.has(kind))
          streams.set(kind, { decoder: new StringDecoder('utf8'), pending: '', skipping: false })
        const state = streams.get(kind)
        state.pending += state.decoder.write(chunk)
        emit(kind, state)
      },
      finish: (result, error, cancelled = false) => {
        if (ended) return
        ended = true
        for (const [kind, state] of streams) {
          state.pending += state.decoder.end()
          emit(kind, state, true)
        }
        const start = this.running.get(context.commandId)
        this.running.delete(context.commandId)
        this.append(context, 'finish', error?.message || '', {
          code: result?.code ?? null,
          state: cancelled ? 'cancelled' : error || result?.code !== 0 ? 'failed' : 'succeeded',
          elapsed: Date.now() - (start?.at || Date.now()),
        })
      },
    }
  }
  read(repo, request = {}) {
    if (typeof repo !== 'string' || !path.isAbsolute(repo) || repo.length > 32768)
      throw Error('无效的控制台仓库路径。')
    if (
      !request ||
      !['read', 'tail'].includes(request.action) ||
      (request.cursor !== undefined &&
        (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) ||
      (request.epoch !== undefined && typeof request.epoch !== 'string')
    )
      throw Error('无效的控制台读取请求。')
    const reset = request.epoch !== undefined && request.epoch !== this.epoch
    const cursor = reset ? 0 : request.cursor || 0
    if (!reset && cursor > this.sequence) throw Error('控制台游标已失效。')
    const first = this.entries[0]?.entry.sequence || this.sequence + 1
    const dropped = cursor < first - 1
    const entries = []
    let next = cursor,
      size = 0
    if (request.action === 'tail') next = this.sequence
    else {
      for (const { entry, bytes } of this.entries) {
        if (entry.sequence <= cursor) continue
        if (entry.repo === repo) {
          if (entries.length >= 256 || size + bytes > 128 * 1024) break
          entries.push(entry)
          size += bytes
        }
        next = entry.sequence
      }
      if (!entries.length) next = this.sequence
    }
    return {
      epoch: this.epoch,
      cursor: next,
      entries,
      reset,
      dropped,
      more: next < this.sequence,
      running: [...this.running.values()].filter((entry) => entry.repo === repo),
    }
  }
}
module.exports = { GitConsole }
