<!--
  /models —— 模型批量工作台。

  与 /glb 的分工:/glb 是"一次看一个模型"的查看器,这里是"一次过一批"的处理台。
  页面自身不含任何解析逻辑,全部下沉到 three-engine 的库模块:
  - model-batch   批量编排(延迟读取来源 + 串行驱动 + 进度回调)
  - glb-inspect   二进制体检(不解码直读 GLB 容器,单模型毫秒级)
  - model-optimize 压缩(与 /glb 同一套 optimizeGlb)
  - zip-store     打包下载(store 模式,不重复压缩已压过的 glb)

  ⚠️ 只吃**自包含的 .glb**。带外部 .bin / 贴图的 .gltf 或 fbx/obj 无法从单个文件读出全貌,
  在文件选择阶段就拦掉(见 ACCEPT 与 addFiles),而不是让它们进来再报奇怪的解析错。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  auditScene,
  collectMetricsFromScene,
} from '../../lib/three-engine/model-audit'
import { loadModelFromFiles } from '../../lib/three-engine/model-loaders'
import { warmUpOptimizer } from '../../lib/three-engine/model-optimize'
import type { OptimizeAlgorithm } from '../../lib/three-engine/model-optimize'
import {
  batchTotals,
  createBatchItems,
  optimizedNameOf,
  runBatch,
  sourcesFromFiles,
} from '../../lib/three-engine/model-batch'
import type { BatchItem, BatchStage } from '../../lib/three-engine/model-batch'
import {
  collectMetricsFromGlb,
  imageDimensions,
  inspectGlbBytes,
  parseGlbContainer,
} from '../../lib/three-engine/glb-inspect'
import { createStoreZip, crc32, uniqueArchiveName } from '../../lib/three-engine/zip-store'

/** 只接受自包含的 glb —— 其余格式在批量场景下没法单文件处理。 */
const ACCEPT = '.glb'

/**
 * 压缩档位。与 /glb 的「模型体检」面板同名同义,避免同一个功能两处叫法不同。
 * 三档都只动几何与资源组织、不改外观。
 */
const OPTIMIZE_OPTIONS: Array<{ value: OptimizeAlgorithm; label: string; hint: string }> = [
  { value: 'none', label: '仅清理', hint: '去掉冗余节点与重复资源,精度不变' },
  { value: 'quantize', label: '量化', hint: '坐标/法线降到 16 位精度,肉眼几乎无差' },
  { value: 'meshopt', label: 'meshopt', hint: '几何压缩,体积最小(推荐)' },
]

/** 条目状态 → 中文标签(table 的「状态」列)。 */
const STAGE_LABELS: Record<BatchStage, string> = {
  pending: '待处理',
  auditing: '体检中…',
  audited: '已体检',
  optimizing: '压缩中…',
  optimized: '已完成',
  skipped: '已跳过',
  failed: '失败',
}

const fileInputRef = ref<HTMLInputElement | null>(null)
const items = ref<BatchItem[]>([])
const algorithm = ref<OptimizeAlgorithm>('meshopt')
const running = ref(false)
const dragging = ref(false)
const errorText = ref('')
const progress = ref({ done: 0, total: 0 })

/** 中止标志:runBatch 每条之间查一次,不打断正在处理的那一条。 */
let stopped = false
/** dragenter/dragleave 会为子元素冒泡,用计数抵消,否则拖过表格时提示会闪。 */
let dragDepth = 0
let warmTimer: number | undefined

const totals = computed(() => batchTotals(items.value))
const zipCount = computed(() => items.value.filter((item) => Boolean(item.output)).length)
const progressPercent = computed(() => {
  const { done, total } = progress.value
  return total > 0 ? Math.round((done / total) * 100) : 0
})

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

/** 触发浏览器下载,并延迟回收 object URL(立刻回收会让下载拿不到数据)。 */
function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * 收下一批文件。
 * 非 .glb 的会被挡在门外并给出提示 —— 与其让它们进来再报"不是自包含的 glb",
 * 不如在入口说清"这里只处理单一 glb 文件"。
 */
function addFiles(files: readonly File[]): void {
  const accepted = files.filter((file) => /\.glb$/i.test(file.name))
  const rejected = files.length - accepted.length
  errorText.value = rejected
    ? `已忽略 ${rejected} 个非 .glb 文件 —— 批量处理只接受自包含的单一 glb`
    : ''
  if (!accepted.length) return

  const created = createBatchItems(sourcesFromFiles(accepted))
  // 按体积降序:批量场景下用户第一眼想看到的就是"谁最占地方"
  items.value = [...items.value, ...created].sort((a, b) => b.source.size - a.source.size)
}

function openPicker(): void {
  fileInputRef.value?.click()
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files?.length) addFiles(Array.from(input.files))
  // 清空 value,否则连续两次选同一个文件不会再触发 change
  input.value = ''
}

function onDragEnter(): void {
  dragDepth++
  dragging.value = true
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(event: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  const dropped = Array.from(event.dataTransfer?.files ?? [])
  if (dropped.length) addFiles(dropped)
}

function removeItem(id: string): void {
  if (running.value) return
  items.value = items.value.filter((item) => item.id !== id)
}

function clearAll(): void {
  if (running.value) return
  items.value = []
  errorText.value = ''
  progress.value = { done: 0, total: 0 }
}

/** 跑一批。体检 / 压缩可单独跑,也可以一起跑。 */
async function start(options: { audit: boolean; optimize: boolean }): Promise<void> {
  if (running.value || !items.value.length) return
  running.value = true
  stopped = false
  errorText.value = ''
  progress.value = { done: 0, total: items.value.length }

  try {
    await runBatch(items.value, {
      audit: options.audit,
      optimize: options.optimize,
      algorithm: algorithm.value,
      onProgress: (done, total) => {
        progress.value = { done, total }
      },
      shouldContinue: () => !stopped,
    })
  } catch (error) {
    errorText.value = `批处理中断:${error instanceof Error ? error.message : String(error)}`
  } finally {
    running.value = false
  }
}

function stop(): void {
  stopped = true
}

/** 把已有压缩产物打成一个 zip。包内文件名在源头去重,免得"压了 20 个只剩 8 个"。 */
function downloadZip(): void {
  const used = new Set<string>()
  const entries = items.value
    .filter((item) => Boolean(item.output))
    .map((item) => ({
      name: uniqueArchiveName(used, optimizedNameOf(item.source.name)),
      data: item.output as Uint8Array,
    }))
  if (!entries.length) return

  try {
    downloadBytes(createStoreZip(entries), 'models-optimized.zip', 'application/zip')
  } catch (error) {
    errorText.value = `打包失败:${error instanceof Error ? error.message : String(error)}`
  }
}

function downloadOne(item: BatchItem): void {
  if (!item.output) return
  downloadBytes(item.output, optimizedNameOf(item.source.name), 'model/gltf-binary')
}

onMounted(() => {
  // 压缩依赖有几百 KB,进页面就悄悄拉,别等点了「全部压缩」才开始下载
  warmTimer = window.setTimeout(() => void warmUpOptimizer(), 1200)
})

onUnmounted(() => {
  stopped = true
  if (warmTimer !== undefined) window.clearTimeout(warmTimer)
})

/**
 * 开发期调试出口:回归脚本用它做「字节口径 vs 场景口径」的交叉验证,以及读批处理状态。
 * 生产构建里整块被摇掉(与 /glb 的 __glbDebug 同一套约定),⚠️ 因此回归必须跑 dev server。
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__modelsDebug = {
    /**
     * 批处理运行状态快照。
     * 回归用它当「这一批跑完了吗」的判据 —— 只看 DOM 的「状态列都是终态」会被 Vue 的刷新
     * 时机骗到:点击后 DOM 还停在上一次的终态,于是刚开始跑就被判成已完成。
     * `running` 在 `start()` 里同步置位、`progress.done` 每处理完一条 +1,都没有刷新延迟。
     */
    batchState: () => ({
      running: running.value,
      done: progress.value.done,
      total: progress.value.total,
    }),
    inspectGlbBytes,
    collectMetricsFromGlb,
    parseGlbContainer,
    imageDimensions,
    createStoreZip,
    crc32,
    uniqueArchiveName,
    sourcesFromFiles,
    createBatchItems,
    runBatch,
    batchTotals,
    loadModelFromFiles,
    auditScene,
    collectMetricsFromScene,
  }
}
</script>

<template>
  <main
    class="workbench"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- ————— 工具条:添加 / 档位 / 体检 / 压缩 / 下载 ————— -->
    <header class="top-bar" aria-label="批量操作">
      <button class="top-button primary" type="button" :disabled="running" @click="openPicker">
        ⬆ 添加 .glb
      </button>
      <button
        class="top-button"
        type="button"
        :disabled="running || !items.length"
        @click="clearAll"
      >
        清空
      </button>

      <span class="top-divider" aria-hidden="true"></span>

      <div class="algo-group" role="group" aria-label="压缩档位">
        <button
          v-for="option in OPTIMIZE_OPTIONS"
          :key="option.value"
          class="algo-button"
          type="button"
          :class="{ active: algorithm === option.value }"
          :title="option.hint"
          :disabled="running"
          @click="algorithm = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <span class="top-divider" aria-hidden="true"></span>

      <button
        class="top-button"
        type="button"
        :disabled="running || !items.length"
        @click="start({ audit: true, optimize: false })"
      >
        🔍 全部体检
      </button>
      <button
        class="top-button"
        type="button"
        :disabled="running || !items.length"
        @click="start({ audit: false, optimize: true })"
      >
        压缩全部
      </button>
      <button
        class="top-button primary"
        type="button"
        :disabled="running || zipCount === 0"
        @click="downloadZip"
      >
        ⬇ 下载 zip<template v-if="zipCount"> ({{ zipCount }})</template>
      </button>
      <button v-if="running" class="top-button danger" type="button" @click="stop">停止</button>
    </header>

    <!-- ————— 汇总条:整批的体积账 + 进度 ————— -->
    <section v-if="items.length" class="summary" aria-label="汇总">
      <span class="summary-item">共 <b>{{ totals.count }}</b> 个</span>
      <span v-if="totals.optimized" class="summary-item">
        原始 <b>{{ formatBytes(totals.inputBytes) }}</b>
      </span>
      <span v-if="totals.optimized" class="summary-item">
        → <b>{{ formatBytes(totals.outputBytes) }}</b>
      </span>
      <span v-if="totals.optimized" class="summary-item saved">
        省 <b>{{ (totals.savedRatio * 100).toFixed(1) }}%</b>
      </span>
      <span v-if="totals.skipped" class="summary-item muted">跳过 {{ totals.skipped }}</span>
      <span v-if="totals.failed" class="summary-item failed">失败 {{ totals.failed }}</span>

      <template v-if="running">
        <div class="progress" role="progressbar" :aria-valuenow="progressPercent">
          <div class="progress-fill" :style="{ width: `${progressPercent}%` }"></div>
        </div>
        <span class="progress-text">{{ progress.done }} / {{ progress.total }}</span>
      </template>
    </section>

    <!-- ————— 明细表 ————— -->
    <section v-if="items.length" class="table-wrap">
      <table class="batch-table">
        <thead>
          <tr>
            <th class="col-name">文件</th>
            <th>体积</th>
            <th>三角面</th>
            <th>材质</th>
            <th>贴图</th>
            <th>体检</th>
            <th>压缩后</th>
            <th>省</th>
            <th class="col-state">状态</th>
            <th class="col-actions"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            :class="{ 'row-failed': item.stage === 'failed', 'row-skipped': item.stage === 'skipped' }"
          >
            <td class="col-name" :title="item.source.name">{{ item.source.name }}</td>
            <td class="num">{{ formatBytes(item.inputBytes) }}</td>
            <td class="num">{{ item.audit ? formatCount(item.audit.metrics.triangles) : '—' }}</td>
            <td class="num">{{ item.audit ? item.audit.metrics.materials : '—' }}</td>
            <td class="num">
              <template v-if="item.audit"
                >{{ item.audit.metrics.textures
                }}<span v-if="item.audit.metrics.maxTextureSize" class="muted">
                  · {{ item.audit.metrics.maxTextureSize }}px</span
                ></template
              >
              <template v-else>—</template>
            </td>
            <td>
              <span
                v-if="item.audit"
                class="grade"
                :class="`grade-${item.audit.grade.toLowerCase()}`"
                :title="item.audit.issues.map((issue) => issue.title).join('\n')"
              >
                {{ item.audit.grade }} · {{ item.audit.score }}
              </span>
              <span v-else class="num">—</span>
            </td>
            <td class="num">
              {{ item.outputBytes !== undefined ? formatBytes(item.outputBytes) : '—' }}
            </td>
            <td class="num saved">
              {{ item.savedRatio !== undefined ? `${(item.savedRatio * 100).toFixed(0)}%` : '—' }}
            </td>
            <td class="col-state" :title="item.note ?? ''">
              <span class="stage" :class="`stage-${item.stage}`">{{ STAGE_LABELS[item.stage] }}</span>
            </td>
            <td class="col-actions">
              <button
                v-if="item.output"
                class="mini-button"
                type="button"
                title="单独下载这个压缩产物"
                @click="downloadOne(item)"
              >
                ⬇
              </button>
              <button
                class="mini-button"
                type="button"
                title="从列表移除"
                :disabled="running"
                @click="removeItem(item.id)"
              >
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ————— 空状态 ————— -->
    <div v-else class="empty-state">
      <div class="empty-card">
        <h2>模型批量工作台</h2>
        <p>把多个 <strong>.glb</strong> 拖到页面任意位置,或点左上角「添加 .glb」</p>
        <ul class="empty-hints">
          <li>一次体检一整批 —— 体积 / 三角面 / 材质 / 贴图 / 健康度评分</li>
          <li>批量压缩后打包成一个 zip 下载</li>
          <li>
            只处理<strong>自包含</strong>的 .glb;带外部 .bin / 贴图的模型请到「GLB 模型查看」导入
          </li>
        </ul>
      </div>
    </div>

    <p v-if="errorText" class="error-bar" role="status">{{ errorText }}</p>

    <!-- 拖拽落点提示:拖到页面上任意位置都算 -->
    <div v-if="dragging" class="drop-hint" aria-hidden="true">
      <span>松手即加入列表 ·{{ ACCEPT }}</span>
    </div>

    <input
      ref="fileInputRef"
      class="file-input"
      type="file"
      :accept="ACCEPT"
      multiple
      @change="onFilesPicked"
    />
  </main>
</template>

<style scoped>
.workbench {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
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

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.file-input {
  display: none;
}

/* ————————————————————————— 工具条 ————————————————————————— */

.top-bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid rgb(121 230 202 / 18%);
}

.top-button {
  padding: 7px 14px;
  color: #06201d;
  background: #79e6ca;
  border: 1px solid #b4ffeb;
  border-radius: 16px;
  font: 600 11px/1.2 inherit;
  cursor: pointer;
  transition: 0.15s ease;
  white-space: nowrap;
}

.top-button:hover:not(:disabled) {
  filter: brightness(1.08);
}

.top-button:disabled {
  opacity: 0.34;
  cursor: not-allowed;
}

.top-button.primary {
  color: #041412;
  background: #a6ffe6;
  border-color: #d6fff5;
}

.top-button.danger {
  color: #3a0b0b;
  background: #ff9a8b;
  border-color: #ffd0c7;
}

.top-divider {
  width: 1px;
  height: 20px;
  background: rgb(121 230 202 / 22%);
}

.algo-group {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: rgb(255 255 255 / 5%);
  border: 1px solid rgb(121 230 202 / 20%);
  border-radius: 16px;
}

.algo-button {
  padding: 5px 12px;
  color: #9fd8cb;
  background: transparent;
  border: none;
  border-radius: 13px;
  font: 500 11px/1.2 inherit;
  cursor: pointer;
}

.algo-button.active {
  color: #04201c;
  background: #79e6ca;
}

/* ————————————————————————— 汇总条 ————————————————————————— */

.summary {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  padding: 9px 16px;
  background: rgb(255 255 255 / 3%);
  border-bottom: 1px solid rgb(121 230 202 / 12%);
  font-size: 12px;
  color: #9fd8cb;
}

.summary-item b {
  color: #ecfaf6;
  font-weight: 600;
}

.summary-item.saved b {
  color: #7cf0bb;
}

.summary-item.failed {
  color: #ff9a8b;
}

.muted {
  color: #6f9c93;
}

.progress {
  flex: 1;
  min-width: 120px;
  height: 5px;
  overflow: hidden;
  background: rgb(255 255 255 / 8%);
  border-radius: 3px;
}

.progress-fill {
  height: 100%;
  background: #79e6ca;
  transition: width 0.2s ease;
}

.progress-text {
  font-variant-numeric: tabular-nums;
}

/* ————————————————————————— 明细表 ————————————————————————— */

.table-wrap {
  flex: 1;
  min-height: 0;
  padding: 0 16px 16px;
  overflow: auto;
}

.batch-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.batch-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 10px;
  color: #7faea4;
  background: #071116;
  border-bottom: 1px solid rgb(121 230 202 / 22%);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}

.batch-table td {
  padding: 8px 10px;
  border-bottom: 1px solid rgb(255 255 255 / 6%);
  vertical-align: middle;
}

.batch-table tbody tr:hover {
  background: rgb(121 230 202 / 6%);
}

.row-failed td {
  background: rgb(255 122 94 / 7%);
}

.row-skipped td {
  opacity: 0.62;
}

.col-name {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

td.saved {
  color: #7cf0bb;
}

.col-state,
.col-actions {
  width: 1%;
  white-space: nowrap;
}

/* 体检等级配色:与 /glb 的 audit-grade 保持一致 */
.grade {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.grade-a {
  color: #04241a;
  background: #7cf0bb;
}

.grade-b {
  color: #052018;
  background: #8fd9c4;
}

.grade-c {
  color: #2b1c02;
  background: #f0c46a;
}

.grade-d {
  color: #2f0909;
  background: #ff9a8b;
}

.stage {
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 11px;
  background: rgb(255 255 255 / 7%);
  color: #9fd8cb;
}

.stage-optimized {
  color: #04241a;
  background: #7cf0bb;
}

.stage-audited {
  color: #052018;
  background: #8fd9c4;
}

.stage-failed {
  color: #2f0909;
  background: #ff9a8b;
}

.stage-skipped {
  color: #d9e6e2;
  background: rgb(255 255 255 / 12%);
}

.mini-button {
  padding: 3px 8px;
  color: #9fd8cb;
  background: rgb(255 255 255 / 6%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 8px;
  font-size: 11px;
  cursor: pointer;
}

.mini-button:hover:not(:disabled) {
  color: #041412;
  background: #79e6ca;
}

.mini-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* ————————————————————————— 空状态 / 提示 ————————————————————————— */

.empty-state {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 24px;
}

.empty-card {
  max-width: 520px;
  padding: 28px 32px;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 30%);
  border-radius: 12px;
  box-shadow: 0 18px 44px rgb(0 0 0 / 32%);
  text-align: center;
}

.empty-card h2 {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}

.empty-card p {
  margin: 0 0 16px;
  color: #9fd8cb;
  font-size: 13px;
}

.empty-card strong {
  color: #79e6ca;
}

.empty-hints {
  margin: 0;
  padding: 0;
  list-style: none;
  color: #7faea4;
  font-size: 12px;
  line-height: 2;
  text-align: left;
}

.empty-hints li::before {
  margin-right: 6px;
  color: #79e6ca;
  content: '·';
}

.error-bar {
  position: absolute;
  bottom: 14px;
  left: 50%;
  z-index: 8;
  margin: 0;
  padding: 8px 16px;
  color: #2f0909;
  background: #ffb3a6;
  border-radius: 20px;
  font-size: 12px;
  transform: translateX(-50%);
}

.drop-hint {
  position: absolute;
  inset: 10px;
  z-index: 9;
  display: grid;
  place-items: center;
  color: #04201c;
  background: rgb(121 230 202 / 22%);
  border: 2px dashed #79e6ca;
  border-radius: 14px;
  font-size: 15px;
  font-weight: 600;
  pointer-events: none;
}
</style>
