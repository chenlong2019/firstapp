import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueJsx(), vueDevTools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 15176,
  },
  optimizeDeps: {
    /**
     * TSL 后处理模块保持原生 ESM 直出，不参与依赖预构建。
     * 原因：这些模块一旦被"发现"就会触发 Vite 重新预构建，
     * 而预构建收尾时清理临时依赖目录会被本机安全删除策略拦截，导致 dev server 崩溃。
     * three/webgpu 必须保持被预构建（不能排除），否则 TSL 模块与主包会拿到两份 three 实例。
     */
    exclude: [
      'three/tsl',
      'three/examples/jsm/tsl/display/BloomNode.js',
      'three/examples/jsm/tsl/display/OutlineNode.js',
    ],
  },
})
