import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './styles/app.css'
import App from './App.vue'
import { createAppRouter } from './router'

createApp(App).use(createPinia()).use(createAppRouter()).mount('#app')

// 圏外でも開けるようにする。開発中は入れない。更新のたびに古い殻が残って
// 「直したのに直っていない」を作りやすい。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js', { scope: './' })
  })
}
