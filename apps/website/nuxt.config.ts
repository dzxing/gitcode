export default defineNuxtConfig({
  compatibilityDate: '2026-11-23',
  devtools: { enabled: false },
  telemetry: false,
  modules: ['@nuxt/ui'],
  ui: { fonts: false },
  colorMode: { preference: 'dark', fallback: 'dark' },
  icon: {
    mode: 'svg',
    provider: 'none',
    clientBundle: { scan: true, icons: ['lucide:menu', 'lucide:x'] },
  },
  css: ['~/assets/main.css', '~/assets/home.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      titleTemplate: '%s · GitCode',
      meta: [{ name: 'description', content: 'GitCode，本地运行的可视化 Git 工作台。' }],
    },
  },
  nitro: {
    prerender: { crawlLinks: true, failOnError: true },
  },
  typescript: { strict: true },
})
