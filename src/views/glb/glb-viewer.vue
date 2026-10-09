<template>
  <main
    class="glb-lab"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- ————— 3D 视口:Three.js 画布挂载点,模型的渲染与拾取都在这里 ————— -->
    <div ref="viewportRef" class="viewport" aria-label="模型查看视口"></div>

    <!-- ————— 顶部工具栏:导入 / 导出 ————— -->
    <header class="top-bar" aria-label="模型导入导出">
      <button class="top-button primary" type="button" @click="openFilePicker">⬆ 导入模型</button>
      <button
        v-if="isolatedId !== null"
        class="top-button solo"
        type="button"
        @click="exitIsolate"
      >
        ⊙ 只看:<b>{{ isolatedName }}</b> · 显示全部
      </button>
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
        <h2>模型查看器</h2>
        <p>把 <strong>{{ SUPPORTED_TEXT }}</strong> 文件拖到页面任意位置即可载入</p>
        <button class="empty-primary" type="button" @click="openFilePicker">选择模型文件…</button>
        <p class="empty-tip">
          带贴图 / 材质库的模型(FBX、OBJ 等)请把贴图与 <code>.mtl</code> 一并选中,否则只会用默认材质
        </p>
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

      <div class="toolbar one">
        <button
          type="button"
          class="solo-button"
          :class="{ active: isolatedId !== null }"
          :disabled="selectedId === null && isolatedId === null"
          :title="
            isolatedId !== null
              ? '显示全部部件,退出只看模式'
              : '隐藏其余全部部件,只显示当前选中部件'
          "
          @click="toggleIsolate()"
        >
          {{ isolatedId !== null ? '⊙ 显示全部' : '⊙ 只看选中部件' }}
        </button>
      </div>

      <!-- 只看模式横幅:明确告知"现在只有这一件是可见的",并给一键退出的出口 -->
      <div v-if="isolatedId !== null" class="isolate-bar">
        <span>只看:<b>{{ isolatedName }}</b></span>
        <button type="button" @click="exitIsolate">显示全部</button>
      </div>

      <input
        v-model.trim="keyword"
        class="tree-filter"
        type="search"
        placeholder="搜索部件名称…"
        aria-label="搜索部件名称"
      />

      <p class="tree-legend">
        <span>单击选中 · 双击聚焦 · 悬停预览 · ◎ 只看该部件</span>
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
            solo: row.node.id === isolatedId,
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
          <button
            type="button"
            class="tree-solo"
            :class="{ active: row.node.id === isolatedId }"
            :title="row.node.id === isolatedId ? '显示全部部件' : `只看「${row.node.name}」`"
            :aria-label="row.node.id === isolatedId ? '显示全部部件' : `只看${row.node.name}`"
            @click.stop="toggleIsolate(row.node.id)"
          >
            ◎
          </button>
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
          <div>
            <dt>骨节</dt>
            <dd>{{ stats.bones }}</dd>
          </div>
          <div>
            <dt>动画</dt>
            <dd>{{ stats.animations }}</dd>
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
        <button
          class="wide-button ghost"
          type="button"
          :title="
            isolatedId === nodeInfo.id
              ? '显示其余全部部件'
              : '隐藏其余全部部件,只显示这一个部件'
          "
          @click="toggleIsolate(nodeInfo.id)"
        >
          {{ isolatedId === nodeInfo.id ? '⊙ 显示全部部件' : '⊙ 只看这个部件' }}
        </button>
        <button class="wide-button" type="button" :disabled="exporting" @click="exportSelectedPart">
          {{ exporting ? '正在导出…' : '导出选中部件为 GLB' }}
        </button>
        <p v-if="exportNote" class="export-note" :class="{ error: exportFailed }">
          {{ exportNote }}
        </p>
      </section>

      <section v-if="animation.names.length" class="section">
        <h3>骨骼动画</h3>
        <select class="clip-select" :value="animation.index" @change="onClipChange">
          <option v-for="(name, index) in animation.names" :key="index" :value="index">
            {{ name }}
          </option>
        </select>

        <div class="timeline">
          <input
            class="timeline-range"
            type="range"
            min="0"
            :max="animation.duration || 1"
            :step="timelineStep"
            :value="animation.time"
            @pointerdown="beginScrub"
            @input="onSeekInput"
            @change="endScrub"
          />
          <div class="timeline-meta">
            <span data-testid="anim-time">{{ formatTime(animation.time) }}</span>
            <span>{{ formatTime(animation.duration) }}</span>
          </div>
        </div>

        <div class="button-row">
          <button type="button" data-testid="anim-prev-frame" @click="stepFrame(-1)">
            ◀ 上一帧
          </button>
          <button type="button" data-testid="anim-toggle" @click="toggleAnimation">
            {{ animation.playing ? '暂停' : '播放' }}
          </button>
          <button type="button" data-testid="anim-next-frame" @click="stepFrame(1)">
            下一帧 ▶
          </button>
        </div>
        <div class="button-row two">
          <button type="button" data-testid="anim-restart" @click="restartAnimation">
            重新播放
          </button>
          <button type="button" data-testid="anim-loop" @click="cycleLoopMode">
            {{ LOOP_LABELS[animation.loop] }}
          </button>
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
        <div class="button-row three">
          <button
            v-for="preset in SPEED_PRESETS"
            :key="preset"
            type="button"
            :class="{ active: Math.abs(animation.speed - preset) < 0.01 }"
            @click="setAnimationSpeed(preset)"
          >
            {{ preset }}×
          </button>
        </div>
      </section>

      <section v-if="skeleton.bones > 0" class="section">
        <h3>骨骼</h3>
        <div class="toggle-row">
          <span>显示骨架辅助线</span>
          <div class="segmented two">
            <button
              type="button"
              data-testid="skeleton-on"
              :class="{ active: skeleton.visible }"
              @click="setSkeleton(true)"
            >
              开
            </button>
            <button
              type="button"
              data-testid="skeleton-off"
              :class="{ active: !skeleton.visible }"
              @click="setSkeleton(false)"
            >
              关
            </button>
          </div>
        </div>
        <dl class="info-grid">
          <div>
            <dt>骨节</dt>
            <dd>{{ skeleton.bones }}</dd>
          </div>
          <div>
            <dt>骨链</dt>
            <dd>{{ skeleton.roots.length }}</dd>
          </div>
          <div>
            <dt>单帧</dt>
            <dd>{{ (animation.frameStep * 1000).toFixed(0) }} ms</dd>
          </div>
          <div>
            <dt>帧率</dt>
            <dd>{{ (1 / Math.max(animation.frameStep, 1e-6)).toFixed(0) }} fps</dd>
          </div>
          <div class="wide">
            <dt>骨架</dt>
            <dd :title="skeleton.roots.join(', ')">{{ skeleton.rigs.join(', ') || '—' }}</dd>
          </div>
        </dl>
        <p class="usage-note">
          亮青线 = 骨节链,暗线 = 骨节驱动到的网格中心,红绿蓝短轴 = 骨节局部 XYZ。
        </p>
      </section>

      <section class="section">
        <h3>操作提示</h3>
        <p class="usage-note">
          导入 / 导出入口在顶部工具栏;把模型文件({{ SUPPORTED_TEXT }})拖到页面任意位置也能直接载入。
          选中部件后可一键导出,或点「只看这个部件」把其余部件全部隐藏,专心看它。
        </p>
      </section>
    </aside>

    <!-- ————— 底部辅助层:操作提示 / 载入进度 / 载入失败 / 拖拽遮罩 / 隐藏的文件选择框 ————— -->
    <div class="hint-bar">
      拖拽模型到窗口即可导入 · 单击选中部件 · 双击聚焦 · ◎ 只看该部件 · 滚轮缩放 · 右键平移
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
      <div>释放以导入模型</div>
    </div>

    <input
      ref="fileInputRef"
      class="file-input"
      type="file"
      multiple
      :accept="MODEL_ACCEPT"
      @change="onFileChange"
    />
  </main>
</template>

<script setup lang="ts">
/**
 * 模型查看器页面(路由 /glb)。
 *
 * 职责:左侧渲染模型树、右侧检查器(光照 / 视图 / 后处理 / 模型信息 / 选中部件 / 骨骼动画),
 * 画布支持拖拽导入、点选与悬停,可把选中部件(含子树)导出为 GLB,
 * 也可「只看当前部件」(隐藏其余部件,专心看一件)。
 *
 * 支持格式由 src/lib/three-engine/model-loaders.ts 决定:glb / gltf / fbx / obj / stl / ply / dae。
 * 带外部资源的格式(FBX 贴图、OBJ 的 .mtl)需要与模型文件一起选中。
 *
 * 底层全部委托给 src/lib/three-engine/glb-viewer.ts 的 GlbViewer:本组件只把引擎状态
 * (树 / 统计 / 动画 / 后处理参数)同步成 UI,再把用户操作回传给引擎。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { GlbViewer, DEFAULT_LIGHT_SETTINGS } from '../../lib/three-engine/glb-viewer'
import type {
  GlbAnimationLoopMode,
  GlbAnimationState,
  GlbExportResult,
  GlbLoadStatus,
  GlbModelStats,
  GlbNodeInfo,
  GlbNodeKind,
  GlbRigInfo,
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
import {
  isModelFile,
  MODEL_ACCEPT_ATTRIBUTE,
  SUPPORTED_EXTENSIONS_TEXT,
} from '../../lib/three-engine/model-loaders'

/** 模板里直接用这两个常量:文件对话框的过滤规则、以及"支持哪些格式"的文案。 */
const MODEL_ACCEPT = MODEL_ACCEPT_ATTRIBUTE
const SUPPORTED_TEXT = SUPPORTED_EXTENSIONS_TEXT

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

/** 模型树一次最多渲染的行数:超大模型整树拍平会拖垮渲染,超出部分靠搜索缩小范围。 */
const MAX_ROWS = 800
/** 节点类型 → 树里 kind-chip 的中文标签。 */
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

/** 内置示例模型(fileName 用于与 status.fileName 比对,高亮当前选中的示例)。 */
const SAMPLES = [
  {
    label: 'DJI Mini 4 Pro(语义化节点)',
    url: '/models/djiair_renamed.glb',
    fileName: 'djiair_renamed.glb',
  },
  { label: 'DJI Air(原始模型)', url: '/models/djiair.glb', fileName: 'djiair.glb' },
  // 同一份 Tesla 资产也被 /tesla 整车交互页复用;这里放进示例是为了能用通用查看器逐节点检视它
  {
    label: 'Tesla Model 3(四门/四轮/灯可动)',
    url: '/models/2024_tesla_model_3_rigged.glb',
    fileName: '2024_tesla_model_3_rigged.glb',
  },
]

/** 检查器"光照强度"各滑杆的配置(含各自量程上限)。 */
const LIGHT_ROWS: Array<{ key: LightSettingsKey; label: string; max: number }> = [
  { key: 'ambient', label: '环境光', max: 4 },
  { key: 'key', label: '主光', max: 6 },
  { key: 'fill', label: '补光', max: 6 },
  { key: 'rim', label: '轮廓光', max: 6 },
  { key: 'exposure', label: '曝光', max: 3 },
]

/** 检查器"视图"区的开关项,key 直接对应 GlbViewOptions 的字段名。 */
const VIEW_OPTIONS: Array<{ key: ViewOptionKey; label: string }> = [
  { key: 'grid', label: '地面网格' },
  { key: 'axes', label: '坐标轴' },
  { key: 'autoRotate', label: '自动旋转' },
  { key: 'wireframe', label: '线框模式' },
]

/** 循环方式 → 按钮文案。 */
const LOOP_LABELS: Record<GlbAnimationLoopMode, string> = {
  repeat: '循环播放',
  pingpong: '往返播放',
  once: '单次播放',
}

/** 循环方式按钮的轮换顺序:折叠/展开这类动作默认往返最直观 */
const LOOP_CYCLE: GlbAnimationLoopMode[] = ['repeat', 'pingpong', 'once']

/** 播放速度快捷档位(倍速)。 */
const SPEED_PRESETS = [0.25, 0.5, 1, 2]

/** 泛光 Bloom 各滑杆的量程配置。 */
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

/** 选中描边各滑杆的量程配置。 */
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

/** 悬停描边各滑杆的量程配置。 */
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

/** 画布挂载点 / 隐藏的 file input / 树列表 DOM,均为模板 ref。 */
const viewportRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const treeListRef = ref<HTMLUListElement | null>(null)
/** 引擎实例与两个定时器句柄:轮询 FPS/动画状态、定位高亮的超时。 */
let viewer: GlbViewer | null = null
let pollTimer: number | undefined
let locateTimer: number | undefined

/** 节点 id → 父节点 id:画布点选时用来展开到该节点的整条祖先链。 */
const parentOf = new Map<number, number>()

/** 模型树数据,以及 keyword 过滤 + expanded 集合共同决定渲染出的行。 */
const tree = ref<GlbTreeNode[]>([])
const expanded = ref(new Set<number>())
const keyword = ref('')
/** 当前选中 / 悬停的节点 id(画布与树双向同步)。 */
const selectedId = ref<number | null>(null)
const hoverId = ref<number | null>(null)
/** 「只看」的隔离目标 id;null = 未开启隔离(显示全部部件)。 */
const isolatedId = ref<number | null>(null)
/** 刚刚被"定位"到的行(画布点选触发),短暂高亮提示用。 */
const locatingId = ref<number | null>(null)
/** 整模统计 / 选中节点详情 / 实时帧率 / 是否正在拖拽文件。 */
const stats = ref<GlbModelStats | null>(null)
const nodeInfo = ref<GlbNodeInfo | null>(null)
const fps = ref(0)
const dragging = ref(false)
/** 模板里按固定顺序遍历,直接引用上面的常量表。 */
const lightRows = LIGHT_ROWS
const viewOptions = VIEW_OPTIONS

/** 载入状态机(idle/loading/ready/error)与各面板参数,初值取自引擎/后处理的默认常量。 */
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
/** 视图开关 / 爆炸程度 / 动画播放器状态 / 骨架信息。 */
const view = reactive<GlbViewOptions>({
  grid: true,
  axes: true,
  autoRotate: false,
  wireframe: false,
})
const explodeAmount = ref(0)
/** 引擎判定模型是否可做爆炸图(排除不可拆部件后仍需 ≥2 个单元)。 */
const explodeAvailable = ref(false)
const animation = reactive<GlbAnimationState>({
  names: [],
  index: -1,
  playing: false,
  duration: 0,
  speed: 1,
  time: 0,
  frameStep: 1 / 30,
  loop: 'repeat',
})
const skeleton = reactive<GlbRigInfo>({
  bones: 0,
  roots: [],
  rigs: [],
  hasSkeleton: false,
  visible: false,
})

/** 时间轴步长:直接用动画自身的单帧时长,拖动时能停在任何一帧上 */
const timelineStep = computed(() => (animation.frameStep > 0 ? animation.frameStep : 1 / 30))

/** 是否已载入模型 / 检查器标题栏的 FPS 文案。 */
const hasModel = computed(() => stats.value !== null)
const fpsText = computed(() => (fps.value > 0 ? `FPS ${fps.value}` : 'FPS --'))
/** 进度条:progress 未知时给个固定非零值避免看着像卡住;已知时下限 4% 保证条宽可见。 */
const progressPercent = computed(() =>
  status.progress === null ? 12 : Math.max(4, Math.round(status.progress * 100)),
)
const progressText = computed(() =>
  status.progress === null ? '解析中…' : `${Math.round(status.progress * 100)}%`,
)
/** 模型树标题下的概要(N 节点 · M 网格)。 */
const treeSummary = computed(() => {
  if (!stats.value) return 'NO MODEL'
  return `${stats.value.nodes} NODES · ${stats.value.meshes} MESHES`
})

/** 隔离目标的显示名(在树里按 id 找;找不到时退回 id,避免横幅空着)。 */
const isolatedName = computed(() => {
  const id = isolatedId.value
  if (id === null) return ''
  const find = (nodes: GlbTreeNode[]): GlbTreeNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node
      const hit = find(node.children)
      if (hit) return hit
    }
    return null
  }
  return find(tree.value)?.name ?? `#${id}`
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

/** 兜底可见性:节点不在可见性表里时按"可见"处理。 */
const NO_VISIBILITY: NodeVisibility = { effective: true, inherited: false, partial: false }

/** 查节点实际可见性,查不到时回退 NO_VISIBILITY。 */
function visOf(id: number | null): NodeVisibility {
  if (id === null) return NO_VISIBILITY
  return visibilityMap.value.get(id) ?? NO_VISIBILITY
}

/** 检查器里选中节点的实际可见状态(会区分"自己关了"和"被父级连坐")。 */
const nodeVisibility = computed<NodeVisibility>(() => visOf(nodeInfo.value?.id ?? null))
/** 选中部件状态文案:区分"自己隐藏"与"被父级隐藏"、以及是否正在被"只看"。 */
const nodeStateText = computed(() => {
  const vis = nodeVisibility.value
  if (vis.effective && nodeInfo.value?.id === isolatedId.value) return '只看中 · 其余部件已隐藏'
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
/** 行数触顶(被 MAX_ROWS 截断)时,模板改用提示引导用户搜索。 */
const truncated = computed(() => rows.value.length >= MAX_ROWS)

/** 关键词是否命中该节点自身或其子树(命中祖先时整条分支都保留)。 */
function matches(node: GlbTreeNode, search: string): boolean {
  if (node.name.toLowerCase().includes(search)) return true
  return node.children.some((child) => matches(child, search))
}

/** 大数字紧凑显示(12345 → 12k)。 */
function formatCount(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

// ————————————————————————— 生命周期 —————————————————————————

/**
 * 挂载:创建 GlbViewer、接好状态/选中/悬停/动画回调,await init() 后同步默认参数,
 * 再起轮询刷新 FPS 与动画状态。init 是异步的,若期间实例已变(viewer !== instance)则放弃回写。
 */
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
  // 播放中由引擎每帧推进度,时间轴才跟得动(400ms 轮询只做结构性同步)
  instance.onAnimationTick = (state) => {
    animation.time = state.time
    if (animation.playing !== state.playing) animation.playing = state.playing
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

/** 卸载:清掉轮询/定位/导出提示三个定时器,销毁引擎并置空,避免定时器打到已卸载实例。 */
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
  // 换模型会连同隔离状态一起失效(旧快照已随模型释放)
  syncIsolate()
  Object.assign(animation, viewer.getAnimationState())
  Object.assign(skeleton, viewer.getRigInfo())
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

/**
 * 单击行:委托引擎选中(引擎再经 onSelect 回流刷新高亮与右侧详情)。
 * 隔离模式下点到一个"当前看不见"的部件时,把"只看"直接挪到它身上 ——
 * 否则选中的是个隐藏部件,画布上什么反应都没有,看着像坏了。
 */
function selectNode(id: number): void {
  const instance = viewer
  if (!instance) return
  if (instance.isIsolated() && !visOf(id).effective) {
    instance.isolate(id)
    syncIsolate()
    refreshTree()
  }
  instance.select(id)
}

/** 双击行:把相机聚焦到该部件。 */
function focusNode(id: number): void {
  viewer?.focusNode(id)
}

// ————————————————————————— 只看当前部件 —————————————————————————

/**
 * 切换"只看"模式。带 id 时只看该部件;不带 id 时以当前选中项为准,
 * 已处于隔离则退出(同一个按钮既能进也能出)。
 */
function toggleIsolate(id?: number): void {
  const instance = viewer
  if (!instance) return
  const target = id ?? selectedId.value
  if (target === null) return
  if (instance.getIsolatedId() === target) {
    instance.isolate(null)
  } else {
    instance.isolate(target)
    // 只看某件时顺手把它选中,右侧详情与描边才对得上
    instance.select(target)
  }
  syncIsolate()
  refreshTree()
}

/** 退出"只看",恢复进入前的可见性。 */
function exitIsolate(): void {
  viewer?.isolate(null)
  syncIsolate()
  refreshTree()
}

/** 把引擎里的隔离状态回读进本地 ref(toggleIsolate / 显隐变更 / 换模型后都要调)。 */
function syncIsolate(): void {
  isolatedId.value = viewer?.getIsolatedId() ?? null
}

/** 展开 / 折叠单个节点:Set 原地改不触发响应式,必须换新对象赋值。 */
function toggleExpand(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 展开全部:把所有有子节点的节点塞进展开集合。 */
function expandAll(): void {
  const next = new Set<number>()
  const collect = (node: GlbTreeNode): void => {
    if (node.children.length > 0) next.add(node.id)
    node.children.forEach(collect)
  }
  tree.value.forEach(collect)
  expanded.value = next
}

/** 折叠全部:清空展开集合。 */
function collapseAll(): void {
  expanded.value = new Set()
}

/** 取消画布与树的高亮(等价于让引擎选中 null)。 */
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
  // 引擎在手动改显隐时会自动退出"只看"模式,这里把状态同步回 UI
  syncIsolate()
  refreshTree()
}

/** 复选框 change:把"当前实际可见"取反,再统一交给 setNodeVisibility 处理。 */
function toggleRowVisible(id: number): void {
  setNodeVisibility(id, !visOf(id).effective)
}

/** 引擎把开关直接写在树节点对象上(非响应式引用),重新赋值数组才能让 computed 重新求值。 */
function refreshTree(): void {
  const instance = viewer
  if (!instance) return
  tree.value = [...instance.getTree()]
}

/** 复选框 title:按四态给出"点下去会怎样"的说明。 */
function checkHint(vis: NodeVisibility): string {
  if (vis.inherited) return '被父级隐藏 · 勾选会一并恢复父级'
  if (vis.partial) return '部分子级被隐藏 · 点击隐藏整个子树'
  return vis.effective ? '隐藏该部件' : '显示该部件'
}

/** 悬停树行时让引擎高亮对应部件,离开时清除。 */
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

/** 拖动某个光照滑杆:本地状态与引擎同步更新。 */
function onLightInput(key: LightSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  lightSettings[key] = value
  viewer?.setLightSettings({ [key]: value } as Partial<LightSettings>)
}

/** 恢复默认光照:优先用引擎给出的默认值,引擎不可用时退回本地常量。 */
function resetLights(): void {
  const defaults = viewer?.resetLightSettings() ?? { ...DEFAULT_LIGHT_SETTINGS }
  Object.assign(lightSettings, defaults)
}

/**
 * 切换视图开关。线框必须走引擎的 setWireframe(整体换共享材质):WebGL2 回退后端下
 * 运行中改 material.wireframe 会报无效枚举、网格直接消失,故不在此直接动材质属性。
 */
function setViewOption(key: ViewOptionKey, value: boolean): void {
  view[key] = value
  if (!viewer) return
  if (key === 'grid') viewer.setGridVisible(value)
  else if (key === 'axes') viewer.setAxesVisible(value)
  else if (key === 'autoRotate') viewer.setAutoRotate(value)
  else viewer.setWireframe(value)
}

/** 重置相机视角与轨道控制。 */
function resetView(): void {
  viewer?.resetView()
}

// ————————————————————————— 爆炸图 —————————————————————————

/**
 * 拖动爆炸图滑杆,把 0~1 的爆炸程度写入引擎。含蒙皮/骨节的部件被引擎排除在爆炸之外
 * (动画 mixer 每帧把骨架写回世界矩阵,会覆盖爆炸位移),因此可炸单元不足时该滑杆为禁用态。
 */
function onExplodeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  explodeAmount.value = value
  viewer?.setExplode(value)
}

// ————————————————————————— 后处理 —————————————————————————

/** 打开 / 关闭泛光,并同步各滑杆的可用性(enabled=false 时禁用)。 */
function setBloomEnabled(enabled: boolean): void {
  bloomSettings.enabled = enabled
  viewer?.setBloomSettings({ enabled })
}

/** 拖动泛光某项滑杆(strength/radius/threshold)。 */
function onBloomInput(key: BloomSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  bloomSettings[key] = value
  viewer?.setBloomSettings({ [key]: value })
}

/** 打开 / 关闭选中描边。 */
function setOutlineEnabled(enabled: boolean): void {
  outlineSettings.enabled = enabled
  viewer?.setOutlineSettings({ enabled })
}

/** 拖动选中描边某项滑杆(thickness/glow)。 */
function onOutlineInput(key: OutlineSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  outlineSettings[key] = value
  viewer?.setOutlineSettings({ [key]: value })
}

/** 选中颜色选择器:把 #rrggbb 解析成引擎使用的 0xrrggbb 整数。 */
function onOutlineColor(): void {
  const value = Number.parseInt(outlineColorHex.value.slice(1), 16)
  if (Number.isNaN(value)) return
  outlineSettings.color = value
  viewer?.setOutlineSettings({ color: value })
}

/** 打开 / 关闭悬停描边(与选中描边互相独立)。 */
function setHoverOutlineEnabled(enabled: boolean): void {
  hoverOutlineSettings.enabled = enabled
  viewer?.setHoverOutlineSettings({ enabled })
}

/** 拖动悬停描边某项滑杆(thickness/glow)。 */
function onHoverOutlineInput(key: HoverOutlineSettingsKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  hoverOutlineSettings[key] = value
  viewer?.setHoverOutlineSettings({ [key]: value })
}

/** 悬停颜色选择器:#rrggbb → 0xrrggbb。 */
function onHoverOutlineColor(): void {
  const value = Number.parseInt(hoverOutlineColorHex.value.slice(1), 16)
  if (Number.isNaN(value)) return
  hoverOutlineSettings.color = value
  viewer?.setHoverOutlineSettings({ color: value })
}

/** 后处理参数整体恢复默认,并同步两个颜色输入框。 */
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

/** 导出进行中标记 / 结果提示文案(成功或失败) / 提示自动消失的定时器。 */
const exporting = ref(false)
const exportNote = ref('')
const exportFailed = ref(false)
let exportNoteTimer: number | undefined

/** 字节数转可读单位(MB/KB/B)。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** 弹出导出结果提示,4 秒后自动消失(先清旧定时器,避免被上一次的提前清空)。 */
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

/** 播放 / 暂停切换,并回读引擎状态。 */
function toggleAnimation(): void {
  if (!viewer) return
  viewer.setAnimationPlaying(!animation.playing)
  Object.assign(animation, viewer.getAnimationState())
}

/** 切换动画片段:让引擎从头播放选中的片段。 */
function onClipChange(event: Event): void {
  const index = Number((event.target as HTMLSelectElement).value)
  viewer?.playAnimation(index)
  if (viewer) Object.assign(animation, viewer.getAnimationState())
}

/** 速度滑杆 input 事件 → 走 setAnimationSpeed。 */
function onSpeedInput(event: Event): void {
  setAnimationSpeed(Number((event.target as HTMLInputElement).value))
}

/** 设置播放倍速(本地状态 + 引擎同步)。 */
function setAnimationSpeed(value: number): void {
  animation.speed = value
  viewer?.setAnimationSpeed(value)
}

/** 秒 → "x.xxs" 时间轴文案。 */
function formatTime(seconds: number): string {
  return `${seconds.toFixed(2)}s`
}

/** 时间轴:拖拽时先暂停(松手后恢复),避免播放推进和手动定位互相打架。 */
let resumeAfterScrub = false

function beginScrub(): void {
  if (!viewer) return
  resumeAfterScrub = animation.playing
  if (animation.playing) {
    viewer.setAnimationPlaying(false)
    Object.assign(animation, viewer.getAnimationState())
  }
}

/** 拖动时间轴:本地时间与引擎 seek 同步(此时已暂停,不改播放状态)。 */
function onSeekInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  animation.time = value
  viewer?.seek(value)
}

/** 松手:若拖动前正在播放则恢复播放,并回读引擎状态。 */
function endScrub(): void {
  if (!viewer) return
  if (resumeAfterScrub) viewer.setAnimationPlaying(true)
  resumeAfterScrub = false
  Object.assign(animation, viewer.getAnimationState())
}

/** 逐帧步进(自动暂停,和视频播放器一致)。 */
function stepFrame(direction: number): void {
  if (!viewer) return
  viewer.stepFrame(direction)
  Object.assign(animation, viewer.getAnimationState())
}

/** 从头重新播放当前片段。 */
function restartAnimation(): void {
  if (!viewer) return
  viewer.restartAnimation()
  Object.assign(animation, viewer.getAnimationState())
}

/** 循环方式按 LOOP_CYCLE 顺序轮换(循环 → 往返 → 单次)。 */
function cycleLoopMode(): void {
  const current = LOOP_CYCLE.indexOf(animation.loop)
  const next = LOOP_CYCLE[(current + 1) % LOOP_CYCLE.length] ?? 'repeat'
  animation.loop = next
  viewer?.setLoopMode(next)
}

/** 打开 / 关闭骨架辅助线显示。 */
function setSkeleton(visible: boolean): void {
  skeleton.visible = visible
  viewer?.setSkeletonVisible(visible)
}

// ————————————————————————— 文件导入 —————————————————————————

/** 打开隐藏的文件选择框。 */
function openFilePicker(): void {
  fileInputRef.value?.click()
}

/**
 * 校验后交给引擎载入。多选是常态(FBX 的贴图、OBJ 的 .mtl 都要一起选),
 * 所以只要求"列表里至少有一个受支持的模型文件",其余文件按外部资源处理。
 */
async function loadFiles(files: File[]): Promise<void> {
  const instance = viewer
  if (!instance || files.length === 0) return
  if (!files.some((file) => isModelFile(file.name))) {
    Object.assign(status, {
      state: 'error',
      fileName: files.map((file) => file.name).join(', '),
      progress: null,
      message: `没有可载入的模型文件。支持 ${SUPPORTED_TEXT};贴图 / .mtl 可与模型一起选中`,
    } satisfies GlbLoadStatus)
    return
  }
  await instance.loadFromFiles(files)
}

/** file input change:取出全部文件后清空 value,保证连续导入同名文件也能再次触发。 */
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length) void loadFiles(files)
}

/**
 * 载入内置示例模型。注意是异步的:引擎要到载入完成后才更新 status/stats,期间
 * stats.fileName 仍是上一个模型的值 —— 切示例后要等它变化,再断言或比对高亮。
 */
async function loadSample(sample: { url: string; fileName: string }): Promise<void> {
  await viewer?.loadFromUrl(sample.url, sample.fileName)
}

/** 关掉错误弹窗:已有模型则回到 ready,否则回 idle。 */
function dismissError(): void {
  status.state = stats.value ? 'ready' : 'idle'
  status.message = ''
}

/** 仅当拖入的是文件(而非文本等)时才亮起遮罩。 */
function onDragEnter(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) dragging.value = true
}

/** 拖拽悬停:把光标改为复制样式。 */
function onDragOver(event: DragEvent): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

/**
 * 离开时判断是否真的离开了整页:dragleave 会因进入子元素而反复触发,
 * 只有 relatedTarget 不在当前元素内才算真正离开,否则遮罩会闪。
 */
function onDragLeave(event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (!current || !next || !current.contains(next)) dragging.value = false
}

/** 落下文件:关遮罩并把全部文件交给引擎(模型 + 贴图 / .mtl 一起拖进来即可)。 */
function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) void loadFiles(files)
}
</script>

<style scoped lang="scss">
/* ————— 页面根容器与 3D 视口(画布由引擎注入) ————— */
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
/* 只看模式的顶部提示按钮:金色以示"当前视图被过滤过",点它即可恢复全部 */
.top-button.solo {
  color: #ffe6a3;
  background: rgb(92 74 30 / 70%);
  border-color: rgb(255 217 138 / 48%);
  font-weight: 500;
}
.top-button.solo:hover {
  color: #06201d;
  background: #ffd98a;
  box-shadow: 0 0 12px rgb(255 217 138 / 40%);
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
/* 多格式导入的补充说明:比正文小一号、更淡,不抢主指引 */
/* ⚠️ 上边距必须是正值:曾用 -6px 想收紧按钮下方间隙,结果把整段文字压到按钮上(重叠 6px) */
.empty-card p.empty-tip {
  max-width: 330px;
  margin: 12px auto 14px;
  color: #638f88;
  font:
    400 9.5px/1.5 ui-sans-serif,
    system-ui,
    sans-serif;
}
.empty-card p.empty-tip code {
  padding: 0 3px;
  color: #9ff1dc;
  background: rgb(121 230 202 / 12%);
  border-radius: 2px;
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
/* ————— 侧栏面板通用外观(模型树 / 检查器共用) ————— */
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

/* 只看:树工具栏整行按钮 + 隔离横幅 + 行尾的 ◎ 按钮 */
.toolbar.one {
  grid-template-columns: 1fr;
}
.toolbar button.solo-button.active {
  color: #ffe6a3;
  background: rgb(92 74 30 / 65%);
  border-color: rgb(255 217 138 / 52%);
}
.isolate-bar {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 5px 8px;
  color: #ffe6a3;
  background: rgb(92 74 30 / 40%);
  border: 1px solid rgb(255 217 138 / 35%);
  border-radius: 3px;
  font:
    500 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.isolate-bar span {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.isolate-bar b {
  color: #fff3cf;
  font-weight: 700;
}
.isolate-bar button {
  flex: none;
  padding: 3px 8px;
  color: #ffe6a3;
  background: rgb(11 30 33 / 55%);
  border: 1px solid rgb(255 217 138 / 35%);
  border-radius: 3px;
  font:
    500 8.5px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
}
.isolate-bar button:hover {
  background: rgb(92 74 30 / 80%);
}
.tree-solo {
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  color: #638f88;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  font:
    500 10px/1 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  opacity: 0.4;
  transition: 0.15s ease;
}
.tree-row:hover .tree-solo,
.tree-row.selected .tree-solo {
  opacity: 0.9;
}
.tree-solo:hover {
  color: #ffe6a3;
  background: rgb(92 74 30 / 50%);
  border-color: rgb(255 217 138 / 45%);
  opacity: 1;
}
.tree-solo.active {
  color: #ffe6a3;
  background: rgb(92 74 30 / 70%);
  border-color: rgb(255 217 138 / 60%);
  opacity: 1;
}
/* 只看行:左侧金色竖条;与选中态叠加时保留选中底色,文字颜色才不会打架 */
.tree-row.solo {
  box-shadow: inset 2px 0 0 rgb(255 217 138 / 80%);
}
.tree-row.solo:not(.selected) {
  color: #ffe6a3;
  background: rgb(255 217 138 / 13%);
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
/* 只看按钮用金色:与导出(青色主按钮)区分开,避免误点 */
.wide-button.ghost {
  color: #ffe6a3;
  background: rgb(92 74 30 / 40%);
  border-color: rgb(255 217 138 / 35%);
}
.wide-button.ghost:hover:not(:disabled) {
  color: #06201d;
  background: #ffd98a;
  border-color: #ffe6a3;
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
.timeline {
  margin: 2px 0 8px;
}
.timeline-range {
  width: 100%;
  height: 3px;
  accent-color: #79e6ca;
  cursor: pointer;
}
.timeline-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #7fb3a9;
  font:
    500 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.button-row.two {
  grid-template-columns: repeat(2, 1fr);
}
.button-row.three {
  grid-template-columns: repeat(4, 1fr);
  margin-top: 4px;
}
.button-row button.active {
  color: #06201d;
  background: #79e6ca;
  border-color: #b4ffeb;
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
