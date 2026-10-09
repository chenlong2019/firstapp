/**
 * 全局类型声明文件(命名沿用 auto-imports.d.ts 约定;按自动生成产物对待,请勿手动编辑)。
 *
 * 作用:以 declare global 声明全局常量 CESIUM,使以全局脚本方式引入的 CesiumJS
 * (index.html 中的 <script src="/Cesium/Cesium.js">)可在源码中直接引用;
 * 其类型 Cesium 定义在同目录的 cesium.d.ts。
 *
 * 本文件不产生任何运行时输出,只参与全局类型检查。
 */
declare global {
  const CESIUM: Cesium
}
