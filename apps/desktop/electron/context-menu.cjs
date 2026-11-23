'use strict'

// Context menus carry display data and return an item ID. No renderer-supplied
// Electron roles, callbacks, accelerators or commands cross this boundary.
function sanitizeRequest(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.requestId) ||
    value.requestId < 1 ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 100
  )
    throw new Error('无效的右键菜单。')
  const ids = new Set()
  const items = value.items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('无效的菜单项。')
    if (item.type === 'separator') return { type: 'separator' }
    if (
      typeof item.id !== 'string' ||
      !/^[a-z][a-z0-9:-]{0,100}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 1000 ||
      /[\r\n\0]/.test(item.label) ||
      typeof item.enabled !== 'boolean' ||
      (item.checked !== undefined && typeof item.checked !== 'boolean')
    )
      throw new Error('无效的菜单项。')
    ids.add(item.id)
    return {
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      ...(item.checked === undefined ? {} : { type: 'checkbox', checked: item.checked }),
    }
  })
  // Empty groups must not leave leading, trailing or adjacent separators.
  const compact = items.filter(
    (item, index) =>
      item.type !== 'separator' ||
      (index > 0 &&
        items[index - 1].type !== 'separator' &&
        items.slice(index + 1).some((next) => next.type !== 'separator')),
  )
  if (!ids.size) throw new Error('菜单没有操作项。')
  return { requestId: value.requestId, items: compact }
}
class ContextMenus {
  constructor(Menu) {
    this.Menu = Menu
    this.active = null
  }
  popup(window, value) {
    const request = sanitizeRequest(value)
    this.close()
    if (!window || window.isDestroyed()) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const active = { id: request.requestId, menu: null, window, finish: null }
      active.finish = (result = null) => {
        if (this.active !== active) return
        this.active = null
        resolve(result)
      }
      this.active = active
      try {
        active.menu = this.Menu.buildFromTemplate(
          request.items.map((item) =>
            item.type === 'separator'
              ? item
              : {
                  ...item,
                  // Escape mnemonic markers in literal ref names, including '&'.
                  label: item.label.replace(/&/g, '&&'),
                  click: () => {
                    if (item.enabled) active.finish(item.id)
                  },
                },
          ),
        )
        active.menu.popup({
          window,
          callback: () => {
            // Let the selected item's click finish before the dismissal callback.
            setImmediate(() => active.finish())
          },
        })
      } catch (error) {
        if (this.active === active) this.active = null
        reject(error)
      }
    })
  }
  close(requestId) {
    const active = this.active
    if (!active || (requestId !== undefined && requestId !== active.id)) return
    active.finish()
    if (active.menu && !active.window.isDestroyed()) active.menu.closePopup(active.window)
  }
}
module.exports = { ContextMenus, sanitizeRequest }
