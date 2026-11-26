import { applicationBridge } from './applicationBridge'

export interface FontAccess {
  source: 'desktop' | 'browser'
  limitation: string
  read(): Promise<string[]>
}
export function getFontAccess(): FontAccess {
  const bridge = applicationBridge()
  if (bridge?.installedFonts)
    return { source: 'desktop', limitation: '', read: () => bridge.installedFonts!() }
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return {
      source: 'browser',
      limitation: '当前环境无法读取本机字体，可直接输入字体名称。',
      read: () => Promise.reject(new Error('当前环境无法读取本机字体。')),
    }
  const browser = window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }
  const source = document as Document & {
    permissionsPolicy?: { allowsFeature(feature: string): boolean }
    featurePolicy?: { allowsFeature(feature: string): boolean }
  }
  let limitation = ''
  if (!window.isSecureContext)
    limitation =
      '当前地址不支持读取本机字体，请使用 localhost、127.0.0.1 或 HTTPS 访问。也可直接输入字体名称。'
  else if (typeof browser.queryLocalFonts !== 'function')
    limitation = '当前浏览器不支持读取本机字体，可选择内置字体或输入已安装的字体名称。'
  else if (
    (source.permissionsPolicy || source.featurePolicy)?.allowsFeature('local-fonts') === false
  )
    limitation = '此页面的安全策略禁止读取本机字体，可使用桌面版或直接输入字体名称。'
  return {
    source: 'browser',
    limitation,
    async read() {
      if (limitation || !browser.queryLocalFonts)
        throw Error(limitation || '当前环境无法读取本机字体列表。')
      return [...new Set((await browser.queryLocalFonts()).map((font) => font.family))]
    },
  }
}
export function fontReadError(error: unknown, source: FontAccess['source']) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (source === 'browser' && name === 'NotAllowedError')
    return '未获准读取系统字体，仍可选择内置字体或输入名称。'
  if (source === 'browser' && name === 'SecurityError')
    return '系统字体暂不可用，可选择内置字体或输入名称。'
  if (name === 'AbortError') return '已取消读取系统字体，可继续选择或输入名称。'
  return '系统字体暂不可用，可选择内置字体或输入名称。'
}
