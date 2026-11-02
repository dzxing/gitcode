import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { fileURLToPath } from 'node:url'
import { localCorePlugin } from './scripts/local-core-plugin'

// The inspector mutates LAUNCH_EDITOR, so do not inherit its old default on restart.
const launchEditor =
  process.env.GITCODE_EDITOR ||
  (process.env.WSL_DISTRO_NAME
    ? fileURLToPath(new URL('./scripts/idea-wsl.sh', import.meta.url))
    : 'idea')

export default defineConfig(({ command }) => ({
  plugins: [
    vue(),
    ...(command === 'serve' ? [vueDevTools({ launchEditor })] : []),
    localCorePlugin(),
    {
      name: 'renderer-csp',
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${command === 'serve' ? ' ws://localhost:43187 ws://127.0.0.1:43187' : ''}; object-src 'none'; base-uri 'self'; frame-src ${command === 'serve' ? "'self'" : "'none'"}`,
            },
          },
        ]
      },
    },
  ],
  base: './',
  clearScreen: false,
  // Vue DevTools embeds its same-origin panel during development.
  server: {
    host: '127.0.0.1',
    port: 43187,
    strictPort: true,
    headers: {
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
      'Referrer-Policy': 'no-referrer',
    },
    watch: { ignored: ['**/legacy/**', '**/electron/**'] },
  },
}))
