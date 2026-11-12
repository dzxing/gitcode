// Scroll only the menu that owns the focused item; fixed submenus must not move ancestors.
export function focusMenuItem(button: HTMLElement | null | undefined) {
  if (!button) return
  button.focus({ preventScroll: true })
  const menu = button.closest<HTMLElement>('[role="menu"]')
  if (!menu) return
  const bounds = menu.getBoundingClientRect(),
    item = button.getBoundingClientRect(),
    style = getComputedStyle(menu),
    top = bounds.top + menu.clientTop + parseFloat(style.paddingTop),
    bottom = bounds.top + menu.clientTop + menu.clientHeight - parseFloat(style.paddingBottom)
  if (item.top < top) menu.scrollTop += item.top - top
  else if (item.bottom > bottom) menu.scrollTop += item.bottom - bottom
}
