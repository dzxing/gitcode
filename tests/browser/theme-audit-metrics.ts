import type { Page } from '@playwright/test'
export async function measureThemeContrast(page: Page, selectors: Record<string, string>) {
  return page.evaluate((selectors) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = value
      ctx.fillRect(0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => (i === 3 ? n / 255 : n))
    }
    const over = (a: number[], b: number[]) => {
      const alpha = a[3]! + b[3]! * (1 - a[3]!)
      return [
        ...[0, 1, 2].map((i) => (a[i]! * a[3]! + b[i]! * b[3]! * (1 - a[3]!)) / (alpha || 1)),
        alpha,
      ]
    }
    const lum = (c: number[]) =>
      c
        .slice(0, 3)
        .map((n) => {
          const v = n / 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        })
        .reduce((v, n, i) => v + n * [0.2126, 0.7152, 0.0722][i]!, 0)
    const colors = Object.entries(selectors).flatMap(([role, selector]) => {
      const e = document.querySelector<HTMLElement>(selector)
      if (!e || !e.getClientRects().length) return []
      const chain = []
      for (let n: HTMLElement | null = e; n; n = n.parentElement) chain.unshift(n)
      let bg = [255, 255, 255, 1]
      for (const n of chain) bg = over(rgba(getComputedStyle(n).backgroundColor), bg)
      const style = getComputedStyle(e),
        fg = over(rgba(style.color), bg),
        a = lum(fg),
        b = lum(bg)
      return [
        {
          role,
          text: e.textContent?.trim().slice(0, 55),
          color: style.color,
          background: bg,
          ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          disabled:
            e.matches(':disabled, label:has(input:disabled)') || !!e.closest('fieldset[disabled]'),
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        },
      ]
    })

    return colors
  }, selectors)
}
