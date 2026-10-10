/**
 * vue-router 路由表:每个 path 对应 src/views 下的一个页面组件,统一用动态 import() 懒加载
 * (进入该路由时才加载该页面的代码分块)。
 *
 * 对外导出:
 * - default: 路由实例,在 main.ts 中通过 app.use(router) 挂载;
 * - APP_MENU: 顶部导航菜单项,由本表按 `meta.menu` 生成(见文件末尾),新增页面只需在此登记。
 *
 * meta 字段约定:
 * - title: 菜单项文案,同时供页面标题使用(兜底取 path);
 * - menu:  是否出现在 App.vue 顶部导航栏;省略或 false 表示不进菜单(如重定向、整页接管视口的页面)。
 */
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

/**
 * 路由记录表。顺序即顶部菜单的显示顺序 —— 菜单项由本表直接生成(见 APP_MENU),
 * 因此路由与菜单永远一致,不存在两处各写一份而漏改的情况。
 */
const routes: RouteRecordRaw[] = [
  // 根路径没有独立首页:直接进 GLB 查看器,避免打包成桌面应用后打开白屏
  { path: '/', redirect: '/glb' },
  {
    path: '/roads',
    name: 'Roads',
    component: () => import('../views/roads/Road-MVT.vue'),
    meta: { title: '道路数据', menu: true },
  },
  {
    path: '/dji',
    name: 'Dji',
    component: () => import('../views/dji/dji-viewer.vue'),
    // 原为「道路数据」(复制粘贴笔误),按页面实际内容(DJI 飞行沙盒)修正
    meta: { title: 'DJI 飞行沙盒', menu: true },
  },
  {
    path: '/race',
    name: 'Race',
    component: () => import('../views/race/race-viewer.vue'),
    meta: { title: '海湾竞速', menu: true },
  },
  {
    path: '/glb',
    name: 'Glb',
    component: () => import('../views/glb/glb-viewer.vue'),
    meta: { title: 'GLB 模型查看', menu: true },
  },
  {
    // 与 /glb 的分工:查看器是"一次看一个",这里是"一次过一批"(批量体检 / 压缩 / 打包)
    path: '/models',
    name: 'Models',
    component: () => import('../views/models/models-workbench.vue'),
    meta: { title: '模型批量工作台', menu: true },
  },
  {
    // 整车交互演示:复用 public/models 下的 Tesla Model 3(rigged)资产
    path: '/tesla',
    name: 'Tesla',
    component: () => import('../views/tesla/tesla-viewer.vue'),
    meta: { title: 'Tesla 整车交互', menu: true },
  },
  {
    path: '/lib-demo',
    name: 'LibDemo',
    component: () => import('../views/lib-demo/lib-demo.vue'),
    meta: { title: '库调用示例', menu: true },
  },
  {
    path: '/use-lib-demo',
    name: 'UseLibDemo',
    component: () => import('../views/examples/use-lib-demo.vue'),
    meta: { title: '示例页面', menu: true },
  },
  // 兜底:任意未匹配路径都回退到 GLB 查看器,避免深链或刷新落到空白页
  { path: '/:pathMatch(.*)*', redirect: '/glb' },
]

/** 应用唯一的路由实例:HTML5 history 模式,base 取自 Vite 的 BASE_URL */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

/**
 * 顶部导航的菜单项:从 routes 里筛出 `meta.menu === true` 的项,保持路由表顺序。
 * 只暴露渲染菜单所需的最小信息,App.vue 不需要理解 meta 的其余字段。
 */
export const APP_MENU: ReadonlyArray<{ path: string; title: string }> = routes
  .filter((route) => Boolean(route.meta?.menu))
  .map((route) => ({ path: route.path, title: String(route.meta?.title ?? route.path) }))

export default router
