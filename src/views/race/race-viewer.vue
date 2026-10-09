<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** 场景卸载句柄(对应 race-scene/race/main.ts 的 RaceSceneHandle) */
type RaceSceneHandle = { dispose: () => void }
type RaceMarkupModule = { RACE_MARKUP: string }
type RaceSceneModule = { mountRace: (host: HTMLElement) => RaceSceneHandle }

/**
 * 海湾竞速场景(移植自 img2threejs/preview 的 race.html)。
 *
 * 场景脚本是按"页面级脚本"写的:模块顶层直接查 DOM、开渲染循环。装进 SPA 用两层配合:
 * 1. 先把 HTML 骨架注入容器(场景靠 id 找元素,#race-viewport 必须已存在);
 * 2. 再动态载入场景入口拿到 mountRace,卸载时 dispose 收口,反复进出不叠加实例。
 *
 * 这里用 `import.meta.glob` 而不是静态 import:场景整体移植自上游工程(它只开 strict,
 * 没开 noUncheckedIndexedAccess),静态 import 会把它拖进主工程的类型检查;glob 只建立
 * 运行时依赖图,类型检查交给专门的 tsconfig.race.json。
 */
const SCENE_PATH = '../../race-scene/race/main.ts'
const MARKUP_PATH = '../../race-scene/race/race-markup.ts'
const sceneLoaders = import.meta.glob<RaceSceneModule>('../../race-scene/race/main.ts')
const markupLoaders = import.meta.glob<RaceMarkupModule>('../../race-scene/race/race-markup.ts')

/** 场景宿主节点(模板 ref);scene 为已挂载实例句柄。 */
const host = ref<HTMLElement | null>(null)
let scene: RaceSceneHandle | null = null
/** 标记组件已在场景异步载入完成前卸载,回调据此放弃挂载。 */
let leaving = false

/** 挂载流程:拿宿主 → 注入骨架 → 动态载入入口 → mountRace;期间切走则放弃。 */
onMounted(async () => {
  const element = host.value
  const loadMarkup = markupLoaders[MARKUP_PATH]
  const loadScene = sceneLoaders[SCENE_PATH]
  if (!element || !loadMarkup || !loadScene) return

  const { RACE_MARKUP } = await loadMarkup()
  // 场景脚本一进模块就查 DOM,骨架必须先就位
  element.innerHTML = RACE_MARKUP
  const { mountRace } = await loadScene()
  // 载入期间用户可能已经切走
  if (leaving) return
  scene = mountRace(element)
})

/** 卸载:先置 leaving 挡住仍在途的挂载,再 dispose 场景并清空宿主,保证反复进出不叠加实例。 */
onUnmounted(() => {
  leaving = true
  scene?.dispose()
  scene = null
  host.value?.replaceChildren()
})
</script>

<template>
  <!-- 竞速场景的唯一挂载容器:HTML 骨架与渲染循环都由 mountRace 注入,这里只提供宿主节点 -->
  <div ref="host" class="race-page race-host"></div>
</template>

<style scoped>
/* 场景自带样式都在 race.css 里(由场景入口全局引入),这里只把容器铺满页面宿主。
   用 absolute 而非 fixed:App.vue 的 .route-host 是定位祖先,这样场景才不会被
   顶部菜单栏盖住(fixed 会以视口为参照,顶到屏幕最上边)。 */
.race-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
