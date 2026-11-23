import type { ObjectDirective } from 'vue'
type Value = string | null | undefined | { text?: string | null; target?: string; parent?: boolean }
interface State {
  value: Value
  hovered: boolean
  focused: boolean
  frame: number
  refresh: () => void
  cleanup: () => void
}
const states = new WeakMap<HTMLElement, State>()
function check(el: HTMLElement, state: State) {
  const text = typeof state.value === 'object' && state.value ? state.value.text : state.value
  if ((!state.hovered && !state.focused) || typeof text !== 'string' || !text) {
    el.removeAttribute('title')
    return
  }
  const target = typeof state.value === 'object' && state.value ? state.value.target : undefined
  const container = typeof state.value === 'object' && state.value?.parent ? el.parentElement : el
  const candidates = target ? [...(container?.querySelectorAll<HTMLElement>(target) || [])] : [el]
  const clipped = candidates.some(
    (node) =>
      node.clientWidth > 0 &&
      node.clientHeight > 0 &&
      (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1),
  )
  if ((state.hovered || state.focused) && typeof text === 'string' && text && clipped)
    el.setAttribute('title', text)
  else el.removeAttribute('title')
}
// Content titles reveal clipped text only. Action explanations and disabled
// reasons remain explicit; never infer either from a control's visible label.
export const vOverflowTitle: ObjectDirective<HTMLElement, Value> = {
  mounted(el, binding) {
    const state: State = {
      value: binding.value,
      hovered: false,
      focused: false,
      frame: 0,
      refresh: () => {},
      cleanup: () => {},
    }
    let listening = false
    const refresh = () => {
      const active = state.hovered || state.focused
      if (active && !listening) {
        window.addEventListener('resize', refresh)
        listening = true
      } else if (!active && listening) {
        window.removeEventListener('resize', refresh)
        listening = false
      }
      check(el, state)
      cancelAnimationFrame(state.frame)
      if (active) state.frame = requestAnimationFrame(() => check(el, state))
    }
    const enter = () => {
      state.hovered = true
      refresh()
    }
    const leave = () => {
      state.hovered = false
      refresh()
    }
    const focus = () => {
      state.focused = true
      refresh()
    }
    const blur = () => {
      state.focused = false
      refresh()
    }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focusin', focus)
    el.addEventListener('focusout', blur)
    state.refresh = refresh
    state.cleanup = () => {
      cancelAnimationFrame(state.frame)
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('focusin', focus)
      el.removeEventListener('focusout', blur)
      window.removeEventListener('resize', refresh)
    }
    el.removeAttribute('title')
    states.set(el, state)
  },
  updated(el, binding) {
    const state = states.get(el)
    if (state) {
      state.value = binding.value
      state.refresh()
    }
  },
  beforeUnmount(el) {
    states.get(el)?.cleanup()
    states.delete(el)
  },
  getSSRProps: () => ({}),
}
