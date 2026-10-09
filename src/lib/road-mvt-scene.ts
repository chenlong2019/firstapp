/**
 * /roads 页面的 Cesium 矢量瓦片(MVT)道路场景。
 *
 * 地球由 ./cesium-utils 初始化;Cesium 以全局脚本引入(全局名 `Cesium`,类型见 src/types/cesium.d.ts)。
 * 道路数据来自后端瓦片服务(MVT 瓦片 + 道路空间查询接口,地址见 VITE_MVT_URL)。
 *
 * 对外唯一入口是 RoadMvtScene:`RoadMvtScene.create()` 创建并等待瓦片加载完成,之后可点选道路
 * 聚焦、发起点/线/面空间查询、读取性能指标。
 *
 * 非直觉约定:道路点选与空间查询分页都用递增的 requestId 做失效判断 —— 用户快速连续操作时,
 * 过期响应必须丢弃,否则会覆盖最新状态。
 */

import { initializeCesium } from './cesium-utils'

type RoadGeometry =
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }

/**
 * 单条道路的属性与几何(字段名沿用 OSM / 瓦片服务的原始列名)。
 * fclass/code/name 等用于展示与分级,geometry 用于高亮与飞行定位。
 */
export interface RoadInfo {
  fid?: number
  osm_id?: string | number
  code?: string | number
  fclass?: string
  name?: string
  ref?: string
  oneway?: string
  maxspeed?: string | number
  layer?: string | number
  bridge?: string
  tunnel?: string
  geometry?: RoadGeometry
}

/** 空间查询类型:point=点选(邻域匹配)、line=沿线、polygon=面内检索 */
export type SpatialQueryType = 'point' | 'line' | 'polygon'

/**
 * 空间查询通过回调上报的状态事件:status 表示阶段(绘制/检索中/分页进度/完成/出错/取消);
 * progress 阶段会带 roads(本页增量)与 total(累计命中数),error 阶段带 message。
 */
export interface SpatialQueryEvent {
  type: SpatialQueryType
  status: 'drawing' | 'searching' | 'progress' | 'completed' | 'error' | 'cancelled'
  roads?: RoadInfo[]
  total?: number
  message?: string
}

/**
 * 道路瓦片样式:Cesium3DTileStyle 的 `conditions` 按 OSM `fclass` 分级配色与线宽,
 * 由主干道(亮橙、粗)到小路(米白、细)递减,末条 `true` 为兜底样式。
 */
const roadStyle = {
  color: {
    conditions: [
      ['${fclass} === "motorway" || ${fclass} === "motorway_link"', 'color("#e7863d")'],
      ['${fclass} === "trunk" || ${fclass} === "trunk_link"', 'color("#eea548")'],
      ['${fclass} === "primary" || ${fclass} === "primary_link"', 'color("#f3c45e")'],
      ['${fclass} === "secondary" || ${fclass} === "secondary_link"', 'color("#f2d99b")'],
      ['${fclass} === "tertiary" || ${fclass} === "tertiary_link"', 'color("#f7e9c5")'],
      [
        '${fclass} === "residential" || ${fclass} === "unclassified" || ${fclass} === "living_street"',
        'color("#fffaf0")',
      ],
      ['${fclass} === "service"', 'color("#f4f0e8")'],
      [
        '${fclass} === "footway" || ${fclass} === "path" || ${fclass} === "steps"',
        'color("#cfb487")',
      ],
      ['${fclass} === "cycleway"', 'color("#76b978")'],
      ['true', 'color("#e7e1d7")'],
    ],
  },
  lineWidth: {
    conditions: [
      ['${fclass} === "motorway" || ${fclass} === "motorway_link"', '4.2'],
      ['${fclass} === "trunk" || ${fclass} === "trunk_link"', '3.5'],
      ['${fclass} === "primary" || ${fclass} === "primary_link"', '3.0'],
      ['${fclass} === "secondary" || ${fclass} === "secondary_link"', '2.4'],
      ['${fclass} === "tertiary" || ${fclass} === "tertiary_link"', '1.9'],
      [
        '${fclass} === "residential" || ${fclass} === "unclassified" || ${fclass} === "living_street"',
        '1.45',
      ],
      ['${fclass} === "service"', '1.1'],
      ['true', '1.0'],
    ],
  },
}

/**
 * MVT 道路场景控制器:持有 Cesium viewer,负责瓦片加载与样式、道路点选高亮、
 * 点/线/面空间查询的绘制与分页请求,以及 FPS/已加载线数等性能指标。
 * 实例用静态工厂 `create` 产出(构造函数私有,因为创建后必须等待瓦片加载完成)。
 */
export class RoadMvtScene {
  viewer: Cesium.Viewer
  private roadTiles: any
  private readonly onRoadSelected?: (road: RoadInfo | null) => void
  private readonly onSpatialQuery?: (event: SpatialQueryEvent) => void
  private readonly tileServer = import.meta.env.VITE_MVT_URL ?? 'http://127.0.0.1:3001'
  private readonly loadedTiles = new Map<any, number>()
  private loadedLineCount = 0
  private fps = 0
  private frameCount = 0
  private fpsStartTime = performance.now()
  private removeTileLoadListener?: () => void
  private removeTileUnloadListener?: () => void
  private removePostRenderListener?: () => void
  private screenSpaceHandler: any
  private highlightEntity: any
  private drawingEntity: any
  private drawingPreviewEntity: any
  private drawingPreviewPoint: any
  private drawingVertexEntities: any[] = []
  private defaultDoubleClickAction?: (movement: any) => void
  private queryPointEntity: any
  private spatialQueryType?: SpatialQueryType
  private drawingPoints: any[] = []
  private drawingCoordinates: Array<[number, number]> = []
  private spatialResultEntities: any[] = []
  private selectionRequestId = 0
  private spatialQueryRequestId = 0
  private spatialQueryController?: AbortController

  private constructor(
    container: HTMLElement,
    onRoadSelected?: (road: RoadInfo | null) => void,
    onSpatialQuery?: (event: SpatialQueryEvent) => void,
  ) {
    this.onRoadSelected = onRoadSelected
    this.onSpatialQuery = onSpatialQuery
    this.viewer = initializeCesium(container)
    this.setupPicking()
  }

  static async create(
    container: HTMLElement,
    onRoadSelected?: (road: RoadInfo | null) => void,
    onSpatialQuery?: (event: SpatialQueryEvent) => void,
  ): Promise<RoadMvtScene> {
    const scene = new RoadMvtScene(container, onRoadSelected, onSpatialQuery)
    await scene.loadRoadTiles()
    return scene
  }

  private async loadRoadTiles(): Promise<void> {
    const cesium = Cesium as any
    // 数据覆盖范围(西, 南, 东, 北),约为北京及周边;瓦片请求与相机初定位都用它
    const rectangle = cesium.Rectangle.fromDegrees(115.89, 39.45, 116.94, 40.25)

    const provider = await cesium.MVTDataProvider.fromUrl(
      `${this.tileServer}/tiles/roads/{z}/{x}/{y}.pbf`,
      {
        minZoom: 0,
        maxZoom: 14,
        extent: rectangle,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        scene: this.viewer.scene,
      },
    )

    const tileset = provider.tileset
    tileset.style = new cesium.Cesium3DTileStyle(roadStyle)
    // 屏幕空间误差阈值:数值越大越早使用低精度层级、越省性能(道路场景以性能优先)
    tileset.maximumScreenSpaceError = 32
    tileset.preloadAncestors = false
    tileset.preloadSiblings = false
    tileset.skipLevelOfDetail = true
    tileset.dynamicScreenSpaceError = true
    tileset.dynamicScreenSpaceErrorFactor = 32
    tileset.progressiveResolutionHeightFraction = 0.3
    tileset.foveatedScreenSpaceError = true
    // 注视点瓦片加载的时间延迟,单位秒(配合上面的 foveatedScreenSpaceError)
    tileset.foveatedTimeDelay = 0.1
    this.removeTileLoadListener = tileset.tileLoad.addEventListener((tile: any) => {
      const featureCount = Number(tile.content?.featuresLength ?? 0)
      if (this.loadedTiles.has(tile)) return
      this.loadedTiles.set(tile, featureCount)
      this.loadedLineCount += featureCount
    })
    this.removeTileUnloadListener = tileset.tileUnload.addEventListener((tile: any) => {
      const featureCount = this.loadedTiles.get(tile)
      if (featureCount === undefined) return
      this.loadedTiles.delete(tile)
      this.loadedLineCount = Math.max(0, this.loadedLineCount - featureCount)
    })
    this.removePostRenderListener = this.viewer.scene.postRender.addEventListener(() => {
      this.frameCount += 1
      const now = performance.now()
      const elapsed = now - this.fpsStartTime
      // 累计到约 500ms 才刷新一次 FPS,避免每帧都更新导致读数抖动
      if (elapsed >= 500) {
        this.fps = Math.round((this.frameCount * 1000) / elapsed)
        this.frameCount = 0
        this.fpsStartTime = now
      }
    })

    this.roadTiles = this.viewer.scene.primitives.add(provider)
    this.viewer.camera.flyTo({
      destination: rectangle,
      duration: 0.8,
    })
  }

  /** 读取性能指标:fps 为最近一次约 500ms 窗口的采样值,loadedLineCount 为当前已加载瓦片的要素总数 */
  getMetrics(): { fps: number; loadedLineCount: number } {
    return {
      fps: this.fps,
      loadedLineCount: this.loadedLineCount,
    }
  }

  /** 清除道路高亮并回调 road=null;同时作废进行中的点选请求,避免旧结果晚到又高亮回来 */
  clearSelection(): void {
    this.selectionRequestId += 1
    this.clearHighlight()
    this.onRoadSelected?.(null)
  }

  /** 从外部(如搜索结果)聚焦某条道路:高亮其几何并飞过去;无几何时只回调、不飞行 */
  focusRoad(road: RoadInfo): void {
    this.selectionRequestId += 1
    this.clearHighlight()
    if (!road.geometry) {
      this.onRoadSelected?.(road)
      return
    }

    this.showHighlight(road.geometry)
    this.onRoadSelected?.(road)
    this.flyToRoad(road.geometry)
  }

  /** 进入空间查询绘制态:point 点一下即出结果;line/polygon 需多次点击绘制、双击结束 */
  startSpatialQuery(type: SpatialQueryType): void {
    this.cancelSpatialQuery(false)
    this.clearSpatialResultEntities()
    this.spatialQueryRequestId += 1
    this.spatialQueryType = type
    this.drawingPoints = []
    this.drawingCoordinates = []
    if (type !== 'point') {
      this.drawingEntity = this.viewer.entities.add(this.createDrawingEntity(type))
      const cesium = Cesium as any
      this.drawingPreviewEntity = this.viewer.entities.add({
        name: '空间查询预览线',
        polyline: {
          positions: new cesium.CallbackProperty(() => this.getDrawingPreviewPositions(), false),
          width: 3,
          material: new cesium.PolylineDashMaterialProperty({
            color: cesium.Color.fromCssColorString('#e53935'),
            dashLength: 16,
          }),
          clampToGround: true,
          zIndex: 100,
        },
      })
      this.defaultDoubleClickAction = this.viewer.screenSpaceEventHandler.getInputAction(
        cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      )
      this.viewer.screenSpaceEventHandler.removeInputAction(
        cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      )
    }
    this.onSpatialQuery?.({ type, status: 'drawing' })
  }

  /**
   * 取消/清理当前空间查询:中断请求、移除绘制实体、还原被拦截的双击动作。
   * @param notify 是否向回调上报 cancelled(内部清理时传 false,避免误报)
   */
  cancelSpatialQuery(notify = true): void {
    const type = this.spatialQueryType
    this.spatialQueryRequestId += 1
    this.spatialQueryController?.abort()
    this.spatialQueryController = undefined
    this.spatialQueryType = undefined
    this.drawingPoints = []
    this.drawingCoordinates = []
    this.removeDrawingPreview()
    this.restoreDoubleClickAction()
    this.removeDrawingEntity()
    this.removeQueryPointEntity()
    if (notify && type) {
      this.onSpatialQuery?.({ type, status: 'cancelled' })
    }
  }

  /** 取消进行中的查询并清掉已有结果图层(页面清除查询结果时调用) */
  clearSpatialQuery(): void {
    this.cancelSpatialQuery(false)
    this.clearSpatialResultEntities()
  }

  /** 释放全部监听与实体并销毁 viewer,页面卸载时调用 */
  destroy(): void {
    this.removeTileLoadListener?.()
    this.removeTileUnloadListener?.()
    this.removePostRenderListener?.()
    this.screenSpaceHandler?.destroy()
    this.clearHighlight()
    this.cancelSpatialQuery(false)
    this.clearSpatialResultEntities()
    this.loadedTiles.clear()
    if (!this.viewer.isDestroyed()) {
      this.viewer.destroy()
    }
  }

  private setupPicking(): void {
    const cesium = Cesium as any
    this.screenSpaceHandler = new cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)
    this.screenSpaceHandler.setInputAction((movement: any) => {
      if (this.spatialQueryType) {
        this.handleSpatialClick(movement.position)
        return
      }
      void this.selectNearestRoad(movement.position)
    }, cesium.ScreenSpaceEventType.LEFT_CLICK)
    this.screenSpaceHandler.setInputAction(() => {
      if (this.spatialQueryType && this.spatialQueryType !== 'point') {
        void this.finishSpatialQuery()
      }
    }, cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    this.screenSpaceHandler.setInputAction(() => {
      if (this.spatialQueryType) {
        this.cancelSpatialQuery()
      }
    }, cesium.ScreenSpaceEventType.RIGHT_CLICK)
    this.screenSpaceHandler.setInputAction((movement: any) => {
      if (
        !this.spatialQueryType ||
        this.spatialQueryType === 'point' ||
        !this.drawingPoints.length
      ) {
        return
      }
      this.drawingPreviewPoint = this.pickMapCoordinate(movement.endPosition)?.cartesian
      this.viewer.scene.requestRender()
    }, cesium.ScreenSpaceEventType.MOUSE_MOVE)
  }

  private handleSpatialClick(position: any): void {
    const picked = this.pickMapCoordinate(position)
    if (!picked || !this.spatialQueryType) return

    const cesium = Cesium as any
    const lastPoint = this.drawingPoints[this.drawingPoints.length - 1]
    // 0.1 米:忽略与上一点几乎重合的点击,避免连出零长线段
    if (lastPoint && cesium.Cartesian3.distance(lastPoint, picked.cartesian) < 0.1) return

    this.drawingPoints.push(picked.cartesian)
    this.drawingCoordinates.push(picked.coordinate)
    if (this.spatialQueryType === 'point') {
      this.showQueryPoint(picked.cartesian)
      void this.finishSpatialQuery()
      return
    }
    this.drawingPreviewPoint = undefined
    this.drawingVertexEntities.push(
      this.viewer.entities.add({
        name: '空间查询节点',
        position: picked.cartesian,
        point: {
          pixelSize: 9,
          color: cesium.Color.fromCssColorString('#e53935'),
          outlineColor: cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    )
    this.updateDrawingEntity()
  }

  private pickMapCoordinate(
    position: any,
  ): { cartesian: any; coordinate: [number, number] } | null {
    const cesium = Cesium as any
    const ray = this.viewer.camera.getPickRay(position)
    const terrainPosition = ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined
    const cartesian =
      terrainPosition ??
      this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid)
    if (!cartesian) return null

    const cartographic = cesium.Cartographic.fromCartesian(cartesian)
    return {
      cartesian,
      coordinate: [
        cesium.Math.toDegrees(cartographic.longitude),
        cesium.Math.toDegrees(cartographic.latitude),
      ],
    }
  }

  private async finishSpatialQuery(): Promise<void> {
    const type = this.spatialQueryType
    if (!type) return
    if (
      (type === 'line' && this.drawingCoordinates.length < 2) ||
      (type === 'polygon' && this.drawingCoordinates.length < 3)
    ) {
      return
    }

    const requestId = ++this.spatialQueryRequestId
    const geometry = this.createSpatialGeometry(type)
    this.updateDrawingEntity()
    this.spatialQueryType = undefined
    this.removeDrawingPreview()
    this.restoreDoubleClickAction()
    this.onSpatialQuery?.({ type, status: 'searching' })

    const controller = new AbortController()
    this.spatialQueryController = controller
    try {
      let offset = 0
      let hasMore = true
      let total = 0
      while (hasMore) {
        const response = await fetch(`${this.tileServer}/roads/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            geometry,
            offset,
            // 每页 200 条,循环翻页直到服务端返回 hasMore=false
            limit: 200,
            // 传给后端的容差半径(米),用于点查询的邻域匹配
            pointToleranceMeters: 150,
          }),
        })
        if (requestId !== this.spatialQueryRequestId) return
        if (!response.ok) {
          throw new Error(`Spatial road query failed with status ${response.status}`)
        }

        const payload = (await response.json()) as {
          results: RoadInfo[]
          total: number
          hasMore: boolean
        }
        if (requestId !== this.spatialQueryRequestId) return
        if (
          !Array.isArray(payload.results) ||
          !Number.isInteger(payload.total) ||
          typeof payload.hasMore !== 'boolean' ||
          (payload.hasMore && payload.results.length === 0)
        ) {
          throw new Error('Invalid spatial query page')
        }
        total = payload.total
        hasMore = payload.hasMore
        offset += payload.results.length
        this.appendSpatialResults(payload.results)
        this.onSpatialQuery?.({ type, status: 'progress', roads: payload.results, total })
      }
      this.onSpatialQuery?.({ type, status: 'completed', total })
    } catch (error) {
      if (requestId === this.spatialQueryRequestId) {
        console.error('Spatial road query failed', error)
        this.onSpatialQuery?.({
          type,
          status: 'error',
          message: '空间查询失败，请确认道路服务已启动',
        })
      }
    } finally {
      if (this.spatialQueryController === controller) {
        this.spatialQueryController = undefined
      }
    }
  }

  private createSpatialGeometry(type: SpatialQueryType): Record<string, unknown> {
    if (type === 'point') {
      return { type: 'Point', coordinates: this.drawingCoordinates[0] }
    }
    if (type === 'line') {
      return { type: 'LineString', coordinates: this.getQueryPathCoordinates() }
    }

    return { type: 'Polygon', coordinates: [this.getQueryPathCoordinates(true)] }
  }

  private getQueryPathCoordinates(closeRing = false): Array<[number, number]> {
    const cesium = Cesium as any
    const vertices = [...this.drawingCoordinates]
    const firstCoordinate = vertices[0]
    if (!firstCoordinate) return []
    if (closeRing) vertices.push(firstCoordinate)
    const coordinates: Array<[number, number]> = [firstCoordinate]
    for (let vertexIndex = 1; vertexIndex < vertices.length; vertexIndex += 1) {
      const start = vertices[vertexIndex - 1]!
      const end = vertices[vertexIndex]!
      if (start[0] === end[0] && start[1] === end[1]) continue
      const arc = new cesium.EllipsoidGeodesic(
        cesium.Cartographic.fromDegrees(...start),
        cesium.Cartographic.fromDegrees(...end),
      )
      // 每条边按每约 500 米插一个点:大圆测地线本身是曲线,长边必须加密才贴合地表
      const steps = Math.max(1, Math.ceil(arc.surfaceDistance / 500))
      for (let step = 1; step < steps; step += 1) {
        const point = arc.interpolateUsingFraction(step / steps)
        coordinates.push([
          cesium.Math.toDegrees(point.longitude),
          cesium.Math.toDegrees(point.latitude),
        ])
      }
      coordinates.push(end)
    }
    return coordinates
  }

  private createDrawingEntity(type: SpatialQueryType): Record<string, unknown> {
    const cesium = Cesium as any
    const line = {
      positions: [],
      width: 4,
      material: cesium.Color.fromCssColorString('#e53935'),
      clampToGround: true,
      zIndex: 100,
    }
    if (type === 'polygon') {
      return {
        name: '空间查询面',
        polyline: line,
        polygon: {
          show: false,
          material: cesium.Color.fromCssColorString('#e53935').withAlpha(0.18),
          classificationType: cesium.ClassificationType.TERRAIN,
        },
      }
    }
    return { name: '空间查询线', polyline: line }
  }

  private updateDrawingEntity(): void {
    if (!this.drawingEntity) return
    const cesium = Cesium as any
    const isPolygon = this.drawingEntity.polygon && this.drawingPoints.length >= 3
    const positions = cesium.Cartesian3.fromDegreesArray(
      this.getQueryPathCoordinates(Boolean(isPolygon)).flat(),
    )
    if (isPolygon) {
      this.drawingEntity.polygon.hierarchy = new cesium.PolygonHierarchy(positions.slice(0, -1))
      this.drawingEntity.polygon.show = true
      this.drawingEntity.polyline.positions = positions
    } else {
      this.drawingEntity.polyline.positions = positions.length >= 2 ? positions : []
    }
    this.viewer.scene.requestRender()
  }

  private getDrawingPreviewPositions(): any[] {
    const lastPoint = this.drawingPoints[this.drawingPoints.length - 1]
    if (!lastPoint || !this.drawingPreviewPoint) return []
    const positions = [lastPoint, this.drawingPreviewPoint]
    if (this.spatialQueryType === 'polygon' && this.drawingPoints.length >= 2) {
      positions.push(this.drawingPoints[0])
    }
    return positions
  }

  private removeDrawingPreview(): void {
    if (this.drawingPreviewEntity) {
      this.viewer.entities.remove(this.drawingPreviewEntity)
      this.drawingPreviewEntity = undefined
    }
    this.drawingPreviewPoint = undefined
    this.viewer.scene.requestRender()
  }

  private restoreDoubleClickAction(): void {
    if (!this.defaultDoubleClickAction) return
    this.viewer.screenSpaceEventHandler.setInputAction(
      this.defaultDoubleClickAction,
      (Cesium as any).ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    )
    this.defaultDoubleClickAction = undefined
  }

  private async selectNearestRoad(position: any): Promise<void> {
    const cesium = Cesium as any
    const requestId = ++this.selectionRequestId
    this.clearHighlight()
    this.onRoadSelected?.(null)

    const cartesian = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid)
    if (!cartesian) return

    const cartographic = cesium.Cartographic.fromCartesian(cartesian)
    const longitude = cesium.Math.toDegrees(cartographic.longitude)
    const latitude = cesium.Math.toDegrees(cartographic.latitude)

    try {
      const response = await fetch(
        `${this.tileServer}/roads/nearest?lon=${longitude}&lat=${latitude}`,
      )
      if (!response.ok || requestId !== this.selectionRequestId) return

      const road = (await response.json()) as RoadInfo
      if (!road.geometry || requestId !== this.selectionRequestId) return
      this.showRoadSelection(road)
    } catch (error) {
      console.error('Road selection failed', error)
    }
  }

  private showHighlight(geometry: RoadGeometry): void {
    const cesium = Cesium as any
    const coordinates =
      geometry.type === 'MultiLineString' ? (geometry.coordinates[0] ?? []) : geometry.coordinates
    const coordinatePairs = coordinates.flatMap((coordinate) => {
      const longitude = coordinate[0]
      const latitude = coordinate[1]
      return typeof longitude === 'number' && typeof latitude === 'number'
        ? [longitude, latitude]
        : []
    })
    // 凑不满两个点(每点经度+纬度共 2 个数,合计 4 个数)就画不成线
    if (coordinatePairs.length < 4) return
    const positions = cesium.Cartesian3.fromDegreesArray(coordinatePairs)
    this.highlightEntity = this.viewer.entities.add({
      polyline: {
        positions,
        width: 8,
        material: cesium.Color.fromCssColorString('#3385ff'),
        clampToGround: true,
      },
    })
  }

  private appendSpatialResults(roads: RoadInfo[]): void {
    const cesium = Cesium as any
    this.viewer.entities.suspendEvents()
    try {
      for (const road of roads) {
        if (!road.geometry) continue
        const coordinateGroups =
          road.geometry.type === 'MultiLineString'
            ? road.geometry.coordinates
            : [road.geometry.coordinates]
        for (const coordinates of coordinateGroups) {
          const coordinatePairs = coordinates.flatMap((coordinate) => {
            const longitude = coordinate[0]
            const latitude = coordinate[1]
            return typeof longitude === 'number' && typeof latitude === 'number'
              ? [longitude, latitude]
              : []
          })
          // 少于两个点无法成线(判据与 showHighlight 一致)
          if (coordinatePairs.length < 4) continue
          this.spatialResultEntities.push(
            this.viewer.entities.add({
              polyline: {
                positions: cesium.Cartesian3.fromDegreesArray(coordinatePairs),
                width: 6,
                material: cesium.Color.fromCssColorString('#3385ff').withAlpha(0.72),
                clampToGround: true,
              },
            }),
          )
        }
      }
    } finally {
      this.viewer.entities.resumeEvents()
      this.viewer.scene.requestRender()
    }
  }

  private showRoadSelection(road: RoadInfo): void {
    if (!road.geometry) return
    this.showHighlight(road.geometry)
    this.onRoadSelected?.(road)
  }

  private flyToRoad(geometry: RoadGeometry): void {
    const cesium = Cesium as any
    const coordinateGroups =
      geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates]
    const coordinates = coordinateGroups.flat()
    const validCoordinates: Array<[number, number]> = []
    for (const coordinate of coordinates) {
      const longitude = coordinate[0]
      const latitude = coordinate[1]
      if (typeof longitude === 'number' && typeof latitude === 'number') {
        validCoordinates.push([longitude, latitude])
      }
    }
    if (validCoordinates.length === 0) return

    const longitudes = validCoordinates.map((coordinate) => coordinate[0])
    const latitudes = validCoordinates.map((coordinate) => coordinate[1])
    const west = Math.min(...longitudes)
    const east = Math.max(...longitudes)
    const south = Math.min(...latitudes)
    const north = Math.max(...latitudes)
    // 视野外扩 25% 留边;0.002 度(约 200 米)是短道路的最小外扩量,避免贴边
    const longitudePadding = Math.max((east - west) * 0.25, 0.002)
    const latitudePadding = Math.max((north - south) * 0.25, 0.002)

    this.viewer.camera.flyTo({
      destination: cesium.Rectangle.fromDegrees(
        west - longitudePadding,
        south - latitudePadding,
        east + longitudePadding,
        north + latitudePadding,
      ),
      duration: 0.8,
    })
  }

  private clearHighlight(): void {
    if (!this.highlightEntity) return
    this.viewer.entities.remove(this.highlightEntity)
    this.highlightEntity = undefined
  }

  private removeDrawingEntity(): void {
    if (this.drawingEntity) {
      this.viewer.entities.remove(this.drawingEntity)
      this.drawingEntity = undefined
    }
    for (const entity of this.drawingVertexEntities) {
      this.viewer.entities.remove(entity)
    }
    this.drawingVertexEntities = []
    this.viewer.scene.requestRender()
  }

  private showQueryPoint(position: any): void {
    const cesium = Cesium as any
    this.removeQueryPointEntity()
    this.queryPointEntity = this.viewer.entities.add({
      name: '空间查询点',
      position,
      point: {
        pixelSize: 14,
        color: cesium.Color.fromCssColorString('#e53935'),
        outlineColor: cesium.Color.WHITE,
        outlineWidth: 3,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '查询点',
        font: '14px sans-serif',
        fillColor: cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: cesium.Color.fromCssColorString('#a32626').withAlpha(0.9),
        pixelOffset: new cesium.Cartesian2(0, -28),
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    this.viewer.scene.requestRender()
  }

  private removeQueryPointEntity(): void {
    if (!this.queryPointEntity) return
    this.viewer.entities.remove(this.queryPointEntity)
    this.queryPointEntity = undefined
    this.viewer.scene.requestRender()
  }

  private clearSpatialResultEntities(): void {
    for (const entity of this.spatialResultEntities) {
      this.viewer.entities.remove(entity)
    }
    this.spatialResultEntities = []
  }
}
