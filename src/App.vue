<!--
  App.vue —— 应用根组件:提供顶部导航栏 + 路由出口。

  布局分两层(纵向 flex,合计占满 #app 的 100% 高度):
  1. .app-nav   —— 固定高度的菜单栏,菜单项来自路由表的 APP_MENU(单一数据源,见 router/index.ts),
                   RouterLink 自带 router-link-exact-active 激活类,当前页自动高亮;
  2. .route-host —— 相对定位的页面宿主,<RouterView> 渲染匹配到的页面组件。

  .route-host 上的 position: relative 是有意为之:各页面根容器普遍用 `position: absolute; inset: 0`
  或 `height: 100%` 来铺满,挂在它下面即可自动避开菜单栏,无需逐个页面改高度。
  组件本身不含业务状态与逻辑;全局样式由 src/assets/main.scss 在 main.ts 中引入。
-->
<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { APP_MENU } from './router'
</script>

<template>
  <div class="app-shell">
    <!-- 顶部导航:切换路由。菜单项由 router/index.ts 的 APP_MENU 提供 -->
    <nav class="app-nav" aria-label="主导航">
      <span class="brand">three-viewer</span>
      <ul class="nav-list">
        <li v-for="item in APP_MENU" :key="item.path">
          <RouterLink class="nav-link" :to="item.path">{{ item.title }}</RouterLink>
        </li>
      </ul>
    </nav>

    <!-- 页面宿主:相对定位 + 裁切,让页面内的 absolute/100% 根容器只占菜单栏以下的区域 -->
    <div class="route-host">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
/* 整体骨架:菜单栏固定高度,页面宿主吃掉剩余空间 */
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* ————————————————————————— 顶部菜单栏 ————————————————————————— */

.app-nav {
  /* flex: none 保证不被下方页面压缩;深浅配色与其他页面的浮层面板保持一致 */
  display: flex;
  flex: none;
  gap: 20px;
  align-items: center;
  height: 44px;
  padding: 0 16px;
  background: rgb(7 17 22 / 96%);
  border-bottom: 1px solid rgb(121 230 202 / 24%);
  box-sizing: border-box;
  font-family:
    ui-sans-serif,
    system-ui,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

.brand {
  color: #79e6ca;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.nav-list {
  display: flex;
  gap: 4px;
  align-items: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

.nav-link {
  display: inline-block;
  padding: 6px 14px;
  color: #bfe8de;
  background: rgb(30 63 65 / 45%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  text-decoration: none;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
}

.nav-link:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}

/* 当前路由高亮:vue-router 对精确匹配的链接会自动加这个类,无需自己比对 path */
.nav-link.router-link-exact-active {
  color: #06201d;
  background: #79e6ca;
  border-color: #b4ffeb;
  font-weight: 600;
}

/* ————————————————————————— 页面宿主 ————————————————————————— */

.route-host {
  /* position: relative 供页面内 absolute 根容器定位;min-height: 0 让 flex 子项可收缩而非被内容撑高 */
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
