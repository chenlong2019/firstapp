/**
 * 应用入口:创建 Vue 实例,注册 Pinia 与 vue-router,最后挂载到 index.html 的 #app。
 *
 * 由 index.html 的 <script type="module" src="/src/main.ts"> 引入。
 * 加载时序:同页面的 Cesium 全局脚本先于本模块执行,因此各页面可直接使用全局 Cesium
 * (类型声明见 src/types/cesium.d.ts)。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './assets/main.scss'

import App from './App.vue'
import router from './router'

const app = createApp(App)

// 插件必须在 mount 之前注册,否则组件 setup 里取不到 router / pinia store
app.use(createPinia())
app.use(router)

app.mount('#app')
