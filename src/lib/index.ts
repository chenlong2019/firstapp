/**
 * three-engine 通用 TS 库统一入口。
 *
 * 设计约定：
 * - 本入口只做「再导出」，不含任何业务装配逻辑，也不引用 Vue —— 整个 src/lib 与框架无关；
 * - `three` 系列模块在库构建里全部 external（作为 peerDependency，由使用方提供实例），
 *   避免同一页面出现两份 three 实例（WebGPURenderer 与 TSL 节点会因此彻底失效）；
 * - 真正零依赖的只有 `./three-engine/drone-sim`，可单独在 Node / Web Worker 中运行。
 *
 * 目录与分层见下方分组注释。
 */

// 以下 5 个 `export *` 分组共同构成 three-engine 的公开 API,使用方按需 import;
// 除标注「零运行时依赖」的第 1 组外,其余分组都依赖 three 或 DOM,只能在浏览器环境使用。

// ──────────────────────────────────────────────────────────────────────────
// 1. 纯逻辑层：零运行时依赖（不引 three、不碰 DOM），Node / Worker / 浏览器通吃
//    飞控状态机、电池模型、失效保护、摇杆归一化、避障 AABB 判定、事件日志
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/drone-sim'

// ──────────────────────────────────────────────────────────────────────────
// 2. three 基础场景层：渲染器 / 轨道控制 / 后处理 / 投影换算
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/proj-system'
export * from './three-engine/three-viewer'
export * from './three-engine/post-effects'

// ──────────────────────────────────────────────────────────────────────────
// 3. 无人机机械与感知层：地面/障碍物世界、机体装配、灯光、测距雷达、航线编辑、飞行装配
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/drone-world'
export * from './three-engine/drone-rig'
export * from './three-engine/drone-lights'
export * from './three-engine/drone-radar'
export * from './three-engine/mission-editor'
export * from './three-engine/drone-fly'

// ──────────────────────────────────────────────────────────────────────────
// 4. 模型查看器：多格式加载(glb/gltf/fbx/obj/stl/ply/dae) + 模型树 / 描边 / 爆炸图 / 骨骼动画 / 导出
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/model-loaders'
export * from './three-engine/glb-viewer'

// ──────────────────────────────────────────────────────────────────────────
// 5. 模型工作流：体检评分规则 / 二进制体检 / 批量处理 / 打包
//    `model-audit-rules` 是唯一不含 three 的一块(纯数值规则),`glb-inspect` 只依赖它,
//    因此"不解码直读 GLB 容器"的批量体检与渲染无关,可在 Worker 里跑。
//    ⚠️ `model-audit` 是场景口径(需要 three),与 `glb-inspect` 共用同一套规则与评分。
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/model-audit-rules'
export * from './three-engine/model-audit'
export * from './three-engine/glb-inspect'
export * from './three-engine/model-batch'
export * from './three-engine/zip-store'

// ──────────────────────────────────────────────────────────────────────────
// 6. 应用装配层：把上面几层拼成一个可渲染场景（需要 DOM 环境，按需引入）
// ──────────────────────────────────────────────────────────────────────────
export * from './three-engine/game-ui'
export * from './three-engine/game-instance'
