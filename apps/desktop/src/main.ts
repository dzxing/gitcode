import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAppearanceStore } from './stores/appearance'
import { useFontStore } from './stores/fonts'
import './style.css'
import './themes.css'
import './settings.css'

const pinia = createPinia()
useAppearanceStore(pinia)
useFontStore(pinia)
createApp(App).use(pinia).mount('#app')
