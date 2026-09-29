import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // 根路径没有独立首页:直接进 GLB 查看器,避免打包成桌面应用后打开白屏
    { path: '/', redirect: '/glb' },
    {
      path: '/roads',
      name: 'Roads',
      component: () => import('../views/roads/Road-MVT.vue'),
      meta: { title: '道路数据', menu: false },
    },
    {
      path: '/dji',
      name: 'Dji',
      component: () => import('../views/dji/dji-viewer.vue'),
      meta: { title: '道路数据', menu: false },
    },
    {
      path: '/glb',
      name: 'Glb',
      component: () => import('../views/glb/glb-viewer.vue'),
      meta: { title: 'GLB 模型查看', menu: false },
    },
    { path: '/:pathMatch(.*)*', redirect: '/glb' },
  ],
})

export default router
