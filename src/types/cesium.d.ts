/**
 * 全局 Cesium 类型声明。
 * 本项目通过 index.html 中的 <script src="/Cesium/Cesium.js"> 以全局脚本方式
 * 引入 CesiumJS(public/Cesium 目录),而非 npm 包,因此需要手动声明全局命名空间。
 * 如后续改为 npm 安装 cesium 并 import,可删除此文件。
 */
declare namespace Cesium {
  /**
   * 地形数据源接口:仅声明本项目实际用到的字段,索引签名用于放行其余 Cesium 原生属性。
   */
  export interface TerrainProvider {
    name?: string
    ready?: boolean
    [key: string]: any
  }

  /** Cesium 场景:此处只用到 setTerrain,其余成员经索引签名透传 */
  export interface Scene {
    setTerrain(terrain: Terrain): void
    [key: string]: any
  }

  /** 异步地形包装器,setTerrain() 只接受 Terrain 实例,不要传普通对象 */
  export class Terrain {
    constructor(providerFactory: () => Promise<TerrainProvider>)
    static fromWorldTerrain(options?: Record<string, any>): Terrain
    [key: string]: any
  }

  /** Cesium 查看器:容器挂载点,持有 scene 与 terrainProvider;destroy 用于卸载时释放资源 */
  export class Viewer {
    constructor(container: Element | string, options?: Record<string, any>)
    scene: Scene
    terrainProvider: TerrainProvider
    destroy(): void
    [key: string]: any
  }

  /** 创建 Cesium 自带世界地形(Ion)数据源的异步工厂,返回可传给 Terrain 的 provider */
  export function createWorldTerrainAsync(options?: Record<string, any>): Promise<TerrainProvider>

  /** 基于 URL 模板({z}/{x}/{y})拉取栅格瓦片的影像提供器 */
  export class UrlTemplateImageryProvider {
    constructor(options?: Record<string, any>)
    [key: string]: any
  }

  /** 影像图层:构造时传入一个影像提供器,再叠加到 viewer 的 imagelayers 上 */
  export class ImageryLayer {
    constructor(imageryProvider: UrlTemplateImageryProvider)
    [key: string]: any
  }
}
