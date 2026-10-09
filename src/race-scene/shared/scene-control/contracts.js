/**
 * 场景控制契约（shared/scene-control/contracts.js，纯 JS）。
 * 用 zod 定义 MCP 工具名、参数 schema 与只读标记，同时被 MCP 注册与浏览器端校验复用。
 * 对外导出 API_VERSION、DOORS、tools、validateCommand。注意：这里只定义“能调什么”，
 * 具体执行仍需浏览器侧的命令处理器，且不提供通用 eval 或任意 JS 执行。
 */
import { z } from 'zod'

/** 控制接口版本号，随契约的不兼容变更递增。 */
export const API_VERSION = '1.0'
/** 车门逻辑名到车身定义中门 ID 的映射。 */
export const DOORS = { front_left: 'fl', front_right: 'fr', rear_left: 'rl', rear_right: 'rr' }
// 所有 id 类字段统一限长 1–160。
const id = z.string().min(1).max(160)
const session = { sessionId: id }
const scope = { ...session, sceneEpoch: id }
const entity = { ...scope, entityId: id }
const command = { ...entity, requestId: id }
// 等待时长（毫秒）：0–5000，默认 2000；超时返回 running 而非判为失败。
const waitMs = z.number().int().min(0).max(5000).default(2000)
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
// 把一个 shape 包装成 { description, shape, schema, readOnly }，默认只读。
const define = (description, shape, readOnly = true) => ({
  description,
  shape,
  schema: z.object(shape).strict(),
  readOnly,
})

// Shared by MCP registration and browser validation; adding a tool here still
// requires a browser domain handler. No generic eval or arbitrary JS command.
export const tools = {
  scene_list_sessions: define('列出已配对的浏览器场景。多页面时先选择 sessionId。', {}),
  scene_get_state: define(
    '读取场景摘要；返回地图、车型、时段、驾驶暂停、资源状态及同一帧相机信息。',
    session,
  ),
  scene_list_entities: define(
    '分页查询已加载业务对象，包含树、路灯、中国结的独立实例。坐标单位为米。',
    {
      ...scope,
      kind: z
        .enum([
          'vehicle',
          'character',
          'camera',
          'environment',
          'map',
          'tree',
          'lamp',
          'decoration',
        ])
        .optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
  ),
  scene_get_capabilities: define(
    '查询对象支持什么操作；unsupported 不等于当前关闭。门位相对车头定义。',
    entity,
  ),
  map_get_info: define('读取地图、路线用途、已生成长度及已加载路块。不触发无尽路线生成。', scope),
  camera_get_state: define('读取实际世界位置（米）、四元数 xyzw、前向、垂直FOV和追踪模式。', scope),
  entity_get_transform: define(
    '读取对象世界变换和包围盒。实例化对象按各实例计算；挂件返回固定挂点，非GPU丝线实时坐标。',
    entity,
  ),
  vehicle_set_door: define(
    '设置一扇门打开或关闭。需要停车且未执行上车流程；重复 requestId 返回原操作。暂停驾驶时仍可动画。',
    {
      ...command,
      door: z.enum(['front_left', 'front_right', 'rear_left', 'rear_right']),
      state: z.enum(['open', 'closed']),
      waitMs,
    },
    false,
  ),
  operation_get: define('查询业务操作结果。waitMs 超时返回 running，不把开始执行当作完成。', {
    ...scope,
    operationId: id,
    waitMs,
  }),
  camera_set_view: define(
    '以指定模型为中心切换左/右/前/后/俯视或聚焦视角；显式进入自由视角，不暂停车辆。',
    {
      ...command,
      preset: z.enum(['left', 'right', 'front', 'rear', 'top', 'focus']),
    },
    false,
  ),
  camera_set_pose: define(
    '精确设置相机位置和观察点（世界米制），进入自由视角；车辆行驶状态不变。',
    {
      ...scope,
      requestId: id,
      positionMeters: vector,
      lookAtMeters: vector,
      verticalFovDegrees: z.number().min(15).max(100).optional(),
    },
    false,
  ),
  simulation_set_paused: define(
    '暂停或恢复驾驶模拟。车门展示动画和环境继续更新。',
    {
      ...scope,
      requestId: id,
      paused: z.boolean(),
    },
    false,
  ),
  scene_capture: define('获取当前 Three.js 画布截图与同帧元数据；不改相机，不包含 DOM 设置/HUD。', {
    ...scope,
    width: z.number().int().min(128).max(1600).default(1000),
  }),
}

/**
 * 按工具名查表并用 zod 校验参数；未知工具抛 UNKNOWN_TOOL，参数不合法则抛出 zod 的校验错误。
 * @param name 工具名（须为 tools 的键）
 * @param args 待校验的参数对象
 */
export function validateCommand(name, args) {
  if (!Object.hasOwn(tools, name)) throw new Error('UNKNOWN_TOOL')
  return tools[name].schema.parse(args)
}
