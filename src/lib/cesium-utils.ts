/**
 * Cesium 场景初始化工具。
 *
 * 用到三维地球的页面(/roads 等)统一经由这里创建地球:Cesium 以全局脚本方式引入
 * (public/Cesium,全局名 `Cesium`,类型声明见 src/types/cesium.d.ts)。
 * 本模块把底图、地形与控件开关收敛成一套固定配置,保证各页面地球外观一致。
 */

/**
 * 在指定容器内创建并返回一个配置好的 Cesium.Viewer(Google 影像 + 世界地形,关闭默认控件)。
 * @param container 承载地球的 DOM 容器,需有确定的宽高,否则 Cesium 不会渲染。
 * @returns 初始化完成的 viewer;调用方在卸载时需自行调用 viewer.destroy()。
 */
export function initializeCesium(container: HTMLElement): Cesium.Viewer {
  // Google 影像瓦片:lyrs 可选 m(道路)/ s(卫星,无标注)/ y(卫星+标注)/ p(地形)
  const googleImageryProvider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    subdomains: ['0', '1', '2', '3'],
    // Google 影像最高 20 级:再往上没有瓦片,限制以避免无意义的空请求
    maximumLevel: 20,
  })

  const viewer = new Cesium.Viewer(container, {
    shouldAnimate: false,
    // Cesium 1.107+ 推荐通过 Terrain 实例异步加载世界地形
    terrain: Cesium.Terrain.fromWorldTerrain(),

    // 用 Google 影像替换默认的 ion/Bing 底图
    baseLayer: new Cesium.ImageryLayer(googleImageryProvider),

    // 去掉默认控件,只保留地球
    animation: false, // 左下角动画时钟
    timeline: false, // 底部时间轴
    baseLayerPicker: false, // 右上角底图切换
    geocoder: false, // 右上角搜索
    homeButton: false, // 右上角主页
    sceneModePicker: false, // 右上角投影模式切换
    navigationHelpButton: false, // 右上角帮助
    fullscreenButton: false, // 右下角全屏
    infoBox: false, // 点击要素的信息框(连带消除 sandboxed iframe 警告)
    selectionIndicator: false, // 点击要素的绿色选择框
  })

  // 屏幕空间误差阈值:值越小越清晰、越吃性能;8 是清晰度优先的取值
  viewer.scene.globe.maximumScreenSpaceError = 8
  viewer.scene.globe.preloadAncestors = false
  viewer.scene.globe.preloadSiblings = false
  // 常驻的瓦片数量上限:越大越顺滑,但占用更多内存
  viewer.scene.globe.tileCacheSize = 200
  viewer.scene.fog.enabled = true

  return viewer
}
