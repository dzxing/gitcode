import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAppearanceStore } from './features/preferences/stores/appearance'
import { useFontStore } from './features/preferences/stores/fonts'
import './app/styles/index.css'
import './shared/styles/themes.css'
import './shared/styles/settings.css'

const pinia = createPinia()
useAppearanceStore(pinia)
useFontStore(pinia)
createApp(App).use(pinia).mount('#app')
