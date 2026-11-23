'use strict'
// All user-initiated close paths share one request and one shutdown operation.
class CloseCoordinator {
  constructor({ send, fallback, finish, timeout = 5000 }) {
    Object.assign(this, { send, fallback, finish, timeout })
    this.nextId = 0
    this.pending = null
    this.finished = false
  }
  request() {
    if (this.finished || this.pending) return
    const id = ++this.nextId
    this.pending = { id, acknowledged: false }
    const timer = setTimeout(async () => {
      if (this.pending?.id !== id || this.pending.acknowledged) return
      try {
        const approved = await this.fallback()
        if (this.pending?.id !== id || this.pending.acknowledged) return
        if (approved) this.approve(id)
        else this.cancel(id)
      } catch {
        this.cancel(id)
      }
    }, this.timeout)
    this.pending.timer = timer
    try {
      this.send(id)
    } catch {
      /* Bounded fallback handles an unavailable renderer. */
    }
  }
  acknowledge(id) {
    if (this.pending?.id !== id) return false
    this.pending.acknowledged = true
    clearTimeout(this.pending.timer)
    return true
  }
  cancel(id) {
    if (this.pending?.id === id) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
  }
  approve(id) {
    if (this.finished || this.pending?.id !== id) return false
    clearTimeout(this.pending.timer)
    this.pending = null
    this.finished = true
    void this.finish()
    return true
  }
  rendererGone() {
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
  }
}
module.exports = { CloseCoordinator }
