import { initializeCesium } from './cesium-utils'

type RoadGeometry =
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }

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

export type SpatialQueryType = 'point' | 'line' | 'polygon'

export interface SpatialQueryEvent {
  type: SpatialQueryType
  status: 'drawing' | 'searching' | 'progress' | 'completed' | 'error' | 'cancelled'
  roads?: RoadInfo[]
  total?: number
  message?: string
}

const roadStyle = {
  color: {
    conditions: [
      ['${fclass} === "motorway" || ${fclass} === "motorway_link"', 'color("#e7863d")'],
      ['${fclass} === "trunk" || ${fclass} === "trunk_link"', 'color("#eea548")'],
      ['${fclass} === "primary" || ${fclass} === "primary_link"', 'color("#f3c45e")'],
      ['${fclass} === "secondary" || ${fclass} === "secondary_link"', 'color("#f2d99b")'],
      ['${fclass} === "tertiary" || ${fclass} === "tertiary_link"', 'color("#f7e9c5")'],
      ['${fclass} === "residential" || ${fclass} === "unclassified" || ${fclass} === "living_street"', 'color("#fffaf0")'],
      ['${fclass} === "service"', 'color("#f4f0e8")'],
      ['${fclass} === "footway" || ${fclass} === "path" || ${fclass} === "steps"', 'color("#cfb487")'],
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
      ['${fclass} === "residential" || ${fclass} === "unclassified" || ${fclass} === "living_street"', '1.45'],
      ['${fclass} === "service"', '1.1'],
      ['true', '1.0'],
    ],
  },
}

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
    tileset.maximumScreenSpaceError = 32
    tileset.preloadAncestors = false
    tileset.preloadSiblings = false
    tileset.skipLevelOfDetail = true
    tileset.dynamicScreenSpaceError = true
    tileset.dynamicScreenSpaceErrorFactor = 32
    tileset.progressiveResolutionHeightFraction = 0.3
    tileset.foveatedScreenSpaceError = true
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

  getMetrics(): { fps: number; loadedLineCount: number } {
    return {
      fps: this.fps,
      loadedLineCount: this.loadedLineCount,
    }
  }

  clearSelection(): void {
    this.selectionRequestId += 1
    this.clearHighlight()
    this.onRoadSelected?.(null)
  }

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

  clearSpatialQuery(): void {
    this.cancelSpatialQuery(false)
    this.clearSpatialResultEntities()
  }

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
      if (!this.spatialQueryType || this.spatialQueryType === 'point' || !this.drawingPoints.length) {
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
    if (lastPoint && cesium.Cartesian3.distance(lastPoint, picked.cartesian) < 0.1) return

    this.drawingPoints.push(picked.cartesian)
    this.drawingCoordinates.push(picked.coordinate)
    if (this.spatialQueryType === 'point') {
      this.showQueryPoint(picked.cartesian)
      void this.finishSpatialQuery()
      return
    }
    this.drawingPreviewPoint = undefined
    this.drawingVertexEntities.push(this.viewer.entities.add({
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
    }))
    this.updateDrawingEntity()
  }

  private pickMapCoordinate(position: any): { cartesian: any; coordinate: [number, number] } | null {
    const cesium = Cesium as any
    const ray = this.viewer.camera.getPickRay(position)
    const terrainPosition = ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined
    const cartesian = terrainPosition ?? this.viewer.camera.pickEllipsoid(
      position,
      this.viewer.scene.globe.ellipsoid,
    )
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
    if ((type === 'line' && this.drawingCoordinates.length < 2)
      || (type === 'polygon' && this.drawingCoordinates.length < 3)) {
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
            limit: 200,
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
        if (!Array.isArray(payload.results) || !Number.isInteger(payload.total)
          || typeof payload.hasMore !== 'boolean'
          || (payload.hasMore && payload.results.length === 0)) {
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

    const cartesian = this.viewer.camera.pickEllipsoid(
      position,
      this.viewer.scene.globe.ellipsoid,
    )
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
    const coordinates = geometry.type === 'MultiLineString'
      ? geometry.coordinates[0] ?? []
      : geometry.coordinates
    const coordinatePairs = coordinates.flatMap((coordinate) => {
      const longitude = coordinate[0]
      const latitude = coordinate[1]
      return typeof longitude === 'number' && typeof latitude === 'number'
        ? [longitude, latitude]
        : []
    })
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
        const coordinateGroups = road.geometry.type === 'MultiLineString'
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
          if (coordinatePairs.length < 4) continue
          this.spatialResultEntities.push(this.viewer.entities.add({
            polyline: {
              positions: cesium.Cartesian3.fromDegreesArray(coordinatePairs),
              width: 6,
              material: cesium.Color.fromCssColorString('#3385ff').withAlpha(0.72),
              clampToGround: true,
            },
          }))
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
    const coordinateGroups = geometry.type === 'MultiLineString'
      ? geometry.coordinates
      : [geometry.coordinates]
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
