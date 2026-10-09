/**
 * 场景控制契约的实现（control）：把宿主场景（地图/车辆/相机/角色等）封装成一组可由外部
 * （MCP/调试）调用的命令处理器，入口是 createSceneControl 返回的 handle。
 * 对外导出 createSceneControl。命令 schema 与常量来自 shared/scene-control/contracts.js，
 * 每条命令都校验 sessionId/sceneEpoch（页面重载或跨会话会被拒绝）。
 * 约定：对外位置一律用米，角度为弧度（fov 为度）；耗时的车门动画走 operations 异步状态机。
 */
import * as T from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { RaceMap } from '../race/maps/types'
import type { CarRig } from '../race/car/loadCar'
import type { CarBody } from '../race/car/body'
import type { Vehicle } from '../race/car/vehicle'
import type { Boarding } from '../race/character/boarding'
import type { DoorId } from '../race/car/definition'
import { UNITS_PER_METRE } from '../units'
import { DOORS, validateCommand, API_VERSION } from '../shared/scene-control/contracts.js'
import { ControlError, Operations } from './operations'

type Host = {
  scene: T.Scene
  map: RaceMap
  camera: T.PerspectiveCamera
  controls: OrbitControls
  renderer: T.WebGLRenderer
  rig(): CarRig | null
  body(): CarBody | null
  vehicle(): Vehicle | null
  boarding(): Boarding | null
  car: { id: string; label: string }
  paused(): boolean
  pause(value: boolean): void
  cameraMode(): string
  freeCamera(): void
  time(): string
  syncDoors(): void
  render(): void
}
type Entity = {
  id: string
  kind: string
  label: string
  object: T.Object3D
  matrix?: T.Matrix4
  bounds?: T.Box3
  poseBasis?: string
}
// 对外坐标统一四舍五入到 6 位小数，作为米制输出的精度约定。
const meters = (v: T.Vector3) => v.toArray().map((x) => Number(x.toFixed(6)))

/**
 * 用宿主接口创建一个场景控制会话，返回可处理命令的 handle。
 * @param host 宿主提供的场景与开关读写回调（见 Host 类型）；命令处理器只经这些回调操作场景
 */
export function createSceneControl(host: Host) {
  const sessionId = `preview-${crypto.randomUUID()}`
  const sceneEpoch = crypto.randomUUID()
  const operations = new Operations()
  let frameId = 0
  const snapshot = () => ({
    apiVersion: API_VERSION,
    sessionId,
    sceneEpoch,
    snapshotId: crypto.randomUUID(),
    frameId,
    stateRevision: operations.stateRevision,
    observedAt: new Date().toISOString(),
    stale: false,
  })
  const ready = () => !!(host.rig() && host.body() && host.vehicle())
  const boarding = () => host.boarding()?.state().running === true
  const doors = () => {
    const body = host.body(),
      state = body?.state()
    return Object.entries(DOORS).map(([name, id]) => ({
      door: name,
      supported: !!body?.doorIds().includes(id as DoorId),
      currentFraction: state?.doors[id as DoorId] ?? null,
      target: state?.doorTargets[id as DoorId] ? 'open' : 'closed',
    }))
  }
  const cameraState = () => {
    host.camera.updateWorldMatrix(true, false)
    const eye = host.camera.getWorldPosition(new T.Vector3()),
      q = host.camera.getWorldQuaternion(new T.Quaternion())
    return {
      cameraId: 'camera.main',
      type: 'perspective',
      mode: host.cameraMode(),
      coordinateFrame: 'world',
      positionMeters: meters(eye),
      quaternion: q.toArray(),
      forward: host.camera.getWorldDirection(new T.Vector3()).toArray(),
      up: new T.Vector3(0, 1, 0).applyQuaternion(q).toArray(),
      focusPointMeters: host.cameraMode() === 'free' ? meters(host.controls.target) : null,
      focusEntityId: host.cameraMode() === 'chase' ? 'vehicle.player' : null,
      verticalFovDegrees: host.camera.fov,
      aspect: host.camera.aspect,
      nearMeters: host.camera.near,
      farMeters: host.camera.far,
      viewportCssPixels: [
        host.renderer.domElement.clientWidth,
        host.renderer.domElement.clientHeight,
      ],
      drawingBufferPixels: [host.renderer.domElement.width, host.renderer.domElement.height],
      devicePixelRatio: host.renderer.getPixelRatio(),
    }
  }
  const mapInfo = () => {
    const map = host.map
    const chunks = map.visual.children
      .filter((o) => o.name.startsWith('road-chunk-'))
      // 'road-chunk-' 前缀长度为 11，切掉后取路块索引。
      .map((o) => Number(o.name.slice(11)))
      .sort((a, b) => a - b)
    const chunkLength = Number(map.visual.userData.chunkLengthMetres ?? 0)
    return {
      mapId: map.id,
      name: map.name,
      closed: map.closed,
      seed: map.generator?.seed ?? null,
      sceneUnitsPerMeter: UNITS_PER_METRE,
      coordinateSystem: 'right-handed,Y-up',
      originMeters: meters(map.origin),
      routeId: `${map.id}.driving`,
      routePurpose: 'driving',
      decorationRouteId: map.id === 'endless' ? null : `${map.id}.road_geometry`,
      totalLengthMeters: map.id === 'endless' ? null : map.centreline.length,
      generatedLengthMeters: map.centreline.length,
      surfaceHeightMeters: map.surfaceY,
      drivableLateralMeters: [map.lateralMin, map.lateralMax],
      loadedRouteIntervalMeters: chunks.length
        ? [chunks[0] * chunkLength, (chunks[chunks.length - 1] + 1) * chunkLength]
        : [0, map.centreline.length],
      startDistanceMeters: map.startDistance,
      notes:
        map.id === 'circuit'
          ? '装饰沿桥梁中心线，驾驶路线沿双侧车道往返；两者里程不可混用。'
          : null,
    }
  }
  const entities = (): Entity[] => {
    host.scene.updateMatrixWorld(true)
    const rows: Entity[] = [
      { id: 'map.current', kind: 'map', label: host.map.name, object: host.map.visual },
      { id: 'camera.main', kind: 'camera', label: '主相机', object: host.camera },
    ]
    const env = host.scene.getObjectByName('water-sky-environment')
    if (env)
      rows.push({ id: 'environment.main', kind: 'environment', label: '水天环境', object: env })
    if (host.rig())
      rows.push({
        id: 'vehicle.player',
        kind: 'vehicle',
        label: host.car.label,
        object: host.rig()!.root,
      })
    const person = host.scene.getObjectByName('boarding-character')
    if (person && host.boarding()?.loaded())
      rows.push({ id: 'character.driver', kind: 'character', label: '驾驶员', object: person })
    const drone = host.scene.getObjectByName('dji-air-drone')
    if (drone?.userData.drone?.status === 'ready')
      rows.push({ id: 'decoration.drone', kind: 'decoration', label: '大疆无人机', object: drone })
    host.map.visual.traverse((object) => {
      const descriptors = object.userData.controlInstances as
        { id: string; kind: string; matrix: T.Matrix4; bounds?: T.Box3 }[] | undefined
      if (!descriptors) return
      for (const entry of descriptors) {
        const matrix = new T.Matrix4().multiplyMatrices(object.matrixWorld, entry.matrix)
        rows.push({
          id: `map.${host.map.id}.${entry.id}`,
          kind: entry.kind,
          label: entry.id,
          object,
          matrix,
          bounds: entry.bounds?.clone().applyMatrix4(matrix),
          poseBasis: 'rest_anchor',
        })
      }
    })
    return rows
  }
  const entity = (id: string) => {
    const found = entities().find((e) => e.id === id)
    if (!found) throw new ControlError('ENTITY_NOT_FOUND', `未找到对象 ${id}`)
    return found
  }
  const transform = (e: Entity) => {
    e.object.updateWorldMatrix(true, false)
    const matrix = e.matrix ?? e.object.matrixWorld
    const position = new T.Vector3(),
      rotation = new T.Quaternion(),
      scale = new T.Vector3()
    matrix.decompose(position, rotation, scale)
    let box: T.Box3 | null = e.bounds ?? null
    if (e.matrix) {
      const mesh = e.object as T.Mesh
      if (mesh.geometry) {
        mesh.geometry.computeBoundingBox()
        box = mesh.geometry.boundingBox!.clone().applyMatrix4(matrix)
      }
    } else if (e.kind !== 'camera' && e.kind !== 'environment')
      box = new T.Box3().setFromObject(e.object)
    return {
      entityId: e.id,
      kind: e.kind,
      label: e.label,
      coordinateFrame: 'world',
      poseBasis: e.poseBasis ?? 'object_origin',
      transform: {
        positionMeters: meters(position),
        quaternion: rotation.toArray(),
        scale: scale.toArray(),
      },
      bounds:
        box && !box.isEmpty()
          ? {
              type: 'aabb',
              minMeters: meters(box.min),
              maxMeters: meters(box.max),
              accuracy: 'conservative',
            }
          : null,
      deformation: e.kind === 'decoration' && e.matrix ? 'gpu_animated' : null,
      enabled: e.object.visible,
      occlusion: 'unknown',
    }
  }
  const capabilities = (id: string) => {
    const e = entity(id)
    return {
      entityId: id,
      kind: e.kind,
      capabilities:
        e.kind === 'vehicle'
          ? [
              {
                id: 'vehicle.door.set',
                tool: 'vehicle_set_door',
                supported: !!host.body()?.doorIds().length,
                available:
                  !!host.body()?.doorIds().length &&
                  ready() &&
                  !boarding() &&
                  // 0.1 米/秒的速度阈值：低于它才视为停车，车门方可动作。
                  Math.abs(host.vehicle()?.state.speed ?? 0) < 0.1,
                reasonCode: !host.body()?.doorIds().length
                  ? 'MODEL_PART_UNAVAILABLE'
                  : boarding()
                    ? 'CONTROL_BUSY'
                    : Math.abs(host.vehicle()?.state.speed ?? 0) >= 0.1
                      ? 'VEHICLE_MOVING'
                      : null,
                doors: doors(),
                preconditions: ['vehicle_stationary', 'door_not_owned_by_boarding'],
                effects: ['door_animation', 'settings_panel_sync'],
              },
            ]
          : [{ id: 'entity.inspect', supported: true, available: true }],
      cameraPresets: ['left', 'right', 'front', 'rear', 'top', 'focus'],
    }
  }
  const state = () => ({
    ...snapshot(),
    ready: ready(),
    map: mapInfo(),
    vehicle: host.vehicle()
      ? {
          entityId: 'vehicle.player',
          modelId: host.car.id,
          label: host.car.label,
          // 内部速度单位为米/秒，对外统一换算成千米/小时。
          speedKmh: host.vehicle()!.state.speed * 3.6,
          positionMeters: meters(host.vehicle()!.state.position),
          doors: doors(),
        }
      : null,
    drivingPaused: host.paused(),
    timeOfDay: host.time(),
    camera: cameraState(),
    resources: {
      vehicle: ready() ? 'ready' : 'loading',
      character: host.boarding()?.loaded() ? 'ready' : 'loading',
      trees:
        host.map.visual.getObjectByName('median-trees')?.userData.vegetation?.status ??
        'not_applicable',
      lamps:
        host.map.visual.getObjectByName('median-street-lamps')?.userData.lamps?.status ??
        'not_applicable',
    },
  })
  const setCamera = (position: T.Vector3, target: T.Vector3, fov?: number) => {
    if (boarding()) throw new ControlError('CONTROL_BUSY', '上车流程正在控制镜头。')
    // 位置与观察点相距不足 0.01 米时无法定向，视为非法参数。
    if (position.distanceTo(target) < 0.01)
      throw new ControlError('INVALID_ARGUMENT', '相机位置与观察点不能重合。')
    host.freeCamera()
    const damping = host.controls.enableDamping
    host.controls.enableDamping = false
    host.controls.update()
    host.camera.position.copy(position)
    host.controls.target.copy(target)
    // Use lookAt after clearing OrbitControls' previous motion; retain target for the next frame.
    host.camera.up.set(0, 1, 0)
    host.camera.lookAt(target)
    if (fov !== undefined) host.camera.fov = fov
    host.camera.updateProjectionMatrix()
    host.camera.updateMatrixWorld()
    host.controls.enableDamping = damping
    return { status: 'completed', effects: ['free_camera'], camera: cameraState() }
  }

  async function handle(name: string, input: any): Promise<any> {
    const a: any = validateCommand(name, input)
    if (a.sessionId !== sessionId)
      throw new ControlError('SESSION_DISCONNECTED', '该命令不属于此页面。')
    if (a.sceneEpoch && a.sceneEpoch !== sceneEpoch)
      throw new ControlError('STALE_SCENE', '页面已经重载，请重新读取会话。')
    if (name === 'scene_get_state') return state()
    let result: any
    if (name === 'map_get_info') result = mapInfo()
    else if (name === 'camera_get_state') result = cameraState()
    else if (name === 'scene_list_entities') {
      const rows = entities().filter((e) => !a.kind || e.kind === a.kind)
      result = {
        total: rows.length,
        items: rows.slice(a.offset, a.offset + a.limit).map((e) => {
          const p = new T.Vector3().setFromMatrixPosition(e.matrix ?? e.object.matrixWorld)
          return { entityId: e.id, kind: e.kind, label: e.label, positionMeters: meters(p) }
        }),
        nextOffset: a.offset + a.limit < rows.length ? a.offset + a.limit : null,
      }
    } else if (name === 'scene_get_capabilities') result = capabilities(a.entityId)
    else if (name === 'entity_get_transform') result = transform(entity(a.entityId))
    else if (name === 'operation_get')
      result = await operations.observe(operations.get(a.operationId), a.waitMs)
    else if (name === 'scene_capture') {
      host.render()
      const canvas = document.createElement('canvas')
      canvas.width = a.width
      canvas.height = Math.round(
        (a.width * host.renderer.domElement.height) / host.renderer.domElement.width,
      )
      canvas
        .getContext('2d')!
        .drawImage(host.renderer.domElement, 0, 0, canvas.width, canvas.height)
      result = {
        ...snapshot(),
        camera: cameraState(),
        width: canvas.width,
        height: canvas.height,
        includeUi: false,
        image: { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] },
      }
    } else {
      const { waitMs, requestId, ...fingerprint } = a
      const output = operations.execute(requestId, JSON.stringify({ name, ...fingerprint }), () => {
        if (!ready()) throw new ControlError('ASSET_NOT_READY', '车辆仍在载入。')
        if (name === 'simulation_set_paused') {
          if (boarding()) throw new ControlError('CONTROL_BUSY', '请等待上车流程完成。')
          host.pause(a.paused)
          return { status: 'completed', drivingPaused: host.paused(), effects: ['driving_pause'] }
        }
        if (name === 'vehicle_set_door') {
          if (a.entityId !== 'vehicle.player')
            throw new ControlError('UNSUPPORTED_CAPABILITY', '该对象不是可控制车辆。')
          const door = DOORS[a.door as keyof typeof DOORS] as DoorId,
            body = host.body()!
          if (!body.doorIds().includes(door))
            throw new ControlError('UNSUPPORTED_CAPABILITY', '当前车型不支持这扇车门。')
          if (boarding()) throw new ControlError('CONTROL_BUSY', '上车动作正在控制车门。')
          if (Math.abs(host.vehicle()!.state.speed) > 0.1)
            throw new ControlError('PRECONDITION_FAILED', '车辆需先停稳。')
          const target = a.state === 'open',
            before = body.state()
          const op = operations.start(
            `vehicle.player.door.${door}`,
            target,
            () => {
              const s = body.state()
              return {
                currentFraction: s.doors[door],
                target: s.doorTargets[door],
                blocked: boarding(),
              }
            },
            {
              entityId: a.entityId,
              door: a.door,
              target: a.state,
              currentFraction: before.doors[door],
              moving: true,
            },
          )
          body.setDoors({ [door]: target })
          host.syncDoors()
          if (Math.abs(before.doors[door] - Number(target)) < 0.01) {
            op.status = 'completed'
            op.changed = false
            op.observedState.moving = false
          }
          return op
        }
        if (name === 'camera_set_pose')
          return setCamera(
            new T.Vector3(...a.positionMeters),
            new T.Vector3(...a.lookAtMeters),
            a.verticalFovDegrees,
          )
        if (name === 'camera_set_view') {
          const e = entity(a.entityId),
            t = transform(e)
          const center = t.bounds
            ? new T.Vector3(...t.bounds.minMeters)
                .add(new T.Vector3(...t.bounds.maxMeters))
                .multiplyScalar(0.5)
            : new T.Vector3(...t.transform.positionMeters)
          const size = t.bounds
            ? new T.Vector3(...t.bounds.maxMeters)
                .sub(new T.Vector3(...t.bounds.minMeters))
                .length()
            : 8
          // 六个相机预设的世界方向向量（未归一化），稍后按包围盒尺寸缩放。
          const offsets: Record<string, number[]> = {
            left: [1, 0.25, 0],
            right: [-1, 0.25, 0],
            front: [0, 0.3, 1],
            rear: [0, 0.3, -1],
            top: [0, 1, 0.001],
            focus: [1, 0.4, 1],
          }
          const offset = new T.Vector3(...offsets[a.preset])
            .normalize()
            // 相机距离取包围盒对角长的 1.5 倍，并保底 6 米。
            .multiplyScalar(Math.max(size * 1.5, 6))
          if (e.kind === 'vehicle') offset.applyQuaternion(host.rig()!.root.quaternion)
          return setCamera(center.clone().add(offset), center)
        }
        throw new ControlError('UNKNOWN_TOOL', '未实现的操作。')
      })
      result = output.operationId ? await operations.observe(output, waitMs ?? 0) : output
      result = { ...result, requestId }
    }
    return {
      ...snapshot(),
      ...result,
      stateRevision: operations.stateRevision,
      frameId,
      observedAt: new Date().toISOString(),
    }
  }
  return {
    sessionId,
    sceneEpoch,
    handle,
    state,
    tick() {
      frameId++
      operations.tick()
    },
  }
}
