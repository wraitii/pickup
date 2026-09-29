import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initStrudel } from './music/strudel'

// load samples up front so clip validation knows every sound name
initStrudel()

createApp(App).mount('#app')
