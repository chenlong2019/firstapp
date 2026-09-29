/**
 * 全局 Cesium 类型声明。
 * 本项目通过 index.html 中的 <script src="/Cesium/Cesium.js"> 以全局脚本方式
 * 引入 CesiumJS(public/Cesium 目录),而非 npm 包,因此需要手动声明全局命名空间。
 * 如后续改为 npm 安装 cesium 并 import,可删除此文件。
 */
declare namespace Cesium {
  export interface TerrainProvider {
    name?: string
    ready?: boolean
    [key: string]: any
  }

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

  export class Viewer {
    constructor(container: Element | string, options?: Record<string, any>)
    scene: Scene
    terrainProvider: TerrainProvider
    destroy(): void
    [key: string]: any
  }

  export function createWorldTerrainAsync(options?: Record<string, any>): Promise<TerrainProvider>

  export class UrlTemplateImageryProvider {
    constructor(options?: Record<string, any>)
    [key: string]: any
  }

  export class ImageryLayer {
    constructor(imageryProvider: UrlTemplateImageryProvider)
    [key: string]: any
  }
}
