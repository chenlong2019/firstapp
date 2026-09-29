<template>
  <main
    class="glb-lab"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div ref="viewportRef" class="viewport" aria-label="GLB 模型查看视口"></div>

    <!-- ————— 顶部工具栏:导入 / 导出 ————— -->
    <header class="top-bar" aria-label="模型导入导出">
      <button class="top-button primary" type="button" @click="openFilePicker">⬆ 导入 GLB</button>
      <span class="top-divider" aria-hidden="true"></span>
      <button
        v-for="sample in SAMPLES"
        :key="sample.url"
        class="top-button subtle"
        type="button"
        :class="{ active: status.fileName === sample.fileName }"
        @click="loadSample(sample)"
      >
        {{ sample.label }}
      </button>
      <span class="top-divider" aria-hidden="true"></span>
      <button
        class="top-button"
        type="button"
        :disabled="selectedId === null || exporting"
        :title="selectedId === null ? '先在模型中选中一个部件' : '把选中部件(含子树)导出为 GLB'"
        @click="exportSelectedPart"
      >
        {{ exporting ? '正在导出…' : '⬇ 导出选中部件' }}
      </button>
    </header>

    <!-- ————— 空状态:未载入模型时的引导 ————— -->
    <div v-if="!hasModel && status.state === 'idle'" class="empty-state">
      <div class="empty-card">
        <h2>GLB 模型查看器</h2>
        <p>把 <strong>.glb / .gltf</strong> 文件拖到页面任意位置即可载入</p>
        <button class="empty-primary" type="button" @click="openFilePicker">选择 GLB 文件…</button>
        <div class="empty-samples">
          <span>或载入示例模型:</span>
          <button
            v-for="sample in SAMPLES"
            :key="sample.url"
            type="button"
            @click="loadSample(sample)"
          >
            {{ sample.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- ————— 模型树 ————— -->
    <aside class="panel tree-panel" aria-label="模型树">
      <div class="panel-heading">
        <span>MODEL TREE</span>
        <small>{{ treeSummary }}</small>
      </div>

      <div class="toolbar">
        <button type="button" @click="expandAll">展开全部</button>
        <button type="button" @click="collapseAll">折叠全部</button>
        <button type="button" :disabled="selectedId === null" @click="clearSelection">
          清除高亮
        </button>
      </div>

      <input
        v-model.trim="keyword"
        class="tree-filter"
        type="search"
        placeholder="搜索部件名称…"
        aria-label="搜索部件名称"
      />

      <p class="tree-legend">
        <span>单击选中 · 双击聚焦 · 悬停预览 · 画布点选自动定位</span>
      </p>

      <ul v-if="rows.length" ref="treeListRef" class="tree-list">
        <li
          v-for="row in rows"
          :key="row.node.id"
          class="tree-row"
          :data-node-id="row.node.id"
          :class="{
            selected: row.node.id === selectedId,
            hovered: row.node.id === hoverId && row.node.id !== selectedId,
            locating: row.node.id === locatingId,
            hidden: !row.vis.effective,
          }"
          :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
          @click="selectNode(row.node.id)"
          @dblclick="focusNode(row.node.id)"
          @mouseenter="onRowEnter(row.node.id)"
          @mouseleave="onRowLeave"
        >
          <input
            type="checkbox"
            class="tree-check"
            :class="{ inherited: row.vis.inherited, partial: row.vis.partial }"
            :checked="row.vis.effective"
            :indeterminate="row.vis.partial"
            :title="checkHint(row.vis)"
            :aria-label="`${row.vis.effective ? '隐藏' : '显示'} ${row.node.name}`"
            @click.stop
            @dblclick.stop
            @change="toggleRowVisible(row.node.id)"
          />
          <button
            v-if="row.hasChildren"
            type="button"
            class="tree-toggle"
            :aria-label="row.expanded ? '折叠' : '展开'"
            @click.stop="toggleExpand(row.node.id)"
          >
            {{ row.expanded ? '▾' : '▸' }}
          </button>
          <span v-else class="tree-toggle placeholder"></span>
          <i class="kind-chip" :class="`kind-${row.node.kind}`">{{ KIND_LABELS[row.node.kind] }}</i>
          <span class="tree-name" :title="row.node.name">{{ row.node.name }}</span>
          <em v-if="row.node.triangles" class="tree-meta">{{ formatCount(row.node.triangles) }}</em>
        </li>
      </ul>
      <p v-else class="tree-empty">{{ keyword ? '没有匹配的部件' : '尚未载入模型' }}</p>
      <p v-if="truncated" class="tree-hint">节点过多,仅渲染前 {{ MAX_ROWS }} 项,请用搜索缩小范围</p>
    </aside>

    <!-- ————— 检查器 ————— -->
    <aside class="panel inspector" aria-label="光照与模型信息">
      <div class="panel-heading">
        <span>INSPECTOR</span>
        <small>{{ fpsText }}</small>
      </div>

      <section class="section">
        <h3>光照强度</h3>
        <label v-for="light in lightRows" :key="light.key" class="slider-row">
          <span class="slider-label">{{ light.label }}</span>
          <strong>{{ lightSettings[light.key].toFixed(2) }}</strong>
          <input
            type="range"
            min="0"
            :max="light.max"
            step="0.05"
            :value="lightSettings[light.key]"
            @input="onLightInput(light.key, $event)"
          />
        </label>
        <button class="wide-button" type="button" @click="resetLights">恢复默认光照</button>
      </section>

      <section class="section">
        <h3>视图</h3>
        <div v-for="option in viewOptions" :key="option.key" class="toggle-row">
          <span>{{ option.label }}</span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: view[option.key] }"
              @click="setViewOption(option.key, true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !view[option.key] }"
              @click="setViewOption(option.key, false)"
            >
              关
            </button>
          </div>
        </div>
        <label class="slider-row" :class="{ disabled: !explodeAvailable }">
          <span class="slider-label">爆炸图</span>
          <strong>{{ explodeAmount.toFixed(2) }}</strong>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="explodeAmount"
            :disabled="!explodeAvailable"
            :title="explodeAvailable ? '拖动把部件沿各自方向炸开' : '该模型没有可拆分的部件'"
            @input="onExplodeInput"
          />
        </label>
        <button class="wide-button" type="button" :disabled="!hasModel" @click="resetView">
          重置视角
        </button>
      </section>

      <section class="section">
        <h3>后处理</h3>

        <div class="toggle-row">
          <span>泛光 Bloom</span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: bloomSettings.enabled }"
              @click="setBloomEnabled(true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !bloomSettings.enabled }"
              @click="setBloomEnabled(false)"
            >
              关
            </button>
          </div>
        </div>
        <label
          v-for="row in BLOOM_ROWS"
          :key="row.key"
          class="slider-row"
          :class="{ disabled: !bloomSettings.enabled }"
        >
          <span class="slider-label">{{ row.label }}</span>
          <strong>{{ bloomSettings[row.key].toFixed(2) }}</strong>
          <input
            type="range"
            :min="row.min"
            :max="row.max"
            :step="row.step"
            :value="bloomSettings[row.key]"
            :disabled="!bloomSettings.enabled"
            @input="onBloomInput(row.key, $event)"
          />
        </label>

        <div class="toggle-row outline-toggle">
          <span>选中描边 Outline</span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: outlineSettings.enabled }"
              @click="setOutlineEnabled(true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !outlineSettings.enabled }"
              @click="setOutlineEnabled(false)"
            >
              关
            </button>
          </div>
        </div>
        <label
          v-for="row in OUTLINE_ROWS"
          :key="row.key"
          class="slider-row"
          :class="{ disabled: !outlineSettings.enabled }"
        >
          <span class="slider-label">{{ row.label }}</span>
          <strong>{{ outlineSettings[row.key].toFixed(2) }}</strong>
          <input
            type="range"
            :min="row.min"
            :max="row.max"
            :step="row.step"
            :value="outlineSettings[row.key]"
            :disabled="!outlineSettings.enabled"
            @input="onOutlineInput(row.key, $event)"
          />
        </label>
        <div class="toggle-row" :class="{ disabled: !outlineSettings.enabled }">
          <span>选中颜色</span>
          <input
            v-model="outlineColorHex"
            class="color-input"
            type="color"
            :disabled="!outlineSettings.enabled"
            @input="onOutlineColor"
          />
        </div>

        <div class="toggle-row outline-toggle">
          <span>悬停描边 Hover</span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: hoverOutlineSettings.enabled }"
              @click="setHoverOutlineEnabled(true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !hoverOutlineSettings.enabled }"
              @click="setHoverOutlineEnabled(false)"
            >
              关
            </button>
          </div>
        </div>
        <label
          v-for="row in HOVER_OUTLINE_ROWS"
          :key="row.key"
          class="slider-row"
          :class="{ disabled: !hoverOutlineSettings.enabled }"
        >
          <span class="slider-label">{{ row.label }}</span>
          <strong>{{ hoverOutlineSettings[row.key].toFixed(2) }}</strong>
          <input
            type="range"
            :min="row.min"
            :max="row.max"
            :step="row.step"
            :value="hoverOutlineSettings[row.key]"
            :disabled="!hoverOutlineSettings.enabled"
            @input="onHoverOutlineInput(row.key, $event)"
          />
        </label>
        <div class="toggle-row" :class="{ disabled: !hoverOutlineSettings.enabled }">
          <span>悬停颜色</span>
          <input
            v-model="hoverOutlineColorHex"
            class="color-input"
            type="color"
            :disabled="!hoverOutlineSettings.enabled"
            @input="onHoverOutlineColor"
          />
        </div>
        <button class="wide-button" type="button" @click="resetPostFx">恢复默认后处理</button>
      </section>

      <section v-if="stats" class="section">
        <h3>模型信息</h3>
        <dl class="info-grid">
          <div class="wide">
            <dt>文件</dt>
            <dd :title="stats.fileName">{{ stats.fileName }}</dd>
          </div>
          <div>
            <dt>尺寸</dt>
            <dd>{{ stats.size.map((value) => value.toFixed(2)).join(' × ') }}</dd>
          </div>
          <div>
            <dt>节点</dt>
            <dd>{{ stats.nodes }}</dd>
          </div>
          <div>
            <dt>网格</dt>
            <dd>{{ stats.meshes }}</dd>
          </div>
          <div>
            <dt>三角面</dt>
            <dd>{{ formatCount(stats.triangles) }}</dd>
          </div>
          <div>
            <dt>顶点</dt>
            <dd>{{ formatCount(stats.vertices) }}</dd>
          </div>
          <div>
            <dt>材质</dt>
            <dd>{{ stats.materials }}</dd>
          </div>
          <div>
            <dt>贴图</dt>
            <dd>{{ stats.textures }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="nodeInfo" class="section">
        <h3>选中部件</h3>
        <p class="selected-name">{{ nodeInfo.name }}</p>
        <dl class="info-grid">
          <div>
            <dt>类型</dt>
            <dd>{{ KIND_LABELS[nodeInfo.kind] }}</dd>
          </div>
          <div>
            <dt>子节点</dt>
            <dd>{{ nodeInfo.childCount }}</dd>
          </div>
          <div>
            <dt>网格</dt>
            <dd>{{ nodeInfo.meshCount }}</dd>
          </div>
          <div>
            <dt>三角面</dt>
            <dd>{{ formatCount(nodeInfo.triangles) }}</dd>
          </div>
          <div>
            <dt>顶点</dt>
            <dd>{{ formatCount(nodeInfo.vertices) }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ nodeStateText }}</dd>
          </div>
          <div class="wide">
            <dt>材质</dt>
            <dd :title="nodeInfo.materialNames.join(', ')">
              {{ nodeInfo.materialNames.length ? nodeInfo.materialNames.join(', ') : '—' }}
            </dd>
          </div>
          <div class="wide">
            <dt>路径</dt>
            <dd :title="nodeInfo.path">{{ nodeInfo.path }}</dd>
          </div>
        </dl>
        <div class="button-row">
          <button type="button" @click="focusNode(nodeInfo.id)">聚焦</button>
          <button type="button" @click="setNodeVisibility(nodeInfo.id, !nodeVisibility.effective)">
            {{ nodeVisibility.effective ? '隐藏' : '显示' }}
          </button>
          <button type="button" @click="clearSelection">取消高亮</button>
        </div>
        <button class="wide-button" type="button" :disabled="exporting" @click="exportSelectedPart">
          {{ exporting ? '正在导出…' : '导出选中部件为 GLB' }}
        </button>
        <p v-if="exportNote" class="export-note" :class="{ error: exportFailed }">
          {{ exportNote }}
        </p>
      </section>

      <section v-if="animation.names.length" class="section">
        <h3>动画</h3>
        <select class="clip-select" :value="animation.index" @change="onClipChange">
          <option v-for="(name, index) in animation.names" :key="index" :value="index">
            {{ name }}
          </option>
        </select>
        <div class="button-row">
          <button type="button" @click="toggleAnimation">
            {{ animation.playing ? '暂停' : '播放' }}
          </button>
          <span class="mono-note">{{ animation.duration.toFixed(2) }} S</span>
        </div>
        <label class="slider-row">
          <span class="slider-label">播放速度</span>
          <strong>{{ animation.speed.toFixed(2) }}×</strong>
          <input
            type="range"
            min="0.1"
            max="3"
            step="0.1"
            :value="animation.speed"
            @input="onSpeedInput"
          />
        </label>
      </section>

      <section class="section">
        <h3>操作提示</h3>
        <p class="usage-note">
          导入 / 导出入口在顶部工具栏;把 GLB 文件拖到页面任意位置也能直接载入,选中部件后可一键导出。
        </p>
      </section>
    </aside>

    <div class="hint-bar">
      拖拽 GLB 到窗口即可导入 · 单击选中部件 · 双击聚焦 · 滚轮缩放 · 右键平移
    </div>

    <div v-if="status.state === 'loading'" class="loading-card">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在载入 {{ status.fileName }}</p>
      <div class="progress-track"><i :style="{ width: `${progressPercent}%` }"></i></div>
      <small>{{ progressText }}</small>
    </div>

    <div v-else-if="status.state === 'error'" class="error-card">
      <strong>载入失败</strong>
      <p>{{ status.message }}</p>
      <button type="button" @click="dismissError">知道了</button>
    </div>

    <div v-if="dragging" class="drop-overlay" aria-hidden="true">
      <div>释放以导入 GLB 模型</div>
    </div>

    <input
      ref="fileInputRef"
      class="file-input"
      type="file"
      accept=".glb,.gltf,.glb2,model/gltf-binary,model/gltf+json"
      @change="onFileChange"
    />
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { GlbViewer, DEFAULT_LIGHT_SETTINGS } from '../../lib/three-engine/glb-viewer'
import type {
  GlbAnimationState,
  GlbExportResult,
  GlbLoadStatus,
  GlbModelStats,
  GlbNodeInfo,
  GlbNodeKind,
  GlbTreeNode,
  GlbViewOptions,
  LightSettings,
} from '../../lib/three-engine/glb-viewer'
import {
  DEFAULT_BLOOM_SETTINGS,
  DEFAULT_OUTLINE_SETTINGS,
  DEFAULT_HOVER_OUTLINE_SETTINGS,
} from '../../lib/three-engine/post-effects'
import type {
  BloomSettings,
  HoverOutlineSettings,
  OutlineSettings,
} from '../../lib/three-engine/post-effects'

type LightSettingsKey = keyof LightSettings
type ViewOptionKey = keyof GlbViewOptions
type BloomSettingsKey = keyof Pick<BloomSettings, 'strength' | 'radius' | 'threshold'>
type OutlineSettingsKey = keyof Pick<OutlineSettings, 'thickness' | 'glow'>
type HoverOutlineSettingsKey = keyof Pick<HoverOutlineSettings, 'thickness' | 'glow'>

/** 一个节点"实际看得见吗":自有开关 ∧ 整条祖先链,由一个整树遍历算出来。 */
interface NodeVisibility {
  /** 自己开着,且没有任何祖先把它藏起来 —— 画布上真的能看到。 */
  effective: boolean
  /** 自己开着,但被某个祖先隐藏了(勾选框显示为空心虚线)。 */
  inherited: boolean
  /** 自己可见,但子树里还藏着别的部件(勾选框显示为半选)。 */
  partial: boolean
}

interface TreeRow {
  node: GlbTreeNode
  depth: number
  hasChildren: boolean
  expanded: boolean
  vis: NodeVisibility
}

const MAX_ROWS = 800
const KIND_LABELS: Record<GlbNodeKind, string> = {
  scene: '场景',
  group: '组',
  mesh: '网格',
  skinnedMesh: '蒙皮',
  points: '点云',
  line: '线',
  light: '灯光',
  camera: '相机',
  bone: '骨节',
}

const SAMPLES = [
  {
    label: 'DJI Mini 4 Pro(语义化节点)',
    url: '/models/djiair_renamed.glb',
    fileName: 'djiair_renamed.glb',
  },
  { label: 'DJI Air(原始模型)', url: '/models/djiair.glb', fileName: 'djiair.glb' },
]

const LIGHT_ROWS: Array<{ key: LightSettingsKey; label: string; max: number }> = [
  { key: 'ambient', label: '环境光', max: 4 },
  { key: 'key', label: '主光', max: 6 },
  { key: 'fill', label: '补光', max: 6 },
  { key: 'rim', label: '轮廓光', max: 6 },
  { key: 'exposure', label: '曝光', max: 3 },
]

const VIEW_OPTIONS: Array<{ key: ViewOptionKey; label: string }> = [
  { key: 'grid', label: '地面网格' },
  { key: 'axes', label: '坐标轴' },
  { key: 'autoRotate', label: '自动旋转' },
  { key: 'wireframe', label: '线框模式' },
]

const BLOOM_ROWS: Array<{
  key: BloomSettingsKey
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'strength', label: '泛光强度', min: 0, max: 3, step: 0.05 },
  { key: 'radius', label: '泛光半径', min: 0, max: 1, step: 0.05 },
  { key: 'threshold', label: '亮度阈值', min: 0, max: 1, step: 0.05 },
]

const OUTLINE_ROWS: Array<{
  key: OutlineSettingsKey
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'thickness', label: '选中粗细', min: 0.5, max: 8, step: 0.5 },
  { key: 'glow', label: '选中辉光', min: 0, max: 2, step: 0.05 },
]

const HOVER_OUTLINE_ROWS: Array<{
  key: HoverOutlineSettingsKey
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'thickness', label: '悬停粗细', min: 0.5, max: 8, step: 0.5 },
  { key: 'glow', label: '悬停辉光', min: 0, max: 2, step: 0.05 },
]

const viewportRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const treeListRef = ref<HTMLUListElement | null>(null)
let viewer: GlbViewer | null = null
let pollTimer: number | undefined
let locateTimer: number | undefined

/** 节点 id → 父节点 id:画布点选时用来展开到该节点的整条祖先链。 */
const parentOf = new Map<number, number>()

const tree = ref<GlbTreeNode[]>([])
const expanded = ref(new Set<number>())
const keyword = ref('')
const selectedId = ref<number | null>(null)
const hoverId = ref<number | null>(null)
/** 刚刚被"定位"到的行(画布点选触发),短暂高亮提示用。 */
const locatingId = ref<number | null>(null)
const stats = ref<GlbModelStats | null>(null)
const nodeInfo = ref<GlbNodeInfo | null>(null)
const fps = ref(0)
const dragging = ref(false)
const lightRows = LIGHT_ROWS
const viewOptions = VIEW_OPTIONS

const status = reactive<GlbLoadStatus>({
  state: 'idle',
  fileName: '',
  progress: null,
  message: '',
})
const lightSettings = reactive<LightSettings>({ ...DEFAULT_LIGHT_SETTINGS })
const bloomSettings = reactive<BloomSettings>({ ...DEFAULT_BLOOM_SETTINGS })
const outlineSettings = reactive<OutlineSettings>({ ...DEFAULT_OUTLINE_SETTINGS })
const hoverOutlineSettings = reactive<HoverOutlineSettings>({ ...DEFAULT_HOVER_OUTLINE_SETTINGS })
const outlineColorHex = ref(`#${DEFAULT_OUTLINE_SETTINGS.color.toString(16).padStart(6, '0')}`)
const hoverOutlineColorHex = ref(
  `#${DEFAULT_HOVER_OUTLINE_SETTINGS.color.toString(16).padStart(6, '0')}`,
)
const view = reactive<GlbViewOptions>({
  grid: true,
  axes: true,
  autoRotate: false,
  wireframe: false,
})
const explodeAmount = ref(0)
const explodeAvailable = ref(false)
const animation = reactive<GlbAnimationState>({
  names: [],
  index: -1,
  playing: false,
  duration: 0,
  speed: 1,
})

const hasModel = computed(() => stats.value !== null)
const fpsText = computed(() => (fps.value > 0 ? `FPS ${fps.value}` : 'FPS --'))
const progressPercent = computed(() =>
  status.progress === null ? 12 : Math.max(4, Math.round(status.progress * 100)),
)
const progressText = computed(() =>
  status.progress === null ? '解析中…' : `${Math.round(status.progress * 100)}%`,
)
const treeSummary = computed(() => {
  if (!stats.value) return 'NO MODEL'
  return `${stats.value.nodes} NODES · ${stats.value.meshes} MESHES`
})

/**
 * 逐节点推导"实际可见性"。整树后序遍历一次:向下带祖先可见性,向上带"子树里有没有被隐藏的部件",
 * 于是每一行都能同时拿到 effective / inherited / partial 三个状态。
 */
const visibilityMap = computed<Map<number, NodeVisibility>>(() => {
  const map = new Map<number, NodeVisibility>()
  const walk = (node: GlbTreeNode, ancestorVisible: boolean): boolean => {
    const effective = node.visible && ancestorVisible
    let descendantHidden = false
    for (const child of node.children) {
      if (walk(child, effective)) descendantHidden = true
    }
    map.set(node.id, {
      effective,
      inherited: node.visible && !ancestorVisible,
      partial: effective && descendantHidden,
    })
    return descendantHidden || !effective
  }
  tree.value.forEach((node) => walk(node, true))
  return map
})

const NO_VISIBILITY: NodeVisibility = { effective: true, inherited: false, partial: false }

function visOf(id: number | null): NodeVisibility {
  if (id === null) return NO_VISIBILITY
  return visibilityMap.value.get(id) ?? NO_VISIBILITY
}

/** 检查器里选中节点的实际可见状态(会区分"自己关了"和"被父级连坐")。 */
const nodeVisibility = computed<NodeVisibility>(() => visOf(nodeInfo.value?.id ?? null))
const nodeStateText = computed(() => {
  const vis = nodeVisibility.value
  if (vis.effective) return vis.partial ? '显示(子树有隐藏)' : '显示'
  return vis.inherited ? '被父级隐藏' : '隐藏'
})

/** 按关键词裁剪 + 展开态展开,拍平成可直接渲染的行列表。 */
const rows = computed<TreeRow[]>(() => {
  const result: TreeRow[] = []
  const search = keyword.value.toLowerCase()
  const expand = expanded.value
  const visibilities = visibilityMap.value
  const walk = (node: GlbTreeNode, depth: number, forcedOpen: boolean): void => {
    if (result.length >= MAX_ROWS) return
    if (search && !matches(node, search)) return
    const open = forcedOpen || Boolean(search) || expand.has(node.id)
    result.push({
      node,
      depth,
      hasChildren: node.children.length > 0,
      expanded: open,
      vis: visibilities.get(node.id) ?? NO_VISIBILITY,
    })
    if (!open) return
    node.children.forEach((child) => walk(child, depth + 1, false))
  }
  tree.value.forEach((node) => walk(node, 0, false))
  return result
})
const truncated = computed(() => rows.value.length >= MAX_ROWS)

function matches(node: GlbTreeNode, search: string): boolean {
  if (node.name.toLowerCase().includes(search)) return true
  return node.children.some((child) => matches(child, search))
}

function formatCount(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

// ————————————————————————— 生命周期 —————————————————————————

onMounted(async () => {
  if (!viewportRef.value) return
  const instance = new GlbViewer(viewportRef.value)
  viewer = instance
  instance.onStatus = (next) => {
    Object.assign(status, next)
    if (next.state === 'ready') syncFromViewer()
  }
  instance.onSelect = (id, source) => {
    selectedId.value = id
    nodeInfo.value = instance.getNodeInfo(id)
    // 画布点选:模型树自动展开到该节点并滚动定位,让两边看的是同一个部件
    if (source === 'pick' && id !== null) void revealNode(id)
  }
  instance.onHover = (id) => {
    hoverId.value = id
  }

  await instance.init()
  if (viewer !== instance) return
  Object.assign(lightSettings, instance.getLightSettings())
  Object.assign(view, instance.getViewOptions())
  explodeAmount.value = instance.getExplodeAmount()
  explodeAvailable.value = instance.isExplodeAvailable()
  Object.assign(bloomSettings, instance.getBloomSettings())
  Object.assign(outlineSettings, instance.getOutlineSettings())
  Object.assign(hoverOutlineSettings, instance.getHoverOutlineSettings())
  outlineColorHex.value = `#${outlineSettings.color.toString(16).padStart(6, '0')}`
  hoverOutlineColorHex.value = `#${hoverOutlineSettings.color.toString(16).padStart(6, '0')}`

  // 默认不加载模型:由顶部工具栏 / 空状态引导 / 拖拽导入触发载入

  pollTimer = window.setInterval(() => {
    if (!viewer) return
    fps.value = viewer.getFps()
    Object.assign(animation, viewer.getAnimationState())
  }, 400)
})

onUnmounted(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = undefined
  if (locateTimer !== undefined) window.clearTimeout(locateTimer)
  locateTimer = undefined
  if (exportNoteTimer !== undefined) window.clearTimeout(exportNoteTimer)
  exportNoteTimer = undefined
  viewer?.destroy()
  viewer = null
})

/** 模型载入完成后同步树、统计、动画与视图状态,并默认展开前两层。 */
function syncFromViewer(): void {
  if (!viewer) return
  tree.value = viewer.getTree()
  stats.value = viewer.getStats()
  selectedId.value = null
  hoverId.value = null
  locatingId.value = null
  nodeInfo.value = null
  keyword.value = ''
  Object.assign(animation, viewer.getAnimationState())
  Object.assign(lightSettings, viewer.getLightSettings())
  Object.assign(view, viewer.getViewOptions())
  explodeAmount.value = viewer.getExplodeAmount()
  explodeAvailable.value = viewer.isExplodeAvailable()

  parentOf.clear()
  const collectParents = (node: GlbTreeNode): void => {
    node.children.forEach((child) => {
      parentOf.set(child.id, node.id)
      collectParents(child)
    })
  }
  tree.value.forEach(collectParents)

  const next = new Set<number>()
  const collect = (node: GlbTreeNode): void => {
    if (node.depth <= 1 && node.children.length > 0) next.add(node.id)
    node.children.forEach(collect)
  }
  viewer.getTree().forEach(collect)
  expanded.value = next
}

// ————————————————————————— 模型树交互 —————————————————————————

function selectNode(id: number): void {
  viewer?.select(id)
}

function focusNode(id: number): void {
  viewer?.focusNode(id)
}

function toggleExpand(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function expandAll(): void {
  const next = new Set<number>()
  const collect = (node: GlbTreeNode): void => {
    if (node.children.length > 0) next.add(node.id)
    node.children.forEach(collect)
  }
  tree.value.forEach(collect)
  expanded.value = next
}

function collapseAll(): void {
  expanded.value = new Set()
}

function clearSelection(): void {
  viewer?.select(null)
}

// ————————————————————————— 显示 / 隐藏 —————————————————————————

/**
 * 统一切换部件显隐。勾上一个"被祖先连坐隐藏"的节点时,先把整条祖先链恢复 ——
 * 它自己的开关本来就是开的,只改它自己点了不会有任何反应。
 */
function setNodeVisibility(id: number, visible: boolean): void {
  const instance = viewer
  if (!instance) return
  if (visible) {
    ancestorsOf(id).forEach((ancestor) => instance.setNodeVisible(ancestor, true))
  }
  instance.setNodeVisible(id, visible)
  refreshTree()
}

function toggleRowVisible(id: number): void {
  setNodeVisibility(id, !visOf(id).effective)
}

/** 引擎把开关直接写在树节点对象上(非响应式引用),重新赋值数组才能让 computed 重新求值。 */
function refreshTree(): void {
  const instance = viewer
  if (!instance) return
  tree.value = [...instance.getTree()]
}

function checkHint(vis: NodeVisibility): string {
  if (vis.inherited) return '被父级隐藏 · 勾选会一并恢复父级'
  if (vis.partial) return '部分子级被隐藏 · 点击隐藏整个子树'
  return vis.effective ? '隐藏该部件' : '显示该部件'
}

function onRowEnter(id: number): void {
  viewer?.hover(id)
}

function onRowLeave(): void {
  viewer?.hover(null)
}

// ————————————————————————— 画布点选 → 模型树定位 —————————————————————————

/**
 * 把选中节点在模型树里"亮出来":展开整条祖先链 → 滚动到可视区域 →
 * 短暂加一圈定位高亮,让 3D 里点中的部件与树里的那一行一眼对上。
 */
async function revealNode(id: number): Promise<void> {
  const ancestors = ancestorsOf(id)
  if (ancestors.length > 0) {
    const next = new Set(expanded.value)
    ancestors.forEach((ancestor) => next.add(ancestor))
    expanded.value = next
  }

  // 先摘掉定位态再装上,连续点选同一部件时动画也能重新播放
  locatingId.value = null
  await nextTick()

  const found = await scrollToRow(id)
  // 行被搜索过滤掉了:清空关键词再定位一次,保证一定能看到
  if (!found && keyword.value) {
    keyword.value = ''
    await scrollToRow(id)
  }

  locatingId.value = id
  if (locateTimer !== undefined) window.clearTimeout(locateTimer)
  locateTimer = window.setTimeout(() => {
    locatingId.value = null
  }, 1400)
}

/** 收集节点的祖先 id(由内向外)。 */
function ancestorsOf(id: number): number[] {
  const result: number[] = []
  let current = parentOf.get(id)
  while (current !== undefined) {
    result.push(current)
    current = parentOf.get(current)
  }
  return result
}

/** 把某一行滚动到树列表可视区中间;行不存在(被折叠/过滤/截断)时返回 false。 */
async function scrollToRow(id: number): Promise<boolean> {
  await nextTick()
  const list = treeListRef.value
  const row = list?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
  if (!list || !row) return false
  const listRect = list.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const offset = rowRect.top - listRect.top
  const outOfView = offset < 0 || offset + rowRect.height > list.clientHeight
  if (outOfView) {
    list.scrollTo({
      top: list.scrollTop + offset - (list.clientHeight - rowRect.height) / 2,
      behavior: 'smooth',
    })
  }
  return true
}

// ————————————————————————— 光照 / 视图 —————————————————————————

function onLightInput(key: LightSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  lightSettings[key] = value
  viewer?.setLightSettings({ [key]: value } as Partial<LightSettings>)
}

function resetLights(): void {
  const defaults = viewer?.resetLightSettings() ?? { ...DEFAULT_LIGHT_SETTINGS }
  Object.assign(lightSettings, defaults)
}

function setViewOption(key: ViewOptionKey, value: boolean): void {
  view[key] = value
  if (!viewer) return
  if (key === 'grid') viewer.setGridVisible(value)
  else if (key === 'axes') viewer.setAxesVisible(value)
  else if (key === 'autoRotate') viewer.setAutoRotate(value)
  else viewer.setWireframe(value)
}

function resetView(): void {
  viewer?.resetView()
}

// ————————————————————————— 爆炸图 —————————————————————————

function onExplodeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  explodeAmount.value = value
  viewer?.setExplode(value)
}

// ————————————————————————— 后处理 —————————————————————————

function setBloomEnabled(enabled: boolean): void {
  bloomSettings.enabled = enabled
  viewer?.setBloomSettings({ enabled })
}

function onBloomInput(key: BloomSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  bloomSettings[key] = value
  viewer?.setBloomSettings({ [key]: value })
}

function setOutlineEnabled(enabled: boolean): void {
  outlineSettings.enabled = enabled
  viewer?.setOutlineSettings({ enabled })
}

function onOutlineInput(key: OutlineSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  outlineSettings[key] = value
  viewer?.setOutlineSettings({ [key]: value })
}

function onOutlineColor(): void {
  const value = Number.parseInt(outlineColorHex.value.slice(1), 16)
  if (Number.isNaN(value)) return
  outlineSettings.color = value
  viewer?.setOutlineSettings({ color: value })
}

function setHoverOutlineEnabled(enabled: boolean): void {
  hoverOutlineSettings.enabled = enabled
  viewer?.setHoverOutlineSettings({ enabled })
}

function onHoverOutlineInput(key: HoverOutlineSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  hoverOutlineSettings[key] = value
  viewer?.setHoverOutlineSettings({ [key]: value })
}

function onHoverOutlineColor(): void {
  const value = Number.parseInt(hoverOutlineColorHex.value.slice(1), 16)
  if (Number.isNaN(value)) return
  hoverOutlineSettings.color = value
  viewer?.setHoverOutlineSettings({ color: value })
}

function resetPostFx(): void {
  if (!viewer) return
  const next = viewer.resetPostFxSettings()
  Object.assign(bloomSettings, next.bloom)
  Object.assign(outlineSettings, next.outline)
  Object.assign(hoverOutlineSettings, next.hoverOutline)
  outlineColorHex.value = `#${outlineSettings.color.toString(16).padStart(6, '0')}`
  hoverOutlineColorHex.value = `#${hoverOutlineSettings.color.toString(16).padStart(6, '0')}`
}

// ————————————————————————— 选中部件 / 动画 —————————————————————————

const exporting = ref(false)
const exportNote = ref('')
const exportFailed = ref(false)
let exportNoteTimer: number | undefined

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function showExportNote(text: string, failed = false): void {
  exportNote.value = text
  exportFailed.value = failed
  if (exportNoteTimer !== undefined) window.clearTimeout(exportNoteTimer)
  exportNoteTimer = window.setTimeout(() => {
    exportNote.value = ''
  }, 4000)
}

/** 导出当前选中部件(含子树)为 GLB 文件,成功后浏览器自动下载。 */
async function exportSelectedPart(): Promise<void> {
  if (!viewer || exporting.value) return
  exporting.value = true
  try {
    const result: GlbExportResult | null = await viewer.exportSelected()
    if (result) {
      showExportNote(`已导出 ${result.fileName}(${formatBytes(result.bytes)})`)
    } else {
      showExportNote('导出失败,详见控制台', true)
    }
  } finally {
    exporting.value = false
  }
}

function toggleAnimation(): void {
  if (!viewer) return
  viewer.setAnimationPlaying(!animation.playing)
  Object.assign(animation, viewer.getAnimationState())
}

function onClipChange(event: Event): void {
  const index = Number((event.target as HTMLSelectElement).value)
  viewer?.playAnimation(index)
  if (viewer) Object.assign(animation, viewer.getAnimationState())
}

function onSpeedInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  animation.speed = value
  viewer?.setAnimationSpeed(value)
}

// ————————————————————————— 文件导入 —————————————————————————

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function isGlbFile(file: File): boolean {
  return /\.(glb|gltf)$/i.test(file.name)
}

async function loadFile(file: File): Promise<void> {
  if (!viewer) return
  if (!isGlbFile(file)) {
    Object.assign(status, {
      state: 'error',
      fileName: file.name,
      progress: null,
      message: '只支持 .glb / .gltf 文件(单文件格式,贴图需内嵌)',
    } satisfies GlbLoadStatus)
    return
  }
  await viewer.loadFromFile(file)
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void loadFile(file)
}

async function loadSample(sample: { url: string; fileName: string }): Promise<void> {
  await viewer?.loadFromUrl(sample.url, sample.fileName)
}

function dismissError(): void {
  status.state = stats.value ? 'ready' : 'idle'
  status.message = ''
}

function onDragEnter(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) dragging.value = true
}

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (!current || !next || !current.contains(next)) dragging.value = false
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void loadFile(file)
}
</script>

<style scoped lang="scss">
.glb-lab {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 620px;
  overflow: hidden;
  color: #ecfaf6;
  background: #071116;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}
.viewport {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.viewport :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

/* ————— 顶部工具栏(导入 / 示例 / 导出) ————— */
.top-bar {
  position: absolute;
  top: 16px;
  left: 50%;
  z-index: 6;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 34%);
  border-radius: 22px;
  box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
  backdrop-filter: blur(10px);
  transform: translateX(-50%);
}
.top-button {
  padding: 6px 14px;
  color: #06201d;
  background: #79e6ca;
  border: 1px solid #b4ffeb;
  border-radius: 16px;
  font:
    600 10px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
  white-space: nowrap;
}
.top-button:hover:not(:disabled) {
  background: #9ff1dc;
  box-shadow: 0 0 12px rgb(121 230 202 / 45%);
}
.top-button:disabled {
  color: #5d7a75;
  background: rgb(30 63 65 / 55%);
  border-color: rgb(121 230 202 / 18%);
  cursor: not-allowed;
}
.top-button.subtle {
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border-color: rgb(121 230 202 / 22%);
  font-weight: 500;
}
.top-button.subtle:hover,
.top-button.subtle.active {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
  box-shadow: none;
}
.top-divider {
  width: 1px;
  height: 16px;
  background: rgb(121 230 202 / 26%);
}

/* ————— 空状态引导 ————— */
.empty-state {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.empty-card {
  padding: 34px 46px 28px;
  text-align: center;
  background: rgb(7 17 22 / 86%);
  border: 2px dashed rgb(121 230 202 / 42%);
  border-radius: 10px;
  backdrop-filter: blur(6px);
  pointer-events: auto;
}
.empty-card h2 {
  margin: 0 0 10px;
  color: #d8fff5;
  font:
    700 17px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  letter-spacing: 0.04em;
}
.empty-card p {
  margin: 0 0 16px;
  color: #8fb8b0;
  font:
    400 11px/1.5 ui-sans-serif,
    system-ui,
    sans-serif;
}
.empty-card p strong {
  color: #b4ffeb;
}
.empty-primary {
  padding: 9px 26px;
  color: #06201d;
  background: #79e6ca;
  border: 1px solid #b4ffeb;
  border-radius: 4px;
  font:
    600 12px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.empty-primary:hover {
  background: #9ff1dc;
  box-shadow: 0 0 16px rgb(121 230 202 / 50%);
}
.empty-samples {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  margin-top: 18px;
  color: #638f88;
  font:
    400 9.5px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.empty-samples button {
  padding: 4px 10px;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.empty-samples button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}
.panel {
  position: absolute;
  top: 16px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  /* 内容盒下 max-height 不含 padding/border,面板会顶到窗口底部,这里按边框盒算 */
  box-sizing: border-box;
  max-height: calc(100% - 60px);
  padding: 12px 13px;
  color: #d8fff5;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 30%);
  border-radius: 6px;
  box-shadow: 0 12px 30px rgb(0 0 0 / 26%);
  backdrop-filter: blur(10px);
}
.tree-panel {
  left: 16px;
  width: 288px;
}
.inspector {
  right: 16px;
  width: 246px;
  overflow-y: auto;
}
.inspector::-webkit-scrollbar,
.tree-list::-webkit-scrollbar {
  width: 5px;
}
.inspector::-webkit-scrollbar-thumb,
.tree-list::-webkit-scrollbar-thumb {
  background: rgb(121 230 202 / 25%);
  border-radius: 3px;
}
.panel-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: #9ff1dc;
  font:
    700 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.11em;
}
.panel-heading small {
  color: #638f88;
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.05em;
}

/* ————— 模型树 ————— */
.toolbar {
  display: grid;
  flex: none;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-bottom: 8px;
}
.toolbar button {
  padding: 4px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.toolbar button:hover:not(:disabled) {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}
.toolbar button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tree-filter {
  flex: none;
  width: 100%;
  padding: 6px 8px;
  color: #d8fff5;
  background: rgb(11 30 33 / 80%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    400 10px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  outline: none;
}
.tree-filter::placeholder {
  color: #4d7771;
}
.tree-filter:focus {
  border-color: rgb(121 230 202 / 55%);
}
.tree-legend {
  flex: none;
  margin: 7px 0 6px;
  color: #557873;
  font:
    400 8px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.tree-list {
  flex: 1;
  min-height: 80px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.tree-row {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 3px 6px 3px 0;
  border-radius: 3px;
  font:
    400 10px/1.4 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: background 0.12s ease;
}
.tree-row:hover,
.tree-row.hovered {
  background: rgb(121 230 202 / 12%);
}
.tree-row.selected {
  color: #04222b;
  background: #7cd9ff;
}
.tree-row.locating {
  animation: row-locate 1.4s ease-out;
}
@keyframes row-locate {
  0% {
    box-shadow: 0 0 0 2px #b4ffeb inset;
    background: #b4ffeb;
  }
  60% {
    box-shadow: 0 0 0 2px rgb(180 255 235 / 55%) inset;
    background: #7cd9ff;
  }
  100% {
    box-shadow: 0 0 0 2px rgb(180 255 235 / 0%) inset;
  }
}
.tree-row.hidden .tree-name,
.tree-row.hidden .kind-chip,
.tree-row.hidden .tree-meta,
.tree-row.hidden .tree-toggle {
  opacity: 0.4;
}
/* 显隐开关:自绘外观,勾选 / 未勾选 / 被父级连坐 / 子树部分隐藏 四种状态一眼可辨 */
.tree-check {
  position: relative;
  flex: none;
  width: 12px;
  height: 12px;
  margin: 0;
  appearance: none;
  background: rgb(4 34 43 / 55%);
  border: 1px solid rgb(121 230 202 / 42%);
  border-radius: 2px;
  cursor: pointer;
  transition: 0.15s ease;
}
.tree-check:hover {
  border-color: #7cd9ff;
}
.tree-check:checked,
.tree-check:indeterminate {
  background: #7cd9ff;
  border-color: #7cd9ff;
}
.tree-check:checked::after {
  position: absolute;
  top: 1px;
  left: 3.5px;
  width: 3px;
  height: 6px;
  border: solid #04222b;
  border-width: 0 1.5px 1.5px 0;
  content: '';
  transform: rotate(45deg);
}
.tree-check:indeterminate::after {
  position: absolute;
  top: 4.5px;
  left: 2px;
  width: 6px;
  height: 1.5px;
  background: #04222b;
  content: '';
}
/* 自己开着、却被祖先连坐隐藏:空心虚线框,提示点一下会连带恢复父级 */
.tree-check.inherited {
  background: transparent;
  border-color: rgb(121 230 202 / 32%);
  border-style: dashed;
}
.tree-check.inherited:hover {
  background: rgb(124 217 255 / 18%);
  border-color: #7cd9ff;
}
.tree-row.selected .tree-check:not(.inherited) {
  border-color: rgb(4 34 43 / 40%);
}
.tree-row.selected .tree-check:checked,
.tree-row.selected .tree-check:indeterminate {
  background: #04222b;
  border-color: #04222b;
}
.tree-row.selected .tree-check:checked::after {
  border-color: #7cd9ff;
}
.tree-row.selected .tree-check:indeterminate::after {
  background: #7cd9ff;
}
.tree-toggle {
  flex: none;
  width: 12px;
  padding: 0;
  color: inherit;
  background: none;
  border: 0;
  font-size: 9px;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  opacity: 0.8;
}
.tree-toggle.placeholder {
  cursor: default;
}
.kind-chip {
  flex: none;
  min-width: 30px;
  padding: 1px 3px;
  color: #8fd9c8;
  background: rgb(121 230 202 / 12%);
  border-radius: 2px;
  font:
    600 7.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-align: center;
}
.tree-row.selected .kind-chip {
  color: #063741;
  background: rgb(4 34 43 / 22%);
}
.kind-mesh {
  color: #9ff1dc;
}
.kind-skinnedMesh {
  color: #b8c6ff;
}
.kind-group {
  color: #7fb3a9;
}
.kind-light {
  color: #ffd98a;
  background: rgb(255 217 138 / 14%);
}
.kind-camera {
  color: #ffb0d8;
  background: rgb(255 176 216 / 14%);
}
.kind-bone {
  color: #c9b6ff;
  background: rgb(201 182 255 / 14%);
}
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tree-meta {
  flex: none;
  color: #638f88;
  font:
    500 8px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.tree-row.selected .tree-meta {
  color: #0a4a57;
}
.tree-empty,
.tree-hint {
  flex: none;
  margin: 6px 0 0;
  color: #638f88;
  font:
    400 8.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.tree-hint {
  color: #c9a15a;
}

/* ————— 检查器 ————— */
.section {
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid rgb(121 230 202 / 16%);
}
.section:first-of-type {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.section h3 {
  margin: 0 0 8px;
  color: #9ff1dc;
  font:
    700 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.1em;
}
.slider-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 3px 8px;
  align-items: center;
  margin-bottom: 7px;
}
.slider-label {
  color: #bfe8de;
  font:
    500 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.slider-row strong {
  color: #d8fff5;
  font:
    600 9.5px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-align: right;
}
.slider-row input[type='range'] {
  grid-column: 1 / -1;
  width: 100%;
  height: 3px;
  accent-color: #79e6ca;
  cursor: pointer;
}
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: #bfe8de;
  font:
    500 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.segmented {
  display: grid;
  gap: 4px;
}
.segmented.two {
  width: 84px;
  grid-template-columns: repeat(2, 1fr);
}
.segmented button {
  padding: 3px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.segmented button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
}
.segmented button.active {
  color: #06201d;
  background: #79e6ca;
  border-color: #b4ffeb;
}
.outline-toggle {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed rgb(121 230 202 / 14%);
}
.slider-row.disabled,
.toggle-row.disabled {
  opacity: 0.42;
}
.color-input {
  width: 46px;
  height: 20px;
  padding: 1px 2px;
  background: rgb(11 30 33 / 85%);
  border: 1px solid rgb(121 230 202 / 25%);
  border-radius: 3px;
  cursor: pointer;
}
.color-input:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.wide-button {
  width: 100%;
  margin-top: 4px;
  padding: 5px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.wide-button:hover:not(:disabled) {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}
.wide-button.primary {
  color: #06201d;
  background: #79e6ca;
  border-color: #b4ffeb;
  font-weight: 600;
}
.wide-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 8px;
  margin: 0;
}
.info-grid > div {
  min-width: 0;
}
.info-grid > div.wide {
  grid-column: 1 / -1;
}
.info-grid dt {
  margin-bottom: 2px;
  color: #638f88;
  font:
    700 7.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.07em;
}
.info-grid dd {
  margin: 0;
  overflow: hidden;
  color: #d8fff5;
  font:
    500 9.5px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.selected-name {
  margin: 0 0 6px;
  overflow: hidden;
  color: #b4ffeb;
  font:
    600 10.5px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.export-note {
  margin: 5px 0 0;
  color: #9ff1dc;
  font:
    500 8.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  word-break: break-all;
}
.export-note.error {
  color: #ff9d9d;
}
.button-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-top: 8px;
}
.button-row button {
  padding: 4px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.button-row button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
}
.mono-note {
  display: grid;
  place-items: center;
  color: #7fb3a9;
  font:
    500 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.clip-select {
  width: 100%;
  margin-bottom: 6px;
  padding: 5px 6px;
  color: #d8fff5;
  background: rgb(11 30 33 / 85%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    400 9.5px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  outline: none;
}
.usage-note {
  margin: 0;
  color: #638f88;
  font:
    400 9px/1.6 ui-sans-serif,
    system-ui,
    sans-serif;
}

/* ————— 提示 / 遮罩 ————— */
.hint-bar {
  position: absolute;
  bottom: 14px;
  left: 50%;
  z-index: 5;
  padding: 6px 12px;
  color: #638f88;
  background: rgb(7 17 22 / 78%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 20px;
  font:
    500 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
  white-space: nowrap;
  transform: translateX(-50%);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.loading-card,
.error-card {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 8;
  width: 280px;
  padding: 18px 18px 16px;
  color: #d8fff5;
  background: rgb(7 17 22 / 94%);
  border: 1px solid rgb(121 230 202 / 34%);
  border-radius: 6px;
  box-shadow: 0 16px 40px rgb(0 0 0 / 40%);
  text-align: center;
  transform: translate(-50%, -50%);
}
.loading-card p {
  margin: 10px 0 12px;
  overflow: hidden;
  font:
    600 11px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.loading-card small {
  display: block;
  margin-top: 8px;
  color: #638f88;
  font:
    500 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.spinner {
  display: inline-block;
  width: 22px;
  height: 22px;
  border: 2px solid rgb(121 230 202 / 25%);
  border-top-color: #79e6ca;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.progress-track {
  height: 3px;
  overflow: hidden;
  background: rgb(121 230 202 / 15%);
  border-radius: 2px;
}
.progress-track i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #79e6ca, #9ff1dc);
  transition: width 0.2s ease;
}
.error-card {
  border-color: rgb(255 138 138 / 42%);
}
.error-card strong {
  display: block;
  margin-bottom: 6px;
  color: #ff9d9d;
  font:
    700 10px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}
.error-card p {
  margin: 0 0 12px;
  color: #ffd6d6;
  font:
    400 10px/1.5 ui-sans-serif,
    system-ui,
    sans-serif;
  word-break: break-all;
}
.error-card button {
  padding: 5px 16px;
  color: #2a0d0d;
  background: #ff9d9d;
  border: 0;
  border-radius: 3px;
  font:
    600 9.5px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
}
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 9;
  display: grid;
  place-items: center;
  background: rgb(3 12 16 / 74%);
  border: 2px dashed rgb(121 230 202 / 55%);
  pointer-events: none;
}
.drop-overlay div {
  padding: 14px 26px;
  color: #d8fff5;
  background: rgb(7 17 22 / 90%);
  border: 1px solid rgb(121 230 202 / 45%);
  border-radius: 6px;
  font:
    700 12px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}
.file-input {
  display: none;
}
</style>
