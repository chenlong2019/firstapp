<!--
  Road-MVT.vue —— /roads 页面:Cesium 三维地球上渲染矢量瓦片(MVT)路网。

  职责:基于道路瓦片场景(src/lib/road-mvt-scene.ts)提供三块 UI —— 左上道路搜索、
  左下空间查询(点/线/面)、右下道路图例,以及右上性能指标与选中道路信息。

  非直觉约定:
  - Cesium 以全局脚本引入(index.html 的 /Cesium/Cesium.js),全局名 `Cesium`,类型见 src/types/cesium.d.ts。
  - 瓦片/搜索/空间查询接口默认指向 http://127.0.0.1:3001,可用环境变量 VITE_MVT_URL 覆盖;
    本组件只负责发起请求与展示,几何高亮与相机飞行都在场景类内完成。
  - FPS 与「加载线数量」每 500ms 向场景读取一次,不做逐帧刷新。
-->
<template>
  <div class="road-mvt">
    <!-- Cesium 三维地球挂载容器:场景实例在 onMounted 中创建 -->
    <div class="div-viewer" ref="mapRef"></div>
    <!-- 左上:道路搜索面板(按名称/编号搜索,点击结果后聚焦该道路) -->
    <div class="road-search">
      <form class="search-form" @submit.prevent="searchRoads">
        <input
          v-model="searchText"
          type="search"
          autocomplete="off"
          placeholder="搜索道路名称或编号"
          aria-label="搜索道路名称或编号"
        />
        <button type="submit" :disabled="searchLoading || !searchText.trim()">搜索</button>
      </form>
      <div v-if="searchLoading" class="search-message">正在搜索...</div>
      <div v-else-if="searchMessage" class="search-message">{{ searchMessage }}</div>
      <div v-if="searchResults.length" class="search-results">
        <button
          v-for="road in searchResults"
          :key="`${road.osm_id}-${road.ref}-${road.name}`"
          type="button"
          class="search-result"
          @click="focusSearchRoad(road)"
        >
          <strong>{{ road.name || road.ref || '未命名道路' }}</strong>
          <span>
            {{ roadTypeNames[road.fclass ?? ''] ?? road.fclass ?? '未知类型' }}
            <template v-if="road.ref && road.name"> · {{ road.ref }}</template>
          </span>
        </button>
      </div>
    </div>
    <!-- 左下:空间查询面板(点/线/面绘制 → 检索相交道路 → 分页展示结果) -->
    <div class="spatial-query-panel">
      <div class="spatial-query-title">空间查询</div>
      <div class="spatial-query-actions">
        <button
          type="button"
          :class="{ active: spatialActiveType === 'point' }"
          @click="startSpatialQuery('point')"
        >
          点
        </button>
        <button
          type="button"
          :class="{ active: spatialActiveType === 'line' }"
          @click="startSpatialQuery('line')"
        >
          线
        </button>
        <button
          type="button"
          :class="{ active: spatialActiveType === 'polygon' }"
          @click="startSpatialQuery('polygon')"
        >
          面
        </button>
        <button v-if="spatialActiveType" type="button" class="muted" @click="cancelSpatialQuery">
          取消
        </button>
        <button v-if="hasSpatialQuery" type="button" class="muted" @click="clearSpatialQuery">
          清除
        </button>
      </div>
      <div v-if="spatialActiveType" class="spatial-query-hint">
        {{ spatialQueryHints[spatialActiveType] }}
      </div>
      <div v-if="spatialQueryLoading" class="spatial-query-message">正在查询道路...</div>
      <div v-else-if="spatialMessage" class="spatial-query-message">{{ spatialMessage }}</div>
      <div v-if="spatialResults.length" class="spatial-results">
        <div class="spatial-result-count">
          命中 {{ spatialTotal }} 条道路
          <span v-if="spatialResults.length < spatialTotal">
            · 已加载 {{ spatialResults.length }} 条</span
          >
        </div>
        <button
          v-for="road in visibleSpatialResults"
          :key="road.fid ?? `spatial-${road.osm_id}-${road.ref}-${road.name}`"
          type="button"
          class="spatial-result"
          @click="focusSpatialRoad(road)"
        >
          <strong>{{ road.name || road.ref || '未命名道路' }}</strong>
          <span>
            {{ roadTypeNames[road.fclass ?? ''] ?? road.fclass ?? '未知类型' }}
            <template v-if="road.ref && road.name"> · {{ road.ref }}</template>
          </span>
        </button>
      </div>
      <div v-if="spatialPageCount > 1" class="spatial-pagination">
        <button type="button" :disabled="spatialPage === 1" @click="spatialPage -= 1">
          上一页
        </button>
        <span>{{ spatialPage }} / {{ spatialPageCount }} 页</span>
        <button
          type="button"
          :disabled="spatialPage === spatialPageCount"
          @click="spatialPage += 1"
        >
          下一页
        </button>
      </div>
    </div>
    <!-- 左下角状态提示:连接瓦片服务的过程/结果,hasError 时切换到错误配色 -->
    <div v-if="status" class="map-status" :class="{ error: hasError }">{{ status }}</div>
    <!-- 右上:性能面板(FPS 与当前已加载瓦片的要素总数) -->
    <div class="performance-panel">
      <div class="performance-item">
        <span class="performance-label">FPS</span>
        <strong>{{ metrics.fps }}</strong>
      </div>
      <div class="performance-item">
        <span class="performance-label">加载线数量</span>
        <strong>{{ metrics.loadedLineCount.toLocaleString('zh-CN') }}</strong>
      </div>
    </div>
    <!-- 右下:道路类型图例(色带与线宽对应场景内的分级样式) -->
    <div class="road-legend">
      <div class="legend-title">道路类型</div>
      <div v-for="item in roadLegend" :key="item.label" class="legend-item">
        <span
          class="legend-line"
          :style="{ backgroundColor: item.color, height: `${item.width}px` }"
        ></span>
        <span>{{ item.label }}</span>
      </div>
    </div>
    <!-- 右上:选中道路的属性信息面板(点选或聚焦某条道路时出现) -->
    <div v-if="selectedRoad" class="road-info">
      <div class="info-header">
        <strong>道路信息</strong>
        <button type="button" title="关闭道路信息" @click="clearRoadSelection">×</button>
      </div>
      <div v-for="row in roadInfoRows" :key="row.label" class="info-row">
        <span>{{ row.label }}</span>
        <strong>{{ row.value }}</strong>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  RoadMvtScene,
  type RoadInfo,
  type SpatialQueryEvent,
  type SpatialQueryType,
} from '@/lib/road-mvt-scene'

const mapRef = ref<HTMLElement | null>(null)
const searchText = ref('')
const searchResults = ref<RoadInfo[]>([])
const searchLoading = ref(false)
const searchMessage = ref('')
const spatialResults = ref<RoadInfo[]>([])
const spatialTotal = ref(0)
const spatialPage = ref(1)
// 结果展示分页大小:场景层已把查询结果累积推送过来,这里只做前端分页,避免一次渲染上千条
const spatialPageSize = 100
const spatialPageCount = computed(() =>
  Math.max(1, Math.ceil(spatialResults.value.length / spatialPageSize)),
)
// 只渲染当前页,避免结果集很大时一次性铺满 DOM
const visibleSpatialResults = computed(() =>
  spatialResults.value.slice(
    (spatialPage.value - 1) * spatialPageSize,
    spatialPage.value * spatialPageSize,
  ),
)
const spatialActiveType = ref<SpatialQueryType | null>(null)
const spatialQueryLoading = ref(false)
const hasSpatialQuery = ref(false)
const spatialMessage = ref('')
const status = ref('正在连接道路瓦片服务...')
const hasError = ref(false)
const metrics = ref({ fps: 0, loadedLineCount: 0 })
const selectedRoad = ref<RoadInfo | null>(null)
let roadMvtScene: RoadMvtScene | undefined
let metricsTimer: number | undefined
// 道路服务地址:优先取 VITE_MVT_URL,未配置时回退到本地默认端口(需先启动 Node 服务)
const roadApiUrl = import.meta.env.VITE_MVT_URL ?? 'http://127.0.0.1:3001'

/** 三种空间查询模式的操作提示文案,展示在面板中 */
const spatialQueryHints: Record<SpatialQueryType, string> = {
  // 150 米是点查询的邻域半径,与场景层空间查询的 pointToleranceMeters 一致,改动需同步
  point: '点击地图查询附近道路（半径 150 米）',
  line: '单击添加至少 2 个节点，移动鼠标预览，双击完成，右键取消',
  polygon: '单击添加至少 3 个节点，移动鼠标预览，双击完成，右键取消',
}

/** OSM fclass → 中文名映射(只列常用类型;未命中时回退显示原始 fclass) */
const roadTypeNames: Record<string, string> = {
  motorway: '高速公路',
  motorway_link: '高速公路连接线',
  trunk: '快速路',
  trunk_link: '快速路连接线',
  primary: '主要道路',
  secondary: '次要道路',
  tertiary: '一般道路',
  residential: '居民道路',
  service: '服务道路',
  footway: '步行道',
  cycleway: '自行车道',
  path: '小路',
  steps: '台阶',
}

/** 把选中道路的属性整理成信息面板的行;无选中时返回空数组 */
const roadInfoRows = computed(() => {
  const road = selectedRoad.value
  if (!road) return []

  const valueOrFallback = (value: unknown) => {
    if (value === undefined || value === null || value === '') return '未提供'
    return String(value)
  }
  // OSM/瓦片服务里布尔字段编码不统一('T'/'F'、'1'/'0' 或真正的 boolean),这里统一归一
  const yesNo = (value: unknown) => {
    if (value === 'F' || value === '0' || value === false) return '否'
    if (value === 'T' || value === '1' || value === true) return '是'
    return valueOrFallback(value)
  }

  return [
    { label: '类型', value: roadTypeNames[road.fclass ?? ''] ?? valueOrFallback(road.fclass) },
    { label: '名称', value: valueOrFallback(road.name) },
    { label: '道路编号', value: valueOrFallback(road.ref) },
    { label: '限速', value: road.maxspeed ? `${road.maxspeed} km/h` : '未提供' },
    { label: '单行道', value: yesNo(road.oneway) },
    { label: '桥梁', value: yesNo(road.bridge) },
    { label: '隧道', value: yesNo(road.tunnel) },
    { label: 'OSM ID', value: valueOrFallback(road.osm_id) },
  ]
})

// 图例的颜色/线宽需与 src/lib/road-mvt-scene.ts 里 roadStyle 的取值保持一致,否则图例会失真
const roadLegend = [
  { label: '高速公路', color: '#e7863d', width: 4.2 },
  { label: '快速路', color: '#eea548', width: 3.5 },
  { label: '主要道路', color: '#f3c45e', width: 3 },
  { label: '次要道路', color: '#f2d99b', width: 2.4 },
  { label: '一般道路', color: '#f7e9c5', width: 1.9 },
  { label: '居民道路', color: '#fffaf0', width: 1.45 },
  { label: '步行/小路', color: '#cfb487', width: 1 },
]

/** 挂载后创建道路瓦片场景,并起一个 500ms 定时器轮询性能指标;失败则提示服务未启动 */
onMounted(async () => {
  if (!mapRef.value) return

  try {
    roadMvtScene = await RoadMvtScene.create(
      mapRef.value,
      (road) => {
        selectedRoad.value = road
      },
      handleSpatialQueryEvent,
    )
    status.value = '道路瓦片已连接'
    // 500ms 采样一次即可:场景内 FPS 也是按约 500ms 窗口统计的,无需逐帧刷新
    metricsTimer = window.setInterval(() => {
      if (roadMvtScene) {
        metrics.value = roadMvtScene.getMetrics()
      }
    }, 500)
  } catch (error) {
    console.error(error)
    hasError.value = true
    status.value = '道路瓦片服务连接失败，请确认 Node 服务已启动'
  }
})

/** 关闭道路信息面板并清除地图上的道路高亮 */
function clearRoadSelection(): void {
  roadMvtScene?.clearSelection()
}

/** 按名称/编号搜索道路,最多取前 10 条;结果仅填充列表,点击后才聚焦 */
async function searchRoads(): Promise<void> {
  const query = searchText.value.trim()
  if (!query) return

  searchLoading.value = true
  searchMessage.value = ''
  searchResults.value = []

  try {
    const response = await fetch(
      `${roadApiUrl}/roads/search?q=${encodeURIComponent(query)}&limit=10`,
    )
    if (!response.ok) {
      throw new Error(`Road search failed with status ${response.status}`)
    }

    const payload = (await response.json()) as { results?: RoadInfo[] }
    searchResults.value = payload.results ?? []
    if (searchResults.value.length === 0) {
      searchMessage.value = '没有找到匹配的道路'
    }
  } catch (error) {
    console.error(error)
    searchMessage.value = '搜索失败，请确认道路服务已启动'
  } finally {
    searchLoading.value = false
  }
}

/** 聚焦搜索结果中的某条道路:收起结果列表,交给场景执行高亮与飞行 */
function focusSearchRoad(road: RoadInfo): void {
  searchResults.value = []
  searchMessage.value = ''
  roadMvtScene?.focusRoad(road)
}

/** 进入指定类型的空间查询绘制态,先清掉上一轮的选中与结果 */
function startSpatialQuery(type: SpatialQueryType): void {
  selectedRoad.value = null
  spatialResults.value = []
  spatialMessage.value = ''
  roadMvtScene?.startSpatialQuery(type)
}

/** 取消当前正在绘制/查询的空间查询(不影响已展示的结果) */
function cancelSpatialQuery(): void {
  roadMvtScene?.cancelSpatialQuery()
}

/** 清除空间查询的结果图层与页面状态,复位到初始态 */
function clearSpatialQuery(): void {
  roadMvtScene?.clearSpatialQuery()
  hasSpatialQuery.value = false
  spatialResults.value = []
  spatialTotal.value = 0
  spatialPage.value = 1
  spatialActiveType.value = null
  spatialQueryLoading.value = false
  spatialMessage.value = ''
}

/** 聚焦空间查询结果中的某条道路,并同时展开它的信息面板 */
function focusSpatialRoad(road: RoadInfo): void {
  roadMvtScene?.focusRoad(road)
  selectedRoad.value = road
}

/**
 * 场景层空间查询事件的状态机,按 event.status 切换页面 UI:
 * drawing=开始绘制,searching=检索中,progress=分页增量(累加结果),
 * completed=完成,error=出错;其余(含 cancelled)一律复位到空闲态。
 */
function handleSpatialQueryEvent(event: SpatialQueryEvent): void {
  if (event.status === 'drawing') {
    hasSpatialQuery.value = false
    spatialActiveType.value = event.type
    spatialQueryLoading.value = false
    spatialResults.value = []
    spatialTotal.value = 0
    spatialPage.value = 1
    spatialMessage.value = ''
    return
  }
  if (event.status === 'searching') {
    hasSpatialQuery.value = true
    spatialActiveType.value = null
    spatialQueryLoading.value = true
    spatialMessage.value = ''
    return
  }
  if (event.status === 'progress') {
    // 场景层按页推送增量,这里累加;total 是命中总数,可能大于已加载条数
    spatialResults.value.push(...(event.roads ?? []))
    spatialTotal.value = event.total ?? spatialResults.value.length
    return
  }
  if (event.status === 'completed') {
    spatialActiveType.value = null
    spatialQueryLoading.value = false
    spatialTotal.value = event.total ?? spatialResults.value.length
    spatialMessage.value = spatialResults.value.length ? '' : '没有找到相交的道路'
    return
  }
  if (event.status === 'error') {
    spatialActiveType.value = null
    spatialQueryLoading.value = false
    spatialMessage.value = event.message ?? '空间查询失败'
    return
  }
  spatialActiveType.value = null
  spatialQueryLoading.value = false
  spatialMessage.value = ''
}

/** 卸载时清掉性能定时器并销毁场景,释放 Cesium viewer 与各处监听 */
onUnmounted(() => {
  if (metricsTimer !== undefined) {
    window.clearInterval(metricsTimer)
  }
  roadMvtScene?.destroy()
})
</script>
<style scoped lang="scss">
.road-mvt {
  height: 100%;
  width: 100%;
  background-color: #f5f5f5;

  /* 阻止首个子元素的 margin 穿透容器、塌陷到 body 之外 */
  display: flow-root;

  .div-viewer {
    height: 100%;
    width: 100%;
    position: relative;
  }

  .map-status {
    position: absolute;
    bottom: 16px;
    left: 16px;
    padding: 8px 12px;
    color: #d9fbe8;
    background: rgb(12 35 28 / 88%);
    border: 1px solid rgb(105 226 157 / 45%);
    border-radius: 4px;
    font: 13px/1.4 sans-serif;
    pointer-events: none;

    &.error {
      color: #ffd9d9;
      background: rgb(64 20 24 / 90%);
      border-color: rgb(255 130 130 / 55%);
    }
  }

  .spatial-query-panel {
    position: absolute;
    z-index: 1;
    top: 72px;
    left: 16px;
    width: 310px;
    max-height: calc(100% - 96px);
    overflow: hidden;
    color: #eef4f7;
    background: rgb(15 24 29 / 92%);
    border: 1px solid rgb(190 208 216 / 35%);
    border-radius: 4px;
    box-shadow: 0 3px 12px rgb(0 0 0 / 18%);
    font: 12px/1.4 sans-serif;
  }

  .spatial-query-title {
    padding: 8px 10px 5px;
    color: #ffffff;
    font-weight: 600;
  }

  .spatial-query-actions {
    display: flex;
    gap: 5px;
    padding: 0 8px 8px;
  }

  .spatial-query-actions button {
    min-width: 38px;
    height: 28px;
    padding: 0 9px;
    color: #e8f0f4;
    background: rgb(82 107 119 / 60%);
    border: 1px solid rgb(190 208 216 / 28%);
    border-radius: 3px;
    cursor: pointer;
  }

  .spatial-query-actions button:hover,
  .spatial-query-actions button.active {
    color: #ffffff;
    background: #1976d2;
    border-color: #64b5f6;
  }

  .spatial-query-actions button.muted {
    color: #c5d2d8;
    background: transparent;
  }

  .spatial-query-actions button.muted:hover {
    color: #ffffff;
    background: rgb(82 107 119 / 60%);
  }

  .spatial-query-hint,
  .spatial-query-message {
    padding: 0 10px 8px;
    color: #b9c8ce;
  }

  .spatial-results {
    max-height: 300px;
    overflow-y: auto;
    border-top: 1px solid rgb(190 208 216 / 18%);
  }

  .spatial-result-count {
    padding: 7px 10px 5px;
    color: #8ed0ff;
  }

  .spatial-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    border-top: 1px solid rgb(190 208 216 / 18%);
  }

  .spatial-pagination button {
    padding: 4px 8px;
    color: #eef4f7;
    background: #1976d2;
    border: 0;
    border-radius: 3px;
    cursor: pointer;
  }

  .spatial-pagination button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .spatial-result {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 2px;
    padding: 7px 10px;
    color: #ffffff;
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgb(190 208 216 / 12%);
    text-align: left;
    cursor: pointer;
  }

  .spatial-result:last-child {
    border-bottom: 0;
  }

  .spatial-result:hover {
    background: rgb(66 165 245 / 28%);
  }

  .spatial-result strong,
  .spatial-result span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spatial-result strong {
    font-weight: 600;
  }

  .spatial-result span {
    color: #b9c8ce;
  }

  .road-search {
    position: absolute;
    z-index: 1;
    top: 16px;
    left: 16px;
    width: 310px;
    color: #eef4f7;
    background: rgb(15 24 29 / 92%);
    border: 1px solid rgb(190 208 216 / 35%);
    border-radius: 4px;
    box-shadow: 0 3px 12px rgb(0 0 0 / 18%);
    font: 12px/1.4 sans-serif;
  }

  .search-form {
    display: flex;
    gap: 6px;
    padding: 8px;
  }

  .search-form input {
    min-width: 0;
    flex: 1;
    height: 30px;
    padding: 0 9px;
    color: #263238;
    background: #ffffff;
    border: 1px solid #c5d2d8;
    border-radius: 3px;
    outline: none;
  }

  .search-form input:focus {
    border-color: #42a5f5;
    box-shadow: 0 0 0 2px rgb(66 165 245 / 25%);
  }

  .search-form button {
    height: 30px;
    padding: 0 12px;
    color: #ffffff;
    background: #1976d2;
    border: 0;
    border-radius: 3px;
    cursor: pointer;
  }

  .search-form button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .search-message {
    padding: 0 10px 9px;
    color: #b9c8ce;
  }

  .search-results {
    max-height: 280px;
    overflow-y: auto;
    border-top: 1px solid rgb(190 208 216 / 18%);
  }

  .search-result {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 2px;
    padding: 8px 10px;
    color: #ffffff;
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgb(190 208 216 / 12%);
    text-align: left;
    cursor: pointer;
  }

  .search-result:last-child {
    border-bottom: 0;
  }

  .search-result:hover {
    background: rgb(66 165 245 / 28%);
  }

  .search-result strong {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result span {
    overflow: hidden;
    color: #b9c8ce;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .performance-panel {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 16px;
    padding: 9px 12px;
    color: #eef4f7;
    background: rgb(15 24 29 / 88%);
    border: 1px solid rgb(190 208 216 / 35%);
    border-radius: 4px;
    font: 12px/1.4 sans-serif;
    pointer-events: none;
  }

  .performance-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
  }

  .performance-label {
    color: #aebfc7;
  }

  .performance-item strong {
    color: #ffffff;
    font-size: 14px;
  }

  .road-info {
    position: absolute;
    top: 64px;
    right: 16px;
    min-width: 230px;
    padding: 10px 12px;
    color: #eef4f7;
    background: rgb(15 24 29 / 92%);
    border: 1px solid rgb(190 208 216 / 35%);
    border-radius: 4px;
    font: 12px/1.4 sans-serif;
  }

  .info-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
    color: #ffffff;
  }

  .info-header button {
    width: 22px;
    height: 22px;
    padding: 0;
    color: #c5d2d8;
    background: transparent;
    border: 0;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .info-header button:hover {
    color: #ffffff;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    min-height: 22px;
    border-top: 1px solid rgb(190 208 216 / 14%);
  }

  .info-row span {
    color: #aebfc7;
  }

  .info-row strong {
    max-width: 150px;
    overflow: hidden;
    color: #ffffff;
    font-weight: 500;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .road-legend {
    position: absolute;
    right: 16px;
    bottom: 16px;
    min-width: 132px;
    padding: 10px 12px;
    color: #eef4f7;
    background: rgb(15 24 29 / 88%);
    border: 1px solid rgb(190 208 216 / 35%);
    border-radius: 4px;
    font: 12px/1.4 sans-serif;
    pointer-events: none;
  }

  .legend-title {
    margin-bottom: 6px;
    color: #ffffff;
    font-weight: 600;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 18px;
  }

  .legend-line {
    display: inline-block;
    width: 24px;
    min-height: 1px;
    border-radius: 2px;
  }
}
</style>
