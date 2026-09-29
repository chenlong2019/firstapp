export function initializeCesium(container: HTMLElement): Cesium.Viewer {
  // Google 影像瓦片:lyrs 可选 m(道路)/ s(卫星,无标注)/ y(卫星+标注)/ p(地形)
  const googleImageryProvider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    subdomains: ['0', '1', '2', '3'],
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

  viewer.scene.globe.maximumScreenSpaceError = 8
  viewer.scene.globe.preloadAncestors = false
  viewer.scene.globe.preloadSiblings = false
  viewer.scene.globe.tileCacheSize = 200
  viewer.scene.fog.enabled = true

  return viewer
}
