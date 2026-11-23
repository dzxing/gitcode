'use strict'
const phases = {
  'renderer-start': '界面开始初始化',
  'core-ready': '本地 Git 服务就绪',
  'restore-start': '开始恢复活动仓库',
  ready: '启动完成',
  failed: '启动恢复未完成',
  skipped: '已跳过本次恢复',
}
class ApplicationLifecycle {
  constructor(journal, now = Date.now, startedAt = now()) {
    this.journal = journal
    this.now = now
    this.begin(startedAt)
    this.mark('配置与本地 Git 服务已创建')
  }
  begin(startedAt = this.now()) {
    this.record = this.journal.start('application-startup', '')
    this.record.startedAt = startedAt
    this.last = startedAt
    this.lines = []
  }
  mark(label) {
    const now = this.now()
    this.lines.push(
      `${label} · 阶段 ${Math.max(0, now - this.last)}ms · 累计 ${Math.max(0, now - this.record.startedAt)}ms`,
    )
    this.last = now
    this.record.output = this.lines.join('\n')
    void this.journal.save()
  }
  stage(phase) {
    if (typeof phase !== 'string' || !Object.hasOwn(phases, phase)) throw Error('无效的启动阶段。')
    if (phase === 'renderer-start' && this.record.state !== 'running') this.begin()
    if (this.record.state !== 'running') return
    this.mark(phases[phase])
    if (['ready', 'failed', 'skipped'].includes(phase))
      this.journal.finish(this.record, {
        outcome: phase === 'ready' ? 'succeeded' : 'partial',
        output: this.lines.join('\n'),
        warning: phase === 'ready' ? '' : phases[phase],
      })
  }
}
module.exports = { ApplicationLifecycle }
