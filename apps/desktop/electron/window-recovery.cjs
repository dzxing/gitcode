'use strict'

// Recovery must remain usable when no renderer JavaScript is running.
class WindowRecovery {
  constructor({
    window,
    dialog,
    reload,
    openLogs,
    isClosing,
    report = console.error,
    record = () => {},
  }) {
    Object.assign(this, { window, dialog, reload, openLogs, isClosing, report, record })
    this.pending = null
  }
  available() {
    return !this.window.isDestroyed() && !this.isClosing()
  }
  recover(kind, detail = '') {
    if (!this.available()) return Promise.resolve()
    if (this.pending) return this.pending
    try {
      this.record(kind, String(detail).slice(0, 1200))
    } catch (error) {
      this.report('[GitCode] 无法记录界面错误：', error)
    }
    this.pending = this.prompt(kind, detail)
      .catch((error) => this.report('[GitCode] 无法显示界面恢复提示：', error))
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }
  async prompt(kind, detail) {
    const messages = {
      load: 'GitCode 界面加载失败',
      crash: 'GitCode 界面意外退出',
      unresponsive: 'GitCode 界面暂未响应',
    }
    let reason = String(detail).slice(0, 1200)
    while (this.available()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show()
      const { response } = await this.dialog.showMessageBox(this.window, {
        type: 'warning',
        title: '恢复 GitCode',
        message: messages[kind] || messages.load,
        detail: [
          '重新加载只恢复界面，不会重试原来的 Git 操作，也不会回滚更改。后台任务可能仍在运行，恢复后请先核对仓库状态；尚未保存的输入可能丢失。',
          reason,
        ]
          .filter(Boolean)
          .join('\n\n'),
        buttons: ['重新加载界面', '打开日志目录', '暂不处理'],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      })
      if (!this.available() || response === 2) return
      try {
        if (response === 1) {
          const error = await this.openLogs()
          if (error) throw new Error(error)
        } else if (response === 0) {
          await this.reload()
          return
        } else return
      } catch (error) {
        this.report('[GitCode] 界面恢复失败：', error)
        reason =
          response === 1
            ? '无法打开日志目录，请重新选择操作。'
            : '重新加载失败，请重试或检查安装文件。'
      }
    }
  }
}

module.exports = { WindowRecovery }
