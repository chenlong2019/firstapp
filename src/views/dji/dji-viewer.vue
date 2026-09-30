<template>
  <main class="sandbox" data-testid="sandbox-root">
    <div ref="viewportRef" class="viewport" aria-label="DJI 飞行沙盒三维视口"></div>
    <div class="vignette"></div>
    <!-- 拍照快门闪光:盖住取景切换的那一帧 -->
    <div v-if="shutterFlash" class="shutter-flash" data-testid="shutter-flash" aria-hidden="true"></div>

    <!-- ═══════════════════════ 左侧:分页面板 ═══════════════════════ -->
    <aside class="panel panel-left">
      <div class="panel-head">
        <span>DJI MINI 4 PRO</span>
        <small>飞行测试沙盒</small>
      </div>
      <nav class="tabs">
        <button
          v-for="item in TABS"
          :key="item.key"
          type="button"
          :data-testid="`tab-${item.key}`"
          :class="{ active: tab === item.key }"
          @click="tab = item.key"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="panel-body">
        <!-- ─────────── 飞行 ─────────── -->
        <template v-if="tab === 'flight'">
          <section class="card">
            <div class="card-title">
              <span>当前阶段</span>
              <em class="badge" :class="phaseTone">{{ snap.phaseLabel }}</em>
            </div>
            <p class="next-step" :class="nextStep.tone">{{ nextStep.text }}</p>
            <div class="flow">
              <span
                v-for="(step, index) in PHASE_FLOW"
                :key="step.phase"
                class="flow-step"
                :class="{ done: index < flowIndex, active: index === flowIndex }"
              >
                {{ step.label }}
              </span>
              <span v-if="phaseTail" class="flow-step active tail">{{ phaseTail }}</span>
            </div>
          </section>

          <section class="card">
            <div class="card-title"><span>主控</span><em>FLIGHT CONTROL</em></div>
            <div class="btn-grid">
              <button
                type="button"
                data-testid="btn-power"
                :disabled="!canPowerToggle"
                @click="togglePower"
              >
                {{ snap.phase === 'powerOff' ? '电源开机' : '关机' }}
              </button>
              <button
                type="button"
                data-testid="btn-arm"
                :class="{ warn: snap.armFold > 0.5 }"
                @click="toggleArms"
              >
                {{ snap.armFold > 0.5 ? '展开机臂' : '收纳机臂' }}
              </button>
              <button
                type="button"
                data-testid="btn-motors"
                :disabled="snap.phase === 'motorsOn' ? false : !canStartMotors"
                @click="snap.phase === 'motorsOn' ? doStopMotors() : doStartMotors()"
              >
                {{ snap.phase === 'motorsOn' ? '停止电机' : '启动电机' }}
              </button>
              <button
                type="button"
                data-testid="btn-takeoff"
                class="primary"
                :disabled="!canTakeOff"
                :title="takeoffBlockReason"
                @click="doTakeOff"
              >
                一键起飞
              </button>
              <button type="button" data-testid="btn-land" :disabled="!canLand" @click="doLand">
                自动降落
              </button>
              <button type="button" data-testid="btn-rth" :disabled="!canRth" @click="doRth">
                智能返航
              </button>
              <button
                type="button"
                data-testid="btn-cancel-rth"
                :disabled="!canCancelRth"
                @click="doCancelRth"
              >
                中止返航
              </button>
              <button
                type="button"
                data-testid="btn-emergency"
                class="danger"
                :disabled="!canEmergency"
                :title="emergencyHint"
                @click="doEmergency"
              >
                {{ snap.airborne ? '停桨(需先落地)' : '紧急停桨' }}
              </button>
              <button type="button" data-testid="btn-reset" class="wide" @click="doReset">
                重置沙盒(回到出厂状态)
              </button>
            </div>
            <p v-if="blockingItems.length" class="block-hint">
              起飞被阻止:{{ blockingItems.map((item) => item.label).join('、') }}
            </p>
          </section>

          <section class="card">
            <div class="card-title">
              <span>起飞前检查</span>
              <em>{{ okCount }}/{{ snap.checklist.length }}</em>
            </div>
            <ul class="checklist" data-testid="checklist">
              <li v-for="item in snap.checklist" :key="item.id" :class="{ bad: !item.ok, blocking: item.blocking && !item.ok }">
                <i class="dot"></i>
                <div>
                  <strong>{{ item.label }}</strong>
                  <span>{{ item.detail }}</span>
                </div>
                <em v-if="item.blocking && !item.ok" class="tag">阻止起飞</em>
              </li>
            </ul>
          </section>

          <section class="card">
            <div class="card-title"><span>飞行警告</span><em>{{ snap.warnings.length }}</em></div>
            <div v-if="snap.warnings.length" class="warn-list">
              <span v-for="text in snap.warnings" :key="text">{{ text }}</span>
            </div>
            <p v-else class="muted">无警告,系统正常</p>
            <div class="minimap-row">
              <label class="switch">
                <input v-model="showObstacles" type="checkbox" @change="applyWorldVisibility" />
                <span>显示障碍物</span>
              </label>
              <label class="switch">
                <input
                  v-model="showMissionWaypoints"
                  data-testid="toggle-mission-waypoints"
                  type="checkbox"
                  @change="applyWorldVisibility"
                />
                <span>显示航点</span>
              </label>
              <label class="switch">
                <input
                  v-model="showMissionPath"
                  data-testid="toggle-mission-path"
                  type="checkbox"
                  @change="applyWorldVisibility"
                />
                <span>显示航线</span>
              </label>
              <label class="switch">
                <input v-model="showRadarBeams" type="checkbox" @change="applyWorldVisibility" />
                <span>雷达射线</span>
              </label>
              <label class="switch">
                <input v-model="showAuxBeam" type="checkbox" @change="applyWorldVisibility" />
                <span>照明光束</span>
              </label>
              <label class="switch">
                <input v-model="showAxes" type="checkbox" @change="applyWorldVisibility" />
                <span>显示坐标轴</span>
              </label>
              <button type="button" class="mini" @click="clearTrail">清除航迹</button>
            </div>
          </section>
        </template>

        <!-- ─────────── 航线 ─────────── -->
        <template v-else-if="tab === 'mission'">
          <section class="card">
            <div class="card-title">
              <span>航线任务</span>
              <em class="badge" :class="missionTone">{{ snap.mission.statusLabel }}</em>
            </div>
            <div class="btn-grid">
              <button
                type="button"
                data-testid="mission-start"
                class="primary"
                :disabled="!canStartMission"
                @click="doStartMission"
              >
                执行航线
              </button>
              <button type="button" data-testid="mission-pause" :disabled="!canPauseMission" @click="doPauseMission">
                暂停
              </button>
              <button
                type="button"
                data-testid="mission-resume"
                :disabled="!canResumeMission"
                @click="doResumeMission"
              >
                继续
              </button>
              <button type="button" data-testid="mission-stop" class="wide" :disabled="!canStopMission" @click="doStopMission">
                停止任务(原地悬停)
              </button>
            </div>
            <p v-if="missionBlockReason" class="block-hint" data-testid="mission-block">{{ missionBlockReason }}</p>
            <p class="fine-print">
              地面直接点「执行航线」会先自动起飞,到 1.2 米后自动接上航线;空中启动同样从首个航点走起。
              飞向首个航点与返航同款分段:先垂直调整到航点高度 → 水平飞过去 → 收到航点高度 →
              机头对准航线方向,之后才开始执行航线。执行中拨动摇杆会暂停任务并交回手动控制。
            </p>
          </section>

          <section class="card">
            <div class="card-title">
              <span>任务参数</span>
              <em>{{ snap.mission.total }} 个航点</em>
            </div>
            <label class="slider-row">
              <span class="slider-label">巡航速度</span>
              <input
                type="range"
                data-testid="mission-speed"
                min="1"
                max="16"
                step="0.5"
                :value="snap.mission.config.autoSpeed"
                @input="onMissionSpeedInput"
              />
              <strong>{{ snap.mission.config.autoSpeed.toFixed(1) }} m/s</strong>
            </label>
            <p class="row-label">机头朝向</p>
            <div class="segmented two">
              <button
                type="button"
                data-testid="mission-heading-auto"
                :class="{ active: snap.mission.config.headingMode === 'auto' }"
                @click="applyMissionConfig({ headingMode: 'auto' })"
              >
                指向下一航点
              </button>
              <button
                type="button"
                data-testid="mission-heading-fixed"
                :class="{ active: snap.mission.config.headingMode === 'fixed' }"
                @click="applyMissionConfig({ headingMode: 'fixed' })"
              >
                锁定起始航向
              </button>
            </div>
            <p class="row-label">过点方式</p>
            <div class="segmented two">
              <button
                type="button"
                data-testid="mission-path-straight"
                :class="{ active: snap.mission.config.pathMode === 'straight' }"
                @click="applyMissionConfig({ pathMode: 'straight' })"
              >
                到点减速
              </button>
              <button
                type="button"
                data-testid="mission-path-curved"
                :class="{ active: snap.mission.config.pathMode === 'curved' }"
                @click="applyMissionConfig({ pathMode: 'curved' })"
              >
                曲线过点
              </button>
            </div>
            <p class="row-label">全部完成后</p>
            <div class="segmented three">
              <button
                v-for="action in MISSION_FINISH_ACTIONS"
                :key="action.key"
                type="button"
                :data-testid="`mission-finish-${action.key}`"
                :class="{ active: snap.mission.config.finishAction === action.key }"
                @click="applyMissionConfig({ finishAction: action.key })"
              >
                {{ action.label }}
              </button>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                data-testid="mission-loop"
                :checked="snap.mission.config.loop"
                @change="onMissionLoopToggle"
              />
              <span>循环执行(完成后回到第 1 个航点)</span>
            </label>
            <p class="fine-print">
              曲线过点保持巡航速度、距航点 3 米就切向下一点,所以会忽略航点悬停;直线模式按刹车距离提前收油,过点更稳。
            </p>
          </section>

          <section class="card">
            <div class="card-title">
              <span>航点列表</span>
              <em>{{ snap.mission.waypoints.length }} 个</em>
            </div>
            <fieldset class="waypoint-fieldset" :disabled="!missionEditable">
              <ul class="waypoint-list" data-testid="waypoint-list">
                <li
                  v-for="(row, index) in waypointDraft"
                  :key="index"
                  :class="{ active: isActiveWaypoint(index), selected: sceneEdit.selectedIndex === index }"
                  :data-testid="`waypoint-${index}`"
                  @click="selectWaypoint(index)"
                >
                  <div class="wp-head">
                    <span class="wp-index">{{ index + 1 }}</span>
                    <span class="wp-coord">E {{ row.x }} / S {{ row.z }}</span>
                    <button
                      type="button"
                      class="mini"
                      :data-testid="`waypoint-remove-${index}`"
                      @click.stop="removeWaypoint(index)"
                    >
                      删除
                    </button>
                  </div>
                  <div class="wp-row">
                    <label class="wp-field">
                      <span>X</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="2"
                        :value="row.x"
                        @input="onWaypointTextInput(index, 'x', $event)"
                      />
                    </label>
                    <label class="wp-field">
                      <span>Z</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="2"
                        :value="row.z"
                        @input="onWaypointTextInput(index, 'z', $event)"
                      />
                    </label>
                    <label class="wp-field">
                      <span>高度</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="1"
                        min="1"
                        :value="row.altitude"
                        @input="onWaypointTextInput(index, 'altitude', $event)"
                      />
                    </label>
                  </div>
                  <div class="wp-row">
                    <label class="wp-field">
                      <span>速度</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="1"
                        min="0"
                        max="16"
                        :value="row.speed"
                        @input="onWaypointTextInput(index, 'speed', $event)"
                      />
                    </label>
                    <label class="wp-field">
                      <span>悬停</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="1"
                        min="0"
                        max="60"
                        :value="row.hoverSeconds"
                        @input="onWaypointTextInput(index, 'hoverSeconds', $event)"
                      />
                    </label>
                    <label class="wp-field">
                      <input type="checkbox" :checked="row.gimbalOn" @change="onWaypointGimbalToggle(index, $event)" />
                      <span>云台</span>
                      <input
                        class="wp-input"
                        type="number"
                        step="5"
                        min="-90"
                        max="60"
                        :value="row.gimbalPitch"
                        :disabled="!row.gimbalOn"
                        @input="onWaypointTextInput(index, 'gimbalPitch', $event)"
                      />
                    </label>
                    <label class="wp-field">
                      <span>动作</span>
                      <select class="wp-select" :value="row.action" @change="onWaypointActionChange(index, $event)">
                        <option v-for="action in MISSION_ACTIONS" :key="action.key" :value="action.key">
                          {{ action.label }}
                        </option>
                      </select>
                    </label>
                  </div>
                  <em v-if="isActiveWaypoint(index)" class="wp-flag">当前目标</em>
                </li>
                <li v-if="!waypointDraft.length" class="muted">暂无航点</li>
              </ul>
            </fieldset>
            <div class="segmented three">
              <button type="button" data-testid="mission-add" :disabled="!missionEditable" @click="addWaypoint">
                添加航点
              </button>
              <button type="button" data-testid="mission-preset" :disabled="!missionEditable" @click="useDefaultMission">
                示例航线
              </button>
              <button type="button" data-testid="mission-clear" :disabled="!missionEditable" @click="clearWaypoints">
                清空
              </button>
            </div>
            <p v-if="!missionEditable" class="fine-print">
              任务执行中:停止任务之后才能修改航点(与真机"航线上传后不可改"一致)。
            </p>
          </section>

          <section class="card">
            <div class="card-title">
              <span>场景内编辑</span>
              <em class="badge" :class="sceneEditBadge.tone">{{ sceneEditBadge.label }}</em>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                data-testid="scene-edit-toggle"
                :checked="sceneEdit.enabled"
                @change="onSceneEditToggle"
              />
              <span>在三维场景里直接编辑航点</span>
            </label>
            <ul class="gesture-list" data-testid="scene-edit-help">
              <li><b>拖拽航点</b><span>在它当前高度的水平面内移动</span></li>
              <li><b>Shift + 拖拽</b><span>改高度(按住 Alt 可关掉 1 米吸附)</span></li>
              <li><b>双击地面</b><span>在该处插入一个航点</span></li>
              <li><b>Delete</b><span>删除当前选中的航点,Esc 取消选中</span></li>
            </ul>
            <div class="scene-edit-status" data-testid="scene-edit-status">
              <span v-if="sceneEdit.selectedIndex >= 0">
                已选中 <b>航点 {{ sceneEdit.selectedIndex + 1 }}</b>
                <template v-if="selectedWaypoint">
                  · E {{ signed(selectedWaypoint.x, 0) }} / S {{ signed(selectedWaypoint.z, 0) }} /
                  {{ selectedWaypoint.altitude.toFixed(0) }} m
                </template>
              </span>
              <span v-else>未选中航点(在场景里点一下航点光柱)</span>
              <em v-if="sceneEdit.dragging">{{ sceneEdit.mode === 'altitude' ? '调整高度中' : '移动中' }}</em>
              <em v-else-if="sceneEdit.enabled && !sceneEdit.active">{{ sceneEditBlockReason }}</em>
            </div>
            <div class="segmented three">
              <button
                type="button"
                data-testid="scene-edit-delete"
                :disabled="sceneEdit.selectedIndex < 0 || !missionEditable"
                @click="deleteSelectedWaypoint"
              >
                删除选中
              </button>
              <button
                type="button"
                data-testid="scene-edit-add"
                :disabled="!missionEditable"
                @click="addWaypointAtDrone"
              >
                飞机位置新增
              </button>
              <button type="button" data-testid="scene-edit-frame" @click="frameMission">框住航线</button>
            </div>
            <div class="segmented two">
              <button
                type="button"
                data-testid="scene-edit-select-first"
                :disabled="!snap.mission.total"
                @click="selectWaypoint(0)"
              >
                选中第 1 个航点
              </button>
              <button
                type="button"
                data-testid="scene-edit-deselect"
                :disabled="sceneEdit.selectedIndex < 0"
                @click="selectWaypoint(-1)"
              >
                取消选中
              </button>
            </div>
            <div class="minimap-row">
              <label class="switch">
                <input
                  v-model="showMissionWaypoints"
                  data-testid="toggle-mission-waypoints"
                  type="checkbox"
                  @change="applyWorldVisibility"
                />
                <span>显示航点</span>
              </label>
              <label class="switch">
                <input
                  v-model="showMissionPath"
                  data-testid="toggle-mission-path"
                  type="checkbox"
                  @change="applyWorldVisibility"
                />
                <span>显示航线</span>
              </label>
            </div>
            <p class="fine-print">
              隐藏只是不画,不影响任务执行;编辑航点则要求航线未在执行,且处于观察者视角(机载视角下屏幕里没有可点的目标)。
            </p>
          </section>
        </template>

        <!-- ─────────── 灯光 ─────────── -->
        <template v-else-if="tab === 'lights'">
          <section class="card">
            <div class="card-title">
              <span>灯光控制</span>
              <em class="badge" :class="{ on: lightAuto }">{{ lightAuto ? '自动跟随飞行状态' : '手动覆盖' }}</em>
            </div>
            <button
              type="button"
              class="wide"
              :class="{ primary: !lightAuto }"
              @click="enableAutoLights"
            >
              恢复自动跟随
            </button>
          </section>

          <section class="card">
            <div class="card-title"><span>尾部状态指示灯</span><em>{{ lights.statusKey }}</em></div>
            <div class="status-grid">
              <button
                v-for="p in statusPatterns"
                :key="p.key"
                type="button"
                class="status-button"
                :class="{ active: lights.statusKey === p.key }"
                @click="selectStatusPattern(p.key)"
              >
                <i class="led-dot" :style="{ background: p.uiColor }"></i>{{ p.label }}
              </button>
            </div>
            <p class="pattern-meaning">{{ lights.statusMeaning }}</p>
          </section>

          <section class="card">
            <div class="card-title"><span>智能电池电量灯</span><em>{{ lights.batteryMode }}</em></div>
            <div class="battery-row">
              <span
                v-for="(led, index) in lights.batteryLeds"
                :key="index"
                class="battery-dot"
                :class="{ on: led.on && !led.blinking, blink: led.blinking }"
              ></span>
              <em class="battery-text">{{ batteryText }}</em>
            </div>
            <div class="segmented five">
              <button
                v-for="m in BATTERY_MODES"
                :key="m.key"
                type="button"
                :class="{ active: lights.batteryMode === m.key }"
                @click="selectBatteryMode(m.key)"
              >
                {{ m.label }}
              </button>
            </div>
            <label class="slider-row">
              <input
                type="range"
                data-testid="battery-level"
                min="0"
                max="100"
                :value="lights.batteryLevel"
                :disabled="lights.batteryMode !== 'level'"
                @input="onBatteryLevelInput"
              />
              <strong>{{ lights.batteryLevel }}%</strong>
            </label>
            <p class="fine-print">拖动滑块会直接改变仿真电量 —— 可用来测试低电量返航</p>
          </section>

          <section class="card">
            <div class="card-title"><span>底部辅助照明灯</span><em>{{ lights.auxMode }}</em></div>
            <div class="segmented three">
              <button
                v-for="m in AUX_MODES"
                :key="m.key"
                type="button"
                :class="{ active: lights.auxMode === m.key }"
                @click="selectAuxMode(m.key)"
              >
                {{ m.label }}
              </button>
            </div>
            <p class="aux-status" :class="{ lit: lights.auxOn }">{{ auxStatusText }}</p>
            <p v-if="lights.auxLocked && lights.auxMode !== 'off'" class="aux-hint">
              Mini 4 Pro 独有 · 地面上电无法点亮,起飞后生效
            </p>
          </section>
        </template>

        <!-- ─────────── 参数 ─────────── -->
        <template v-else-if="tab === 'config'">
          <section class="card">
            <div class="card-title"><span>飞行挡位</span><em>{{ snap.modeLabel }}</em></div>
            <div class="segmented three">
              <button
                v-for="m in FLIGHT_MODE_LIST"
                :key="m.key"
                type="button"
                :class="{ active: snap.mode === m.key }"
                @click="setMode(m.key)"
              >
                {{ m.label }}
              </button>
            </div>
            <p class="fine-print">
              水平 {{ currentModeSpec.horizontalSpeed }} m/s · 上升 {{ currentModeSpec.climbSpeed }} m/s · 下降
              {{ currentModeSpec.descendSpeed }} m/s · 最大倾角 {{ currentModeSpec.maxTiltDeg }}°
            </p>
          </section>

          <section class="card">
            <div class="card-title"><span>飞行限制</span><em>GEO / 限高限距</em></div>
            <label v-for="row in LIMIT_ROWS" :key="row.key" class="slider-row">
              <span class="slider-label">{{ row.label }}</span>
              <input
                type="range"
                :data-testid="`cfg-${row.key}`"
                :min="row.min"
                :max="row.max"
                :step="row.step"
                :value="config[row.key]"
                @input="onConfigInput(row.key, $event)"
              />
              <strong>{{ config[row.key] }}{{ row.unit }}</strong>
            </label>
          </section>

          <section class="card">
            <div class="card-title"><span>风场</span><em>{{ snap.windRelative }}</em></div>
            <label class="slider-row">
              <span class="slider-label">风速</span>
              <input
                type="range"
                data-testid="cfg-windSpeed"
                min="0"
                max="15"
                step="0.5"
                :value="config.windSpeed"
                @input="onConfigInput('windSpeed', $event)"
              />
              <strong>{{ config.windSpeed.toFixed(1) }} m/s</strong>
            </label>
            <label class="slider-row">
              <span class="slider-label">风向</span>
              <input
                type="range"
                data-testid="cfg-windDirection"
                min="0"
                max="355"
                step="5"
                :value="config.windDirection"
                @input="onConfigInput('windDirection', $event)"
              />
              <strong>{{ config.windDirection }}°</strong>
            </label>
            <p class="fine-print">
              风吹向 {{ cardinal(config.windDirection) }} · 抗风上限 {{ DRONE_SPEC.maxWindResistance }} m/s · 超过上限会提示风险
            </p>
          </section>

          <section class="card">
            <div class="card-title"><span>返航与失效保护</span><em>FAILSAFE</em></div>
            <label class="slider-row">
              <span class="slider-label">返航高度</span>
              <input
                type="range"
                data-testid="cfg-rthAltitude"
                min="5"
                max="120"
                step="1"
                :value="config.rthAltitude"
                @input="onConfigInput('rthAltitude', $event)"
              />
              <strong>{{ config.rthAltitude }} m</strong>
            </label>
            <p class="row-label">遥控失联动作</p>
            <div class="segmented three">
              <button
                v-for="m in FAILSAFE_MODES"
                :key="m.key"
                type="button"
                :class="{ active: config.rcFailsafe === m.key }"
                @click="applyConfig({ rcFailsafe: m.key })"
              >
                {{ m.label }}
              </button>
            </div>
            <label class="slider-row">
              <span class="slider-label">低电返航</span>
              <input
                type="range"
                data-testid="cfg-lowBatteryPercent"
                min="10"
                max="40"
                step="1"
                :value="config.lowBatteryPercent"
                @input="onConfigInput('lowBatteryPercent', $event)"
              />
              <strong>{{ config.lowBatteryPercent }}%</strong>
            </label>
            <label class="slider-row">
              <span class="slider-label">强制降落</span>
              <input
                type="range"
                data-testid="cfg-criticalBatteryPercent"
                min="5"
                max="20"
                step="1"
                :value="config.criticalBatteryPercent"
                @input="onConfigInput('criticalBatteryPercent', $event)"
              />
              <strong>{{ config.criticalBatteryPercent }}%</strong>
            </label>
          </section>

          <section class="card">
            <div class="card-title"><span>时间倍速</span><em>{{ config.timeScale }}×</em></div>
            <div class="segmented four">
              <button
                v-for="scale in TIME_SCALES"
                :key="scale"
                type="button"
                :class="{ active: config.timeScale === scale }"
                @click="applyConfig({ timeScale: scale })"
              >
                {{ scale }}×
              </button>
            </div>
            <p class="fine-print">加速只影响仿真时间,桨叶转速仍按真实帧率显示</p>
          </section>

          <section class="card">
            <div class="card-title"><span>电池快捷设置</span><em>DEBUG</em></div>
            <div class="segmented four">
              <button v-for="level in BATTERY_PRESETS" :key="level" type="button" @click="setBattery(level)">
                {{ level }}%
              </button>
            </div>
          </section>
        </template>

        <!-- ─────────── 故障 ─────────── -->
        <template v-else-if="tab === 'faults'">
          <section class="card">
            <div class="card-title">
              <span>故障注入</span>
              <em>{{ activeFaultCount }} 项生效中</em>
            </div>
            <p class="fine-print">
              用于复现真机异常:注入后在飞行中观察灯语、遥测与自动保护动作的变化。
            </p>
            <ul class="fault-list">
              <li v-for="item in FAULT_LIST" :key="item.key">
                <button
                  type="button"
                  class="switch-row"
                  :class="{ on: faults[item.key], danger: faults[item.key] && item.severity === 'error' }"
                  :data-testid="`fault-${item.key}`"
                  @click="toggleFault(item.key)"
                >
                  <i class="knob"></i>
                  <div>
                    <strong>{{ item.label }}</strong>
                    <span>{{ item.hint }}</span>
                  </div>
                </button>
              </li>
            </ul>
          </section>

          <section class="card">
            <div class="card-title"><span>失效保护时序</span><em>AUTO</em></div>
            <ul class="timeline">
              <li :class="{ armed: faults.rcLost }">遥控失联 3 秒 → 按配置执行返航 / 悬停 / 降落</li>
              <li :class="{ armed: snap.lowBattery }">
                电量 {{ config.lowBatteryPercent }}% → 10 秒倒计时后自动返航{{
                  snap.lowBatteryCountdown > 0 ? `(剩 ${snap.lowBatteryCountdown.toFixed(0)} s)` : ''
                }}
              </li>
              <li :class="{ armed: snap.criticalBattery }">电量 {{ config.criticalBatteryPercent }}% → 强制原地降落</li>
              <li :class="{ armed: snap.batteryPercent <= 0 }">电量耗尽 → 动力失效坠机</li>
            </ul>
          </section>
        </template>

        <!-- ─────────── 模型 ─────────── -->
        <template v-else>
          <section class="card">
            <div class="card-title">
              <span>模型自检</span>
              <em>{{ foundCount }}/{{ rigReport.length }}</em>
            </div>
            <p class="fine-print">
              依据《DJI Mini 4 Pro 模型 ID 与名称对应表》逐项核对语义节点;可驱动机件会标出用途。
            </p>
            <div class="segmented three">
              <button type="button" :class="{ active: snap.armFold < 0.5 }" @click="setArmFold(0)">
                展开机臂
              </button>
              <button type="button" :class="{ active: snap.armFold > 0.5 }" @click="setArmFold(1)">
                收纳机臂
              </button>
              <button type="button" @click="clearTrail">清除航迹</button>
            </div>
          </section>
          <section class="card">
            <ul class="part-list">
              <li
                v-for="part in rigReport"
                :key="part.id"
                :class="{ missing: !part.found, drivable: part.drivable }"
              >
                <i class="dot"></i>
                <div>
                  <strong>{{ part.label }}</strong>
                  <span>{{ part.id }}</span>
                </div>
                <em v-if="part.drivable" class="tag ok">可驱动</em>
                <em v-else-if="!part.found" class="tag bad">缺失</em>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </aside>

    <!-- ═══════════════════════ 右侧:HUD ═══════════════════════ -->
    <aside class="panel panel-right">
      <div class="panel-head">
        <span>HUD</span>
        <small>{{ snap.positionSourceLabel }}</small>
      </div>
      <div class="panel-body">
        <section class="card status-card">
          <div class="status-line">
            <span class="phase" data-testid="snap-phase">{{ snap.phaseLabel }}</span>
            <span class="chips">
              <em class="badge" :class="{ on: snap.motorsOn }">电机</em>
              <em class="badge" :class="{ on: snap.airborne }">空中</em>
              <em v-if="snap.recording" class="badge rec">REC {{ formatClock(snap.recordSeconds) }}</em>
            </span>
          </div>
          <div class="status-sub">
            <span>{{ snap.modeLabel }}</span>
            <span>{{ snap.positionSourceLabel }}</span>
            <span>{{ snap.windRelative }} {{ snap.windSpeed.toFixed(1) }} m/s</span>
          </div>
          <div v-if="snap.rthReason" class="status-sub alt">返航原因:{{ snap.rthReason }} · {{ rthStageLabel }}</div>
        </section>

        <section class="card">
          <div class="card-title"><span>遥测</span><em>TELEMETRY</em></div>
          <div class="telemetry">
            <div class="cell">
              <span>高度 AGL</span>
              <strong data-testid="snap-altitude">{{ snap.altitude.toFixed(2) }}<small>m</small></strong>
            </div>
            <div class="cell">
              <span>水平速度</span>
              <strong>{{ snap.horizontalSpeed.toFixed(2) }}<small>m/s</small></strong>
            </div>
            <div class="cell">
              <span>垂直速度</span>
              <strong :class="vSpeedClass">{{ signed(snap.verticalSpeed, 2) }}<small>m/s</small></strong>
            </div>
            <div class="cell">
              <span>距返航点</span>
              <strong>{{ snap.distanceToHome.toFixed(1) }}<small>m</small></strong>
            </div>
            <div class="cell">
              <span>航向</span>
              <strong>{{ snap.heading.toFixed(0) }}°<small>{{ cardinal(snap.heading) }}</small></strong>
            </div>
            <div class="cell">
              <span>最高高度</span>
              <strong>{{ snap.altitudeMax.toFixed(1) }}<small>m</small></strong>
            </div>
          </div>
          <div class="coord-row">
            <span>坐标 E {{ signed(snap.positionX, 1) }} / S {{ signed(snap.positionZ, 1) }}</span>
            <span>飞行 {{ formatClock(snap.flightTime) }}</span>
          </div>
        </section>

        <section v-if="snap.mission.status !== 'idle' || snap.mission.total" class="card" data-testid="hud-mission">
          <div class="card-title">
            <span>航线任务</span>
            <em :class="missionTone">{{ snap.mission.statusLabel }}</em>
          </div>
          <div class="progress-head">
            <span>{{ missionProgressText }}</span>
            <em>{{ missionPercent }}%</em>
          </div>
          <div class="progress-bar">
            <span :style="{ width: `${missionPercent}%` }"></span>
          </div>
          <div class="mission-meta">
            <div><span>剩余航程</span><strong>{{ snap.mission.distanceLeft.toFixed(0) }} m</strong></div>
            <div><span>预计剩余</span><strong>{{ missionEtaText }}</strong></div>
            <div><span>已执行</span><strong>{{ formatClock(snap.mission.elapsed) }}</strong></div>
            <div>
              <span>目标高度</span>
              <strong>{{ snap.mission.active ? `${snap.mission.active.altitude.toFixed(0)} m` : '—' }}</strong>
            </div>
          </div>
          <p v-if="snap.mission.pauseReason" class="brake-flag" data-testid="mission-pause-reason">
            已暂停 · {{ snap.mission.pauseReason }}
          </p>
        </section>

        <section class="card">
          <div class="instruments">
            <div class="instrument">
              <div class="card-title"><span>姿态</span><em>{{ snap.tiltPitch.toFixed(1) }}° / {{ snap.tiltRoll.toFixed(1) }}°</em></div>
              <svg class="attitude" viewBox="0 0 200 200" role="img" aria-label="姿态仪">
                <defs>
                  <clipPath id="att-clip">
                    <circle cx="100" cy="100" r="80" />
                  </clipPath>
                  <linearGradient id="att-sky" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#1d5b86" />
                    <stop offset="100%" stop-color="#0f2f48" />
                  </linearGradient>
                  <linearGradient id="att-ground" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#4a3418" />
                    <stop offset="100%" stop-color="#1e150c" />
                  </linearGradient>
                </defs>
                <circle cx="100" cy="100" r="80" fill="#0a141b" stroke="rgba(121,230,202,.22)" />
                <g clip-path="url(#att-clip)">
                  <g :transform="`rotate(${-snap.tiltRoll} 100 100) translate(0 ${snap.tiltPitch * PITCH_PX})`">
                    <rect x="-80" y="-320" width="360" height="420" fill="url(#att-sky)" />
                    <rect x="-80" y="100" width="360" height="420" fill="url(#att-ground)" />
                    <line x1="-80" y1="100" x2="280" y2="100" stroke="#d9fff4" stroke-width="1.6" />
                    <g
                      v-for="mark in PITCH_MARKS"
                      :key="mark"
                      :transform="`translate(0 ${mark * PITCH_PX})`"
                      stroke="rgba(226,255,247,.55)"
                      stroke-width="1.1"
                    >
                      <line x1="70" y1="100" x2="130" y2="100" />
                      <text x="136" y="103.5" fill="rgba(226,255,247,.6)" stroke="none" font-size="10">{{ Math.abs(mark) }}</text>
                    </g>
                  </g>
                </g>
                <path
                  d="M 56 100 H 84 L 92 109 L 108 109 L 116 100 H 144"
                  fill="none"
                  stroke="#ffe08a"
                  stroke-width="2.6"
                  stroke-linejoin="round"
                />
                <circle cx="100" cy="100" r="2.6" fill="#ffe08a" />
                <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(121,230,202,.3)" />
              </svg>
            </div>
            <div class="instrument">
              <div class="card-title"><span>罗盘</span><em>{{ homeBearing === null ? '无返航点' : `H ${homeBearing.toFixed(0)}°` }}</em></div>
              <svg class="attitude" viewBox="0 0 200 200" role="img" aria-label="罗盘">
                <circle cx="100" cy="100" r="80" fill="#0a141b" stroke="rgba(121,230,202,.22)" />
                <g :transform="`rotate(${-snap.heading} 100 100)`">
                  <line
                    v-for="tick in COMPASS_TICKS"
                    :key="tick.angle"
                    :x1="100"
                    :y1="28"
                    :x2="100"
                    :y2="tick.major ? 42 : 35"
                    :stroke="tick.major ? 'rgba(159,241,220,.75)' : 'rgba(121,230,202,.3)'"
                    :stroke-width="tick.major ? 1.8 : 1"
                    :transform="`rotate(${tick.angle} 100 100)`"
                  />
                  <text
                    v-for="point in CARDINALS"
                    :key="point.label"
                    :x="100"
                    :y="62"
                    :transform="`rotate(${point.angle} 100 100)`"
                    :fill="point.label === 'N' ? '#ff7a6a' : 'rgba(216,255,245,.8)'"
                    font-size="15"
                    font-weight="700"
                    text-anchor="middle"
                  >
                    {{ point.label }}
                  </text>
                  <g v-if="homeBearing !== null" :transform="`rotate(${homeBearing} 100 100)`">
                    <path d="M100 44 L92 58 L108 58 Z" fill="#6ff0d0" />
                  </g>
                </g>
                <path d="M100 10 L91 26 L109 26 Z" fill="#ff5b4a" />
                <circle cx="100" cy="100" r="34" fill="none" stroke="rgba(121,230,202,.16)" />
                <circle cx="100" cy="100" r="3" fill="rgba(159,241,220,.8)" />
              </svg>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-title">
            <span>智能电池</span>
            <em :class="batteryTone">{{ snap.batteryModeText }}</em>
          </div>
          <div class="battery-bar">
            <span :style="{ width: `${snap.batteryPercent}%`, background: batteryColor }" data-testid="snap-battery"></span>
          </div>
          <div class="battery-meta">
            <div><span>电量</span><strong>{{ snap.batteryPercent.toFixed(1) }}%</strong></div>
            <div><span>电压</span><strong>{{ snap.batteryVoltage.toFixed(2) }} V</strong></div>
            <div><span>电流</span><strong>{{ snap.batteryCurrent.toFixed(2) }} A</strong></div>
            <div><span>温度</span><strong>{{ snap.batteryTemp.toFixed(0) }} ℃</strong></div>
            <div><span>剩余能量</span><strong>{{ snap.batteryWhLeft.toFixed(2) }} Wh</strong></div>
            <div><span>可飞时间</span><strong>{{ snap.remainingMinutes.toFixed(1) }} min</strong></div>
          </div>
        </section>

        <section class="card">
          <div class="card-title"><span>信号与避障</span><em>{{ snap.satellites.toFixed(0) }} 星 · HDOP {{ snap.hdop.toFixed(1) }}</em></div>
          <div class="signal-row">
            <span class="signal-label">GNSS</span>
            <i v-for="n in 5" :key="`g${n}`" class="bar" :class="{ on: n <= snap.gpsBars }"></i>
          </div>
          <div class="signal-row">
            <span class="signal-label">遥控</span>
            <i v-for="n in 5" :key="`r${n}`" class="bar" :class="{ on: n <= snap.rcBars }"></i>
          </div>
          <div class="signal-row">
            <span class="signal-label">下视视觉</span>
            <em class="badge" :class="{ on: snap.visionAvailable }">{{ snap.visionAvailable ? '可用' : '不可用' }}</em>
          </div>
          <div class="obstacle-grid">
            <div v-for="item in obstacleCells" :key="item.label" class="obs-cell" :class="{ near: item.near }">
              <span>{{ item.label }}</span>
              <strong>{{ item.text }}</strong>
            </div>
          </div>
          <p v-if="snap.obstacle.braking" class="brake-flag">避障刹停中 · {{ snap.obstacle.brakingDirection }}</p>
          <div class="radar-block">
            <div class="radar-head">
              <span>测距雷达</span>
              <em class="badge" :class="{ on: radar.detecting }">{{ radar.detecting ? '工作中' : '未上电' }}</em>
            </div>
            <div class="radar-aim">
              <span class="radar-aim-label">镜头瞄准</span>
              <button type="button" :class="{ on: radar.aim === 'forward' }" @click="setRadarAim('forward')">
                正前方 / 正上方
              </button>
              <button type="button" :class="{ on: radar.aim === 'sensor' }" @click="setRadarAim('sensor')">镜头面朝向</button>
            </div>
            <div class="radar-group">
              <span class="radar-group-label">前视 · {{ radar.range.toFixed(0) }} m</span>
              <div class="radar-rays">
                <div v-for="ray in radarRays" :key="ray.label" class="radar-ray" :class="radarLevel(ray.hit)">
                  <span>{{ ray.label }}</span>
                  <strong>{{ radarText(ray.hit) }}</strong>
                  <em>{{ radarLabel(ray.hit) }}</em>
                </div>
              </div>
            </div>
            <div class="radar-group up">
              <span class="radar-group-label">上视 · {{ radar.upRange.toFixed(0) }} m</span>
              <div class="radar-rays">
                <div v-for="ray in radarUpRays" :key="ray.label" class="radar-ray" :class="radarLevel(ray.hit)">
                  <span>{{ ray.label }}</span>
                  <strong>{{ radarText(ray.hit) }}</strong>
                  <em>{{ radarLabel(ray.hit) }}</em>
                </div>
              </div>
            </div>
            <p class="fine-print">
              镜头可转向:默认转去看正前方/正上方(切换按钮即时生效,转动带过渡)。检测用官方视场锥(前视 90°×72°、上视左右 90°×前后 72°),同侧两镜头视场在中线重叠 → 正前方/正上方的细杆也不会从缝里漏掉。起点取模型镜头/孔位;仅供测距显示,刹停保护由飞控避障负责。
            </p>
          </div>
        </section>

        <section class="card">
          <div class="card-title"><span>云台与相机</span><em>{{ snap.cameraZoom.toFixed(1) }}×</em></div>
          <label class="slider-row">
            <span class="slider-label">云台</span>
            <input
              type="range"
              data-testid="gimbal-pitch"
              min="-90"
              max="60"
              step="1"
              :value="snap.gimbalPitch"
              @input="onGimbalInput"
            />
            <strong>{{ snap.gimbalPitch.toFixed(0) }}°</strong>
          </label>
          <label class="slider-row">
            <span class="slider-label">变焦</span>
            <input
              type="range"
              data-testid="camera-zoom"
              min="1"
              max="4"
              step="0.1"
              :value="snap.cameraZoom"
              @input="onZoomInput"
            />
            <strong>{{ snap.cameraZoom.toFixed(1) }}×</strong>
          </label>
          <div class="segmented four">
            <button type="button" @click="centerGimbal">云台回中</button>
            <button type="button" @click="lookDown">垂直向下</button>
            <button type="button" @click="lookLevel">水平前视</button>
            <button
              type="button"
              :class="{ active: snap.recording }"
              data-testid="record-toggle"
              @click="toggleRecording"
            >
              {{ snap.recording ? '停止录像' : '开始录像' }}
            </button>
          </div>
          <div class="segmented two">
            <button type="button" data-testid="photo-button" :disabled="photoBusy" @click="takePhoto">
              {{ photoBusy ? '拍摄中…' : `拍照(已拍 ${snap.photoCount} 张)` }}
            </button>
            <button type="button" @click="toggleArms" :disabled="snap.airborne">机臂收纳 / 展开</button>
          </div>
          <div v-if="photoNote || recordNote || lastPhoto || lastRecording" class="capture-panel">
            <p v-if="recordNote" class="capture-note" data-testid="record-note">{{ recordNote }}</p>
            <a
              v-if="lastRecording"
              class="capture-note capture-download"
              :href="lastRecording.url"
              :download="lastRecording.name"
              data-testid="record-download"
            >
              手动下载最近一次录像({{ (lastRecording.size / 1048576).toFixed(1) }}MB)
            </a>
            <p v-if="photoNote" class="capture-note" data-testid="photo-note">{{ photoNote }}</p>
            <img
              v-if="lastPhoto"
              class="capture-thumb"
              :src="lastPhoto.dataUrl"
              alt="最近一张照片"
              data-testid="photo-thumb"
            />
          </div>
          <p class="fine-print">
            云台为三轴增稳平台:机体倾斜由云台反向补偿,超出机械行程(−90°~+60°)才让画面跟着歪。
            拍照与录像都用云台取景(与机载视角同一取景),文件均自动下载。
          </p>
        </section>

        <section class="card grow">
          <div class="card-title"><span>事件日志</span><em>{{ snap.events.length }}</em></div>
          <ul class="event-log" data-testid="event-log">
            <li v-for="event in snap.events" :key="event.id" :class="event.level">
              <span class="t">{{ formatClock(event.time) }}</span>
              <span class="m">{{ event.text }}</span>
            </li>
            <li v-if="!snap.events.length" class="muted">暂无事件</li>
          </ul>
        </section>
      </div>
    </aside>

    <!-- ═══════════════════════ 底部:摇杆台 ═══════════════════════ -->
    <div class="stick-deck">
      <StickDial
        :x="leftKnob.x"
        :y="leftKnob.y"
        label="左摇杆 · 美国手"
        axis-h="偏航 ← →"
        axis-v="升降 ↓ ↑"
        @move="onDialMove('left', $event)"
      />
      <div class="deck-center">
        <div class="deck-title">
          <span>相机视角</span>
          <em>{{ cameraModeLabel }}</em>
        </div>
        <div class="segmented three">
          <button
            v-for="mode in CAMERA_MODE_LIST"
            :key="mode.key"
            type="button"
            :data-testid="`camera-${mode.key}`"
            :class="{ active: cameraMode === mode.key }"
            @click="setCameraMode(mode.key)"
          >
            {{ mode.label }}
          </button>
        </div>
        <button type="button" class="wide mini-btn" @click="resetCamera">复位观察视角</button>
        <div class="deck-actions">
          <button type="button" class="danger" :disabled="!canEmergency" :title="emergencyHint" @click="doEmergency">
            停桨
          </button>
          <button type="button" @click="doReset">重置</button>
        </div>
        <p class="keyhint">
          W/S 升降 · A/D 偏航 · ↑↓←→ 前后左右<br />
          Space 起飞 · L 降落 · R 返航 · K 停桨 · P 电源<br />
          G 航线(执行/暂停/继续) · Z/X 云台 · V 录像 · B 拍照 · C 切视角
        </p>
      </div>
      <StickDial
        :x="rightKnob.x"
        :y="rightKnob.y"
        label="右摇杆 · 美国手"
        axis-h="横滚 ← →"
        axis-v="俯仰 ↓ ↑"
        @move="onDialMove('right', $event)"
      />
    </div>

    <div v-if="!ready" class="loading">正在加载 DJI Mini 4 Pro 模型…</div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { GameInstance } from '../../lib/three-engine/game-instance'
import { CAMERA_MODE_LIST } from '../../lib/three-engine/drone-fly'
import type { CameraMode, MissionEditState, PhotoShot } from '../../lib/three-engine/drone-fly'
import {
  DRONE_SPEC,
  FLIGHT_MODES,
  FLIGHT_MODE_LIST,
  NO_FAULTS,
  PHASE_LABELS,
  POSITION_SOURCE_LABELS,
  DEFAULT_CONFIG,
  DEFAULT_MISSION,
  DEFAULT_MISSION_CONFIG,
  MISSION_STAGE_LABELS,
  MISSION_STATUS_LABELS,
  isMissionDepartStage,
  type DroneSnapshot,
  type FaultFlags,
  type FlightMode,
  type FlightPhase,
  type MissionConfig,
  type MissionFinishAction,
  type MissionWaypoint,
  type SimConfig,
} from '../../lib/three-engine/drone-sim'
import { STATUS_PATTERN_LIST, describeBatteryLevel } from '../../lib/three-engine/drone-lights'
import type { AuxLightMode, BatteryLightMode, DroneLightsSnapshot, StatusLightKey } from '../../lib/three-engine/drone-lights'
import type { RigPartReport } from '../../lib/three-engine/drone-rig'
import type { RadarAim, RadarHit, RadarSnapshot } from '../../lib/three-engine/drone-radar'
import StickDial from './stick-dial.vue'

let gameInstance: GameInstance | null = null
const viewportRef = ref<HTMLElement | null>(null)
const ready = ref(false)

// ————————————————————————————— 面板状态 —————————————————————————————

const TABS = [
  { key: 'flight', label: '飞行' },
  { key: 'mission', label: '航线' },
  { key: 'lights', label: '灯光' },
  { key: 'config', label: '参数' },
  { key: 'faults', label: '故障' },
  { key: 'model', label: '模型' },
] as const
type TabKey = (typeof TABS)[number]['key']
const tab = ref<TabKey>('flight')

type WaypointNumberKey = 'x' | 'z' | 'altitude' | 'speed' | 'hoverSeconds' | 'gimbalPitch'
/** 航点编辑器的本地草稿:数字字段存字符串,允许 "-"、"1." 这类输入中间态 */
interface WaypointDraftRow {
  x: string
  z: string
  altitude: string
  speed: string
  hoverSeconds: string
  gimbalPitch: string
  gimbalOn: boolean
  action: MissionWaypoint['action']
}

const PHASE_FLOW: Array<{ phase: FlightPhase; label: string }> = [
  { phase: 'powerOff', label: '未上电' },
  { phase: 'selfCheck', label: '开机自检' },
  { phase: 'warmingUp', label: '传感器预热' },
  { phase: 'standby', label: '地面待机' },
  { phase: 'motorsOn', label: '电机启动' },
  { phase: 'takingOff', label: '自动起飞' },
  { phase: 'flying', label: '空中飞行' },
]

const PITCH_MARKS = [-30, -20, -10, 10, 20, 30]
const PITCH_PX = 2
const COMPASS_TICKS = Array.from({ length: 36 }, (_, index) => ({
  angle: index * 10,
  major: index % 3 === 0,
}))
const CARDINALS = [
  { label: 'N', angle: 0 },
  { label: 'E', angle: 90 },
  { label: 'S', angle: 180 },
  { label: 'W', angle: 270 },
]

const TIME_SCALES = [1, 2, 4, 8]
const BATTERY_PRESETS = [100, 60, 30, 20, 10, 5]
const BATTERY_MODES: Array<{ key: BatteryLightMode; label: string }> = [
  { key: 'level', label: '电量' },
  { key: 'charging', label: '充电' },
  { key: 'full', label: '充满' },
  { key: 'fault', label: '异常' },
  { key: 'off', label: '关闭' },
]
const AUX_MODES: Array<{ key: AuxLightMode; label: string }> = [
  { key: 'auto', label: '自动' },
  { key: 'on', label: '开启' },
  { key: 'off', label: '关闭' },
]
/** 航点任务结束动作 */
const MISSION_FINISH_ACTIONS: Array<{ key: MissionFinishAction; label: string }> = [
  { key: 'hover', label: '原地悬停' },
  { key: 'rth', label: '自动返航' },
  { key: 'land', label: '自动降落' },
]
/** 航点到点动作 */
const MISSION_ACTIONS: Array<{ key: MissionWaypoint['action']; label: string }> = [
  { key: 'none', label: '无动作' },
  { key: 'photo', label: '拍照' },
]
const FAILSAFE_MODES: Array<{ key: SimConfig['rcFailsafe']; label: string }> = [
  { key: 'rth', label: '返航' },
  { key: 'hover', label: '悬停' },
  { key: 'land', label: '降落' },
]
const LIMIT_ROWS: Array<{ key: 'maxAltitude' | 'maxDistance'; label: string; min: number; max: number; step: number; unit: string }> = [
  { key: 'maxAltitude', label: '限高', min: 20, max: 500, step: 10, unit: ' m' },
  { key: 'maxDistance', label: '限距', min: 30, max: 2000, step: 10, unit: ' m' },
]
const FAULT_LIST: Array<{
  key: keyof FaultFlags
  label: string
  hint: string
  severity: 'error' | 'warn'
}> = [
  { key: 'gnssLost', label: 'GNSS 卫星丢失', hint: '降级为视觉定位;12 米以上进入姿态模式', severity: 'error' },
  { key: 'compassError', label: '指南针受扰', hint: '航向持续漂移,需重新校准', severity: 'error' },
  { key: 'imuError', label: 'IMU 惯性测量单元异常', hint: '直接禁止起飞', severity: 'error' },
  { key: 'motorFailure', label: '单电机动力衰减', hint: '机身缓慢自旋,飞控持续修正', severity: 'warn' },
  { key: 'rcLost', label: '遥控器信号丢失', hint: '3 秒后触发失效保护', severity: 'error' },
  { key: 'visionLost', label: '下视视觉失效', hint: '低空无法视觉定位', severity: 'warn' },
  { key: 'obstacleAvoidanceOff', label: '关闭避障', hint: '不再自动刹停,可能撞上障碍物', severity: 'warn' },
]

const statusPatterns = STATUS_PATTERN_LIST
const config = reactive<SimConfig>({ ...DEFAULT_CONFIG })
const faults = reactive<FaultFlags>({ ...NO_FAULTS })
const lights = reactive<DroneLightsSnapshot>({
  statusKey: 'off',
  statusLabel: '未上电 / 关闭',
  statusMeaning: '状态灯熄灭',
  batteryMode: 'level',
  batteryLevel: 100,
  batteryLeds: [],
  auxMode: 'auto',
  auxOn: false,
  auxLocked: true,
})
const snap = ref<DroneSnapshot>(emptySnapshot())
const rigReport = ref<RigPartReport[]>([])
const cameraMode = ref<CameraMode>('orbit')
const lightAuto = ref(true)
const showObstacles = ref(true)
const showAxes = ref(false)
const showRadarBeams = ref(false)
/** 航点标记与航线折线的显隐(拆成两个开关;只影响绘制,不影响任务执行) */
const showMissionWaypoints = ref(true)
const showMissionPath = ref(true)
/** 场景内编辑航点的实时状态(100ms 从装配层取) */
const sceneEdit = ref<MissionEditState>({
  enabled: false,
  active: false,
  selectedIndex: -1,
  hoverIndex: -1,
  dragging: false,
  mode: null,
})
/** 航点编辑器的显示源(见 syncWaypointDraft 的说明) */
const waypointDraft = ref<WaypointDraftRow[]>([])
/** 底部辅助照明灯的下向光束锥(默认不显示,勾选才画) */
const showAuxBeam = ref(false)
const radar = ref<RadarSnapshot>({
  detecting: false,
  left: null,
  right: null,
  range: 18,
  upLeft: null,
  upRight: null,
  upRange: 15,
  aim: 'forward',
})
const dialLeft = reactive({ x: 0, y: 0 })
const dialRight = reactive({ x: 0, y: 0 })
const keyAxes = reactive({ throttle: 0, yaw: 0, pitch: 0, roll: 0 })
/** 最近一张照片(云台取景)与提示文案 */
const lastPhoto = ref<PhotoShot | null>(null)
const photoNote = ref('')
const photoBusy = ref(false)
/** 快门闪一下,盖住拍照那一帧的取景切换 */
const shutterFlash = ref(false)
const recordNote = ref('')
/** 最近一次录制成片:自动下载可能被浏览器静默拦掉,这里留一份供手动下载 */
const lastRecording = ref<{ url: string; name: string; size: number } | null>(null)

// ————————————————————————————— 派生状态 —————————————————————————————

const clamp = (value: number, min = -1, max = 1): number => Math.min(max, Math.max(min, value))
const signed = (value: number, digits: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`

const flowIndex = computed(() => {
  const phase = snap.value.phase
  const direct = PHASE_FLOW.findIndex((item) => item.phase === phase)
  if (direct >= 0) return direct
  if (phase === 'rth' || phase === 'landing') return PHASE_FLOW.length - 1
  return PHASE_FLOW.length
})
const phaseTail = computed(() => {
  switch (snap.value.phase) {
    case 'rth':
      return '智能返航'
    case 'landing':
      return '自动降落'
    case 'emergency':
      return '紧急停桨'
    case 'stopped':
      return '已停桨'
    default:
      return ''
  }
})
const phaseTone = computed(() => {
  switch (snap.value.phase) {
    case 'flying':
    case 'takingOff':
      return 'ok'
    case 'rth':
    case 'landing':
    case 'motorsOn':
      return 'warn'
    case 'emergency':
      return 'bad'
    default:
      return ''
  }
})
const nextStep = computed<{ text: string; tone: string }>(() => {
  const current = snap.value
  if (current.damaged) return { text: '飞行器坠地受损:点击「重置沙盒」后重新上电', tone: 'error' }
  if (current.armFold > 0.5 && current.phase === 'powerOff') {
    return { text: '第 1 步:点击「展开机臂」——真机必须展开机臂才能起飞', tone: 'warn' }
  }
  switch (current.phase) {
    case 'powerOff':
      return { text: '第 2 步:点击「电源开机」——飞控将执行自检与传感器预热', tone: 'info' }
    case 'selfCheck':
      return { text: '系统自检中,状态灯红绿黄交替闪烁', tone: 'info' }
    case 'warmingUp':
      return { text: '传感器预热中,同时 GNSS 正在搜星', tone: 'info' }
    case 'standby':
      return { text: '第 3 步:等待检查项全部通过后点击「一键起飞」', tone: 'ok' }
    case 'motorsOn':
      return { text: '电机已启动,点击「一键起飞」离地', tone: 'ok' }
    case 'takingOff':
      return { text: '自动上升至 1.2 米并进入悬停', tone: 'info' }
    case 'flying':
      return { text: '推动右摇杆前进,左摇杆控制升降与偏航;松杆自动刹停悬停', tone: 'ok' }
    case 'rth':
      return { text: `返航中(${current.rthReason}),推动摇杆可中止返航`, tone: 'warn' }
    case 'landing':
      return { text: '自动降落中,距地面 2 米以下减速', tone: 'info' }
    case 'emergency':
      return { text: '动力丧失,飞行器正在坠落', tone: 'error' }
    default:
      return { text: '飞行器已落地,重新上电即可再次起飞', tone: 'warn' }
  }
})
const blockingItems = computed(() => snap.value.checklist.filter((item) => item.blocking && !item.ok))
const okCount = computed(() => snap.value.checklist.filter((item) => item.ok).length)
const takeoffBlockReason = computed(() =>
  blockingItems.value.length ? `起飞被阻止:${blockingItems.value.map((item) => item.label).join('、')}` : '',
)
const activeFaultCount = computed(() => FAULT_LIST.filter((item) => faults[item.key]).length)
const foundCount = computed(() => rigReport.value.filter((part) => part.found).length)
const cameraModeLabel = computed(() => CAMERA_MODE_LIST.find((item) => item.key === cameraMode.value)?.label ?? '观察者')
const currentModeSpec = computed(() => FLIGHT_MODES[snap.value.mode])
const vSpeedClass = computed(() => (snap.value.verticalSpeed > 0.05 ? 'up' : snap.value.verticalSpeed < -0.05 ? 'down' : ''))
const batteryTone = computed(() => (snap.value.criticalBattery ? 'bad' : snap.value.lowBattery ? 'warn' : ''))
const batteryColor = computed(() => {
  if (snap.value.criticalBattery) return '#ff5b4a'
  if (snap.value.lowBattery) return '#ffc53d'
  return '#6ff0d0'
})
const rthStageLabel = computed(() => {
  switch (snap.value.rthStage) {
    case 'ascend':
      return '上升至返航高度'
    case 'cruise':
      return '水平飞向返航点'
    case 'descend':
      return '下降中'
    case 'landing':
      return '着陆'
    default:
      return ''
  }
})
/** 返航点相对机头的方位角(罗盘上以绿色三角标出) */
const homeBearing = computed(() => {
  if (!snap.value.homeRecorded) return null
  const dx = 0 - snap.value.positionX
  const dz = 0 - snap.value.positionZ
  if (Math.hypot(dx, dz) < 0.5) return null
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
})
const obstacleCells = computed(() => {
  const report = snap.value.obstacle
  const rows: Array<{ label: string; value: number | null }> = [
    { label: '前', value: report.forward },
    { label: '后', value: report.backward },
    { label: '左', value: report.left },
    { label: '右', value: report.right },
    { label: '上', value: report.up },
    { label: '下', value: report.down },
  ]
  return rows.map((row) => ({
    label: row.label,
    text: row.value === null ? '—' : `${row.value.toFixed(1)}m`,
    near: row.value !== null && row.value < 4,
  }))
})

// ————————————————————————————— 航线任务派生状态 —————————————————————————————

const missionTone = computed(() => {
  switch (snap.value.mission.status) {
    case 'running':
      return 'ok'
    case 'paused':
      return 'warn'
    default:
      return ''
  }
})
/** 航点列表只在任务未执行时可改:与真机"航线上传后不可修改"一致 */
const missionEditable = computed(() => snap.value.mission.status === 'idle')
const canStartMission = computed(
  () =>
    snap.value.mission.status === 'idle' &&
    snap.value.mission.total > 0 &&
    ['standby', 'motorsOn', 'takingOff', 'flying', 'rth'].includes(snap.value.phase),
)
const canPauseMission = computed(() => snap.value.mission.status === 'running')
const canResumeMission = computed(() => snap.value.mission.status === 'paused')
const canStopMission = computed(
  () => snap.value.mission.status !== 'idle' || snap.value.phase === 'takingOff',
)
/** 启动不了时把原因摆出来,别让按钮灰着却没有解释 */
const missionBlockReason = computed(() => {
  const mission = snap.value.mission
  if (mission.status !== 'idle') return ''
  if (mission.total === 0) return '航线为空:先「添加航点」或「示例航线」'
  if (snap.value.positionSource === 'atti') return '当前无定位(姿态模式),航点任务需要 GNSS'
  if (!canStartMission.value) return `当前阶段(${snap.value.phaseLabel})无法启动航线`
  return ''
})
const missionProgressText = computed(() => {
  const mission = snap.value.mission
  if (mission.status === 'idle') {
    return mission.total ? `待执行 · 共 ${mission.total} 个航点` : '暂无航线'
  }
  // 启航四步还没走完:这几步都是"去首个航点"的准备动作,单独标出来
  if (isMissionDepartStage(mission.stage)) {
    return `启航(航点 1/${mission.total}) · ${mission.stageLabel}`
  }
  return `第 ${mission.index + 1}/${mission.total} 个航点 · ${mission.stageLabel}`
})
const missionPercent = computed(() => Math.round(snap.value.mission.progress * 100))
const missionEtaText = computed(() => {
  if (snap.value.mission.status === 'idle') return '—'
  const seconds = snap.value.mission.etaSeconds
  return seconds >= 60
    ? `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
    : `${seconds.toFixed(0)} 秒`
})
const isActiveWaypoint = (index: number): boolean =>
  snap.value.mission.status !== 'idle' && snap.value.mission.index === index

/** 前视雷达双射线读数(0-5m 红 / 5-10m 黄 / 更远或无命中绿) */
const radarRays = computed(() => [
  { label: '左射线', hit: radar.value.left },
  { label: '右射线', hit: radar.value.right },
])

/** 上视雷达双射线读数(机背两个上视孔,远距用蓝区分前视) */
const radarUpRays = computed(() => [
  { label: '左射线', hit: radar.value.upLeft },
  { label: '右射线', hit: radar.value.upRight },
])

function radarText(hit: RadarHit | null): string {
  return hit ? `${hit.distance.toFixed(1)} m` : '畅通'
}

function radarLabel(hit: RadarHit | null): string {
  return hit ? hit.label : '量程内无障碍'
}

function radarLevel(hit: RadarHit | null): string {
  if (!hit) return 'far'
  if (hit.distance < 5) return 'near'
  if (hit.distance < 10) return 'mid'
  return 'far'
}

/** 摇杆旋钮显示"拖拽 + 键盘"的合成量,键鼠两种输入都能在摇杆上看见 */
const leftKnob = computed(() => ({
  x: clamp(dialLeft.x + keyAxes.yaw),
  y: clamp(dialLeft.y + keyAxes.throttle),
}))
const rightKnob = computed(() => ({
  x: clamp(dialRight.x + keyAxes.roll),
  y: clamp(dialRight.y + keyAxes.pitch),
}))

const canPowerToggle = computed(() =>
  snap.value.phase === 'powerOff' ? !snap.value.damaged : !snap.value.airborne,
)
const canStartMotors = computed(() => snap.value.phase === 'standby' && blockingItems.value.length === 0)
const canTakeOff = computed(
  () => (snap.value.phase === 'standby' || snap.value.phase === 'motorsOn') && blockingItems.value.length === 0,
)
const canLand = computed(() => snap.value.airborne || snap.value.phase === 'takingOff')
const canRth = computed(() => snap.value.airborne && snap.value.phase !== 'rth')
const canCancelRth = computed(() => snap.value.phase === 'rth')
/**
 * 紧急停桨只在**落地后**可用(空中停桨会坠机,按需求禁用):
 * 仅当电机已启动(phase=motorsOn,必然在地面)时才点亮。
 */
const canEmergency = computed(() => snap.value.phase === 'motorsOn' && !snap.value.airborne)
/** 停桨按钮的悬停提示:说明当前为什么可用/不可用 */
const emergencyHint = computed(() => {
  if (snap.value.airborne) return '飞行器尚未落地,不能紧急停桨(请先降落)'
  if (snap.value.phase !== 'motorsOn') return '电机未启动,无需停桨'
  return '立即停桨(仅在落地后可用)'
})

const batteryText = computed(() => {
  if (lights.batteryMode === 'off') return '已关闭'
  if (lights.batteryMode === 'charging') return '充电中 · 跑马点亮'
  if (lights.batteryMode === 'full') return '充满 · 4 灯常亮'
  if (lights.batteryMode === 'fault') return '异常闪烁 · 检查温度/充电器'
  return `${lights.batteryLevel}% · ${describeBatteryLevel(lights.batteryLevel)}`
})
const auxStatusText = computed(() => {
  if (lights.auxMode === 'off') return '已关闭'
  if (lights.auxOn) return lights.auxMode === 'auto' ? '自动点亮 · 低空降落辅助' : '已点亮'
  if (lights.auxLocked) return '地面锁定 · 起飞后点亮'
  return '熄灭'
})

// ————————————————————————————— 工具函数 —————————————————————————————

function emptySnapshot(): DroneSnapshot {
  return {
    phase: 'powerOff',
    phaseLabel: PHASE_LABELS.powerOff,
    mode: 'normal',
    modeLabel: FLIGHT_MODES.normal.label,
    positionSource: 'atti',
    positionSourceLabel: POSITION_SOURCE_LABELS.atti,
    airborne: false,
    motorsOn: false,
    damaged: false,
    batteryPercent: 100,
    batteryVoltage: DRONE_SPEC.batteryFullVoltage,
    batteryCurrent: 0,
    batteryTemp: 24,
    batteryWhLeft: DRONE_SPEC.batteryWh,
    batteryModeText: '正常',
    altitude: 0,
    altitudeMax: 0,
    positionX: 0,
    positionZ: 0,
    horizontalSpeed: 0,
    verticalSpeed: 0,
    heading: 0,
    tiltPitch: 0,
    tiltRoll: 0,
    distanceToHome: 0,
    homeRecorded: false,
    altitudeLimitReached: false,
    distanceLimitReached: false,
    satellites: 0,
    hdop: 99,
    gpsBars: 0,
    rcBars: 0,
    visionAvailable: false,
    gimbalPitch: -10,
    gimbalRoll: 0,
    gimbalYaw: 0,
    motorLoad: 0,
    armFold: 1,
    stick: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },
    windSpeed: 0,
    windDirection: 0,
    windRelative: '静风',
    flightTime: 0,
    totalTime: 0,
    remainingMinutes: DRONE_SPEC.maxFlightTimeMin,
    lowBattery: false,
    criticalBattery: false,
    lowBatteryCountdown: 0,
    rthStage: '',
    landingStage: '',
    rthReason: '',
    warnings: [],
    events: [],
    checklist: [],
    obstacle: {
      forward: null,
      backward: null,
      left: null,
      right: null,
      up: null,
      down: null,
      braking: false,
      brakingDirection: null,
    },
    recording: false,
    recordSeconds: 0,
    photoCount: 0,
    cameraZoom: 1,
    mission: {
      status: 'idle',
      statusLabel: MISSION_STATUS_LABELS.idle,
      stage: 'idle',
      stageLabel: MISSION_STAGE_LABELS.idle,
      index: -1,
      total: DEFAULT_MISSION.length,
      passes: 0,
      elapsed: 0,
      distanceLeft: 0,
      progress: 0,
      etaSeconds: 0,
      pauseReason: '',
      active: null,
      waypoints: DEFAULT_MISSION.map((waypoint) => ({ ...waypoint })),
      config: { ...DEFAULT_MISSION_CONFIG },
    },
  }
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const CARDINAL_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
function cardinal(degrees: number): string {
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8
  return CARDINAL_NAMES[index] ?? '北'
}

// ————————————————————————————— 摇杆 / 输入 —————————————————————————————

/** 把键盘与两个虚拟摇杆合成为一路摇杆指令(美国手 Mode 2) */
function pushStick(): void {
  const fly = gameInstance?.droneFly
  if (!fly) return
  fly.setStick({
    throttle: clamp(dialLeft.y + keyAxes.throttle),
    yaw: clamp(dialLeft.x + keyAxes.yaw),
    pitch: clamp(dialRight.y + keyAxes.pitch),
    roll: clamp(dialRight.x + keyAxes.roll),
  })
}

function onDialMove(side: 'left' | 'right', payload: { x: number; y: number }): void {
  const target = side === 'left' ? dialLeft : dialRight
  target.x = payload.x
  target.y = payload.y
  pushStick()
}

const AXIS_KEYS: Record<string, { axis: 'throttle' | 'yaw' | 'pitch' | 'roll'; value: number }> = {
  w: { axis: 'throttle', value: 1 },
  s: { axis: 'throttle', value: -1 },
  a: { axis: 'yaw', value: -1 },
  d: { axis: 'yaw', value: 1 },
  arrowup: { axis: 'pitch', value: 1 },
  arrowdown: { axis: 'pitch', value: -1 },
  arrowleft: { axis: 'roll', value: -1 },
  arrowright: { axis: 'roll', value: 1 },
}

function normalizedKey(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase()
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element?.tagName) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

function handleKeyDown(event: KeyboardEvent): void {
  const key = normalizedKey(event)
  const axis = AXIS_KEYS[key]
  if (axis) {
    event.preventDefault()
    if (isTextTarget(event.target)) return
    keyAxes[axis.axis] = axis.value
    pushStick()
    return
  }
  if (event.repeat || isTextTarget(event.target)) return
  switch (key) {
    case ' ':
      event.preventDefault()
      if (canTakeOff.value) doTakeOff()
      break
    case 'p':
      event.preventDefault()
      togglePower()
      break
    case 'l':
      event.preventDefault()
      doLand()
      break
    case 'r':
      event.preventDefault()
      doRth()
      break
    case 'k':
      event.preventDefault()
      doEmergency()
      break
    case 'c':
      event.preventDefault()
      cycleCamera()
      break
    case 'm':
      event.preventDefault()
      cycleMode()
      break
    case 'f':
      event.preventDefault()
      selectAuxMode(lights.auxMode === 'off' ? 'on' : 'off')
      break
    case 'z':
      event.preventDefault()
      gameInstance?.droneFly?.nudgeGimbal(-5)
      break
    case 'x':
      event.preventDefault()
      gameInstance?.droneFly?.nudgeGimbal(5)
      break
    case 'g':
      event.preventDefault()
      toggleMission()
      break
    case 'v':
      event.preventDefault()
      toggleRecording()
      break
    case 'b':
      event.preventDefault()
      takePhoto()
      break
    default:
      break
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  const axis = AXIS_KEYS[normalizedKey(event)]
  if (!axis) return
  event.preventDefault()
  keyAxes[axis.axis] = 0
  pushStick()
}

/** 失焦时释放所有摇杆,避免"卡杆"导致飞机一直飞 */
function releaseAllInput(): void {
  keyAxes.throttle = 0
  keyAxes.yaw = 0
  keyAxes.pitch = 0
  keyAxes.roll = 0
  dialLeft.x = 0
  dialLeft.y = 0
  dialRight.x = 0
  dialRight.y = 0
  pushStick()
}

// ————————————————————————————— 飞控指令 —————————————————————————————

const sim = () => gameInstance?.droneFly?.sim

function togglePower(): void {
  const instance = sim()
  if (!instance) return
  if (instance.phase === 'powerOff') instance.powerOn()
  else instance.powerOff()
}

function toggleArms(): void {
  setArmFold(snap.value.armFold > 0.5 ? 0 : 1)
}

function setArmFold(fold: number): void {
  gameInstance?.droneFly?.setArmFoldTarget(fold)
}

function doStartMotors(): void {
  sim()?.startMotors()
}

function doStopMotors(): void {
  sim()?.stopMotors()
}

function doTakeOff(): void {
  sim()?.autoTakeOff()
}

function doLand(): void {
  sim()?.startLanding()
}

function doRth(): void {
  sim()?.startRth('用户手动触发')
}

function doCancelRth(): void {
  sim()?.cancelRth()
}

function doEmergency(): void {
  sim()?.emergencyStop()
}

function doReset(): void {
  const instance = sim()
  if (!instance) return
  instance.reset()
  releaseAllInput()
  gameInstance?.droneFly?.clearTrail()
  gameInstance?.droneFly?.setCameraMode('orbit')
  cameraMode.value = 'orbit'
  gameInstance?.droneFly?.resetCamera()
  lightAuto.value = true
  gameInstance?.droneFly?.clearStatusLightOverride()
  rigReport.value = gameInstance?.droneFly?.getRigReport() ?? []
  applyWorldVisibility()
}

function setMode(mode: FlightMode): void {
  gameInstance?.droneFly?.setMode(mode)
}

function cycleMode(): void {
  const order: FlightMode[] = ['cine', 'normal', 'sport']
  const index = order.indexOf(snap.value.mode)
  setMode(order[(index + 1) % order.length] ?? 'normal')
}

function setBattery(level: number): void {
  sim()?.forceBatteryLevel(level)
}

// ————————————————————————————— 航线任务 —————————————————————————————

function doStartMission(): void {
  gameInstance?.droneFly?.startMission()
}

function doPauseMission(): void {
  gameInstance?.droneFly?.pauseMission('用户暂停')
}

function doResumeMission(): void {
  gameInstance?.droneFly?.resumeMission()
}

function doStopMission(): void {
  gameInstance?.droneFly?.stopMission('用户停止')
}

/** 一个键走完"执行 → 暂停 → 继续"(G 键与底部快捷按钮共用) */
function toggleMission(): void {
  const status = snap.value.mission.status
  if (status === 'running') doPauseMission()
  else if (status === 'paused') doResumeMission()
  else doStartMission()
}

function applyMissionConfig(patch: Partial<MissionConfig>): void {
  gameInstance?.droneFly?.setMissionConfig(patch)
  syncUi()
}

function onMissionSpeedInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  applyMissionConfig({ autoSpeed: value })
}

function onMissionLoopToggle(event: Event): void {
  applyMissionConfig({ loop: (event.target as HTMLInputElement).checked })
}

/** 航点数字字段的取值范围(与内核的归一化保持一致) */
const WAYPOINT_RANGES: Record<WaypointNumberKey, { min: number; max: number }> = {
  x: { min: -2000, max: 2000 },
  z: { min: -2000, max: 2000 },
  altitude: { min: 1, max: 500 },
  speed: { min: 0, max: 16 },
  hoverSeconds: { min: 0, max: 60 },
  gimbalPitch: { min: -90, max: 60 },
}

function toDraftRow(waypoint: MissionWaypoint): WaypointDraftRow {
  return {
    x: String(waypoint.x),
    z: String(waypoint.z),
    altitude: String(waypoint.altitude),
    speed: String(waypoint.speed),
    hoverSeconds: String(waypoint.hoverSeconds),
    gimbalPitch: String(waypoint.gimbalPitch ?? -45),
    gimbalOn: waypoint.gimbalPitch !== null,
    action: waypoint.action,
  }
}

/** 输入框里正在编辑时不要用快照回写草稿,否则用户输到一半会被清掉 */
function waypointEditing(): boolean {
  const active = document.activeElement
  return Boolean(active && active.closest('.waypoint-list'))
}

/**
 * 把内核里的航点同步成"草稿"。
 *
 * 为什么需要草稿:面板每 100ms 重建一次快照并重渲染,而 Vue 的 `:value` 绑定会把输入框的
 * 值改回模型值 —— 用户打到一半的 "−"、"1." 这种中间态会被抹掉,`change` 事件也就永远不会
 * 派发(值已经被改回去了)。所以输入框的显示值以草稿为准,草稿在编辑期间不回写。
 */
function syncWaypointDraft(): void {
  const list = gameInstance?.droneFly?.sim.mission
  if (!list || waypointEditing()) return
  const rows = list.map(toDraftRow)
  const current = waypointDraft.value
  const same =
    current.length === rows.length &&
    rows.every((row, index) => {
      const draft = current[index]
      if (!draft) return false
      return (
        draft.x === row.x &&
        draft.z === row.z &&
        draft.altitude === row.altitude &&
        draft.speed === row.speed &&
        draft.hoverSeconds === row.hoverSeconds &&
        draft.gimbalOn === row.gimbalOn &&
        (!row.gimbalOn || draft.gimbalPitch === row.gimbalPitch) &&
        draft.action === row.action
      )
    })
  if (!same) waypointDraft.value = rows
}

/**
 * 航点列表的权威来源是仿真内核,不是界面快照。
 * 快照每 100ms 才刷新一次,若拿快照改字段,连续编辑两格会丢掉前一格 —— 所以一律从 sim 现取。
 */
function currentWaypoints(): MissionWaypoint[] {
  const list = gameInstance?.droneFly?.sim.mission ?? []
  return list.map((waypoint) => ({ ...waypoint }))
}

function patchWaypoint(index: number, patch: Partial<MissionWaypoint>): void {
  const fly = gameInstance?.droneFly
  if (!fly) return
  const list = currentWaypoints().map((waypoint, i) => (i === index ? { ...waypoint, ...patch } : waypoint))
  fly.setMission(list)
  syncUi()
}

/** 数字字段输入:先落草稿(保证输入框不被回写),再把合法值下发到内核 */
function onWaypointTextInput(index: number, key: WaypointNumberKey, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  const draft = waypointDraft.value[index]
  if (draft) draft[key] = raw
  if (raw.trim() === '') return
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  const range = WAYPOINT_RANGES[key]
  patchWaypoint(index, { [key]: Math.min(range.max, Math.max(range.min, value)) } as Partial<MissionWaypoint>)
}

function onWaypointActionChange(index: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value === 'photo' ? 'photo' : 'none'
  const draft = waypointDraft.value[index]
  if (draft) draft.action = value
  patchWaypoint(index, { action: value })
}

function onWaypointGimbalToggle(index: number, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked
  const draft = waypointDraft.value[index]
  if (draft) draft.gimbalOn = enabled
  patchWaypoint(index, { gimbalPitch: enabled ? -45 : null })
}

function addWaypoint(): void {
  const fly = gameInstance?.droneFly
  if (!fly) return
  const list = currentWaypoints()
  const last = list[list.length - 1]
  const next: Partial<MissionWaypoint> = last
    ? { x: last.x + 12, z: last.z, altitude: last.altitude, speed: last.speed }
    : { x: 0, z: -30, altitude: 30, speed: 0, hoverSeconds: 0, gimbalPitch: null, action: 'none' }
  fly.setMission([...list, next])
  syncUi()
}

function removeWaypoint(index: number): void {
  const fly = gameInstance?.droneFly
  if (!fly) return
  fly.setMission(currentWaypoints().filter((_, i) => i !== index))
  // 删掉的可能正是场景里选中的那个,索引会整体前移,直接取消选中最不容易出错
  selectWaypoint(-1)
  syncUi()
}

function useDefaultMission(): void {
  selectWaypoint(-1)
  gameInstance?.droneFly?.resetMissionToDefault()
  syncUi()
}

function clearWaypoints(): void {
  selectWaypoint(-1)
  gameInstance?.droneFly?.setMission([])
  syncUi()
}

// ————————————————————————————— 场景内编辑航点 —————————————————————————————

/** 被选中的航点(读内核而不是快照,拖动过程中它每帧都在变) */
const selectedWaypoint = computed(() => {
  const index = sceneEdit.value.selectedIndex
  if (index < 0) return null
  return gameInstance?.droneFly?.sim.mission[index] ?? null
})

const sceneEditBadge = computed(() => {
  const state = sceneEdit.value
  if (!state.enabled) return { label: '已关闭', tone: '' }
  if (state.dragging) return { label: '拖动中', tone: 'warn' }
  if (state.active) return { label: '编辑中', tone: 'on' }
  return { label: '待切换视角', tone: 'warn' }
})

const sceneEditBlockReason = computed(() => {
  if (!missionEditable.value) return '任务执行中不可编辑'
  if (cameraMode.value !== 'orbit') return '需切到观察者视角'
  return '当前不可编辑'
})

function onSceneEditToggle(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked
  gameInstance?.droneFly?.setMissionEditEnabled(enabled)
  if (enabled) syncUi()
}

/** 选中航点(-1 = 取消):面板列表与三维场景共用同一份选中态 */
function selectWaypoint(index: number): void {
  gameInstance?.droneFly?.setMissionSelected(index)
  sceneEdit.value = { ...sceneEdit.value, selectedIndex: index }
  if (index >= 0) revealWaypointRow(index)
}

function deleteSelectedWaypoint(): void {
  const index = sceneEdit.value.selectedIndex
  if (index < 0) return
  gameInstance?.droneFly?.deleteMissionWaypoint(index)
  syncUi()
}

function addWaypointAtDrone(): void {
  gameInstance?.droneFly?.addMissionWaypointAtDrone()
  syncUi()
  const index = gameInstance?.droneFly?.getMissionSelected() ?? -1
  if (index >= 0) revealWaypointRow(index)
}

/** 把观察者相机拉到能看全整条航线的位置(开着场景编辑也随时能用) */
function frameMission(): void {
  gameInstance?.droneFly?.frameMission()
}

/** 从场景里选中时,把列表里对应的那一行滚进视野(列表有最大高度,可能不在可视区) */
function revealWaypointRow(index: number): void {
  void nextTick(() => {
    const row = document.querySelector(`[data-testid="waypoint-${index}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  })
}

// ————————————————————————————— 参数 / 故障 —————————————————————————————

function applyConfig(patch: Partial<SimConfig>): void {
  Object.assign(config, patch)
  gameInstance?.droneFly?.setConfig(patch)
}

function onConfigInput(key: 'maxAltitude' | 'maxDistance' | 'rthAltitude' | 'windSpeed' | 'windDirection' | 'lowBatteryPercent' | 'criticalBatteryPercent', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  applyConfig({ [key]: value } as Partial<SimConfig>)
}

function toggleFault(key: keyof FaultFlags): void {
  const next = !faults[key]
  faults[key] = next
  const patch: Partial<FaultFlags> = {}
  patch[key] = next
  gameInstance?.droneFly?.setFaults(patch)
}

// ————————————————————————————— 相机 / 云台 / 灯光 —————————————————————————————

function setCameraMode(mode: CameraMode): void {
  cameraMode.value = mode
  gameInstance?.droneFly?.setCameraMode(mode)
}

function cycleCamera(): void {
  const order: CameraMode[] = ['orbit', 'follow', 'fpv']
  setCameraMode(order[(order.indexOf(cameraMode.value) + 1) % order.length] ?? 'orbit')
}

function resetCamera(): void {
  gameInstance?.droneFly?.resetCamera()
  cameraMode.value = 'orbit'
}

function onGimbalInput(event: Event): void {
  gameInstance?.droneFly?.setGimbalPitch(Number((event.target as HTMLInputElement).value))
}

function onZoomInput(event: Event): void {
  sim()?.setZoom(Number((event.target as HTMLInputElement).value))
}

function centerGimbal(): void {
  gameInstance?.droneFly?.setGimbalPitch(-10)
}

function lookDown(): void {
  gameInstance?.droneFly?.setGimbalPitch(-90)
}

function lookLevel(): void {
  gameInstance?.droneFly?.setGimbalPitch(0)
}

function toggleRecording(): void {
  void (async () => {
    const fly = gameInstance?.droneFly
    if (!fly) return
    if (fly.isRecording) {
      const blob = await fly.stopRecording()
      // 落盘由 onRecordingReady 回调统一处理,这里只报失败
      if (!blob) recordNote.value = '录像为空,未保存'
      return
    }
    if (!fly.startRecording()) {
      recordNote.value = '当前环境不支持录像(需要 MediaRecorder)'
      return
    }
    recordNote.value = '录制中(云台取景)…停止后自动保存'
  })()
}

function takePhoto(): void {
  void (async () => {
    const fly = gameInstance?.droneFly
    if (!fly || photoBusy.value) return
    photoBusy.value = true
    // 快门闪一下,盖住拍照那一帧的取景切换
    shutterFlash.value = true
    window.setTimeout(() => {
      shutterFlash.value = false
    }, 260)
    const shot = await fly.requestPhoto()
    photoBusy.value = false
    if (!shot) {
      photoNote.value = '拍照失败:相机未就绪'
      return
    }
    lastPhoto.value = shot
    sim()?.takePhoto()
    const name = `DJI_Mini4Pro_photo_${timestampTag()}.png`
    downloadDataUrl(shot.dataUrl, name)
    photoNote.value = `已保存 ${name}(${shot.width}×${shot.height})`
  })()
}

/** 文件名时间戳 YYYYMMDD_HHMMSS */
function timestampTag(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('_')
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 录像成片由引擎回吐,界面负责落盘与提示 */
function attachRecordingSink(): void {
  const fly = gameInstance?.droneFly
  if (!fly || fly.onRecordingReady) return
  fly.onRecordingReady = (blob, seconds) => {
    const name = `DJI_Mini4Pro_video_${timestampTag()}.webm`
    downloadBlob(blob, name)
    if (lastRecording.value) URL.revokeObjectURL(lastRecording.value.url)
    lastRecording.value = { url: URL.createObjectURL(blob), name, size: blob.size }
    recordNote.value = `已保存 ${name}(${seconds.toFixed(1)}s · ${(blob.size / 1048576).toFixed(1)}MB)`
  }
}

function selectStatusPattern(key: StatusLightKey): void {
  lightAuto.value = false
  gameInstance?.droneFly?.setStatusLightPattern(key)
}

function enableAutoLights(): void {
  lightAuto.value = true
  gameInstance?.droneFly?.clearStatusLightOverride()
}

function selectBatteryMode(key: BatteryLightMode): void {
  gameInstance?.droneFly?.setBatteryLightMode(key)
}

function selectAuxMode(key: AuxLightMode): void {
  gameInstance?.droneFly?.setAuxLightMode(key)
}

function onBatteryLevelInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  lights.batteryLevel = value
  gameInstance?.droneFly?.setBatteryLightLevel(value)
}

function applyWorldVisibility(): void {
  gameInstance?.droneFly?.world?.setObstaclesVisible(showObstacles.value)
  gameInstance?.droneFly?.setMissionWaypointsVisible(showMissionWaypoints.value)
  gameInstance?.droneFly?.setMissionPathVisible(showMissionPath.value)
  gameInstance?.droneFly?.setRadarBeamsVisible(showRadarBeams.value)
  gameInstance?.droneFly?.setAuxBeamVisible(showAuxBeam.value)
  gameInstance?.setAxesVisible(showAxes.value)
}

/** 切换镜头瞄准:正前/正上(镜头转过去) vs 沿镜头面朝向 */
function setRadarAim(aim: RadarAim): void {
  gameInstance?.droneFly?.setRadarAim(aim)
  radar.value = { ...radar.value, aim }
}

function clearTrail(): void {
  gameInstance?.droneFly?.clearTrail()
}

// ————————————————————————————— 同步 —————————————————————————————

let syncTimer: number | undefined

function syncUi(): void {
  if (!gameInstance) return
  if (!ready.value && gameInstance.ready) {
    ready.value = true
    rigReport.value = gameInstance.droneFly?.getRigReport() ?? []
    applyWorldVisibility()
  }
  attachRecordingSink()
  const next = gameInstance.getSnapshot()
  if (next) snap.value = next
  const radarNext = gameInstance.droneFly?.getRadarSnapshot()
  if (radarNext) radar.value = radarNext
  const lightSnapshot = gameInstance.getDroneLightsSnapshot()
  if (lightSnapshot) Object.assign(lights, lightSnapshot)
  lightAuto.value = !gameInstance.droneFly?.statusLightOverride
  const editNext = gameInstance.droneFly?.getMissionEditState()
  if (editNext) {
    const current = sceneEdit.value
    if (
      current.enabled !== editNext.enabled ||
      current.active !== editNext.active ||
      current.selectedIndex !== editNext.selectedIndex ||
      current.hoverIndex !== editNext.hoverIndex ||
      current.dragging !== editNext.dragging ||
      current.mode !== editNext.mode
    ) {
      sceneEdit.value = editNext
    }
  }
  syncWaypointDraft()
  // 摇杆状态以仿真为准回读,保证面板与飞控看到的是同一份数据
  const actual = snap.value.stick
  if (Math.hypot(actual.throttle, actual.yaw, actual.pitch, actual.roll) < 0.001) {
    // 飞控侧已回中(例如重置):同步清掉界面残留
    if (Math.hypot(dialLeft.x, dialLeft.y, dialRight.x, dialRight.y) > 0.001 && !keyAxesActive()) {
      dialLeft.x = 0
      dialLeft.y = 0
      dialRight.x = 0
      dialRight.y = 0
    }
  }
}

function keyAxesActive(): boolean {
  return Math.hypot(keyAxes.throttle, keyAxes.yaw, keyAxes.pitch, keyAxes.roll) > 0.001
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', releaseAllInput)
  if (viewportRef.value) {
    gameInstance = new GameInstance(viewportRef.value)
    syncUi()
    syncTimer = window.setInterval(syncUi, 100)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('blur', releaseAllInput)
  if (syncTimer !== undefined) window.clearInterval(syncTimer)
  if (gameInstance) {
    gameInstance.destroy()
    gameInstance = null
  }
})
</script>

<style scoped lang="scss">
/* ═══════════════════════════ 基础 ═══════════════════════════ */
.sandbox {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 660px;
  overflow: hidden;
  color: #d8fff5;
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
.vignette {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(
    circle at 55% 45%,
    transparent 24%,
    rgb(2 9 12 / 14%) 68%,
    rgb(2 6 9 / 66%) 100%
  );
}
.loading {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 9;
  padding: 10px 16px;
  color: #9ff1dc;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 30%);
  border-radius: 5px;
  font:
    600 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
  transform: translate(-50%, -50%);
}

/* ═══════════════════════════ 面板外壳 ═══════════════════════════ */
.panel {
  position: absolute;
  top: 42px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  background: rgb(7 17 22 / 85%);
  border: 1px solid rgb(121 230 202 / 26%);
  border-radius: 6px;
  box-shadow: 0 14px 34px rgb(0 0 0 / 32%);
  backdrop-filter: blur(12px);
  pointer-events: auto;
}
.panel-left {
  left: 12px;
  width: 322px;
}
.panel-right {
  right: 12px;
  width: 344px;
}
.panel-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid rgb(121 230 202 / 16%);
  color: #9ff1dc;
  font:
    700 10px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.12em;
}
.panel-head small {
  color: #5e8b84;
  font-size: 8.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
}
.panel-body {
  flex: 1;
  min-height: 0;
  padding: 10px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgb(121 230 202 / 26%) transparent;
}
.panel-body::-webkit-scrollbar {
  width: 5px;
}
.panel-body::-webkit-scrollbar-thumb {
  background: rgb(121 230 202 / 24%);
  border-radius: 3px;
}

/* ═══════════════════════════ 分页 ═══════════════════════════ */
.tabs {
  display: grid;
  flex: none;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid rgb(121 230 202 / 14%);
}
.tabs button {
  padding: 5px 0;
  color: #9dc8c0;
  background: rgb(24 52 56 / 60%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 3px;
  font:
    600 10px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
}
.tabs button:hover {
  color: #eafff8;
  background: rgb(40 80 82 / 70%);
}
.tabs button.active {
  color: #04211d;
  background: #79e6ca;
  border-color: #b4ffeb;
}

/* ═══════════════════════════ 卡片 ═══════════════════════════ */
.card {
  margin-bottom: 9px;
  padding: 9px 10px;
  background: rgb(12 30 34 / 62%);
  border: 1px solid rgb(121 230 202 / 13%);
  border-radius: 4px;
}
.card:last-child {
  margin-bottom: 0;
}
.card.grow {
  display: flex;
  flex-direction: column;
}
.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: #9ff1dc;
  font:
    700 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.1em;
}
.card-title em {
  color: #629a90;
  font-size: 8.5px;
  font-style: normal;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.card-title em.bad {
  color: #ff8674;
}
.card-title em.warn {
  color: #ffc53d;
}
.card-title em.ok {
  color: #6ff0d0;
}
.muted {
  margin: 0;
  color: #567b76;
  font:
    500 9px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.fine-print {
  margin: 7px 0 0;
  color: #5b807b;
  font:
    400 8.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
/* ——— 拍照 / 录像 ——— */
.capture-panel {
  margin-top: 7px;
  padding: 6px 7px;
  background: rgb(10 26 30 / 72%);
  border: 1px solid rgb(121 230 202 / 16%);
  border-radius: 6px;
}
/* 自动下载可能被浏览器静默拦掉,留一条手动通道 */
.capture-download {
  display: inline-block;
  margin-top: 4px;
  text-decoration: underline;
  cursor: pointer;
}

.capture-note {
  margin: 0;
  color: #79e6ca;
  font:
    400 8.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  word-break: break-all;
}
.capture-thumb {
  display: block;
  width: 100%;
  max-height: 92px;
  margin-top: 6px;
  object-fit: cover;
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 4px;
}
.shutter-flash {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  background: radial-gradient(circle at 50% 45%, rgb(255 255 255 / 82%), rgb(255 255 255 / 24%));
  animation: shutterFade 260ms ease-out forwards;
}
@keyframes shutterFade {
  0% {
    opacity: 0.95;
  }
  100% {
    opacity: 0;
  }
}
.row-label {
  margin: 8px 0 5px;
  color: #6f9c95;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
}

/* ═══════════════════════════ 按钮 ═══════════════════════════ */
button {
  font-family: inherit;
}
.btn-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.btn-grid button,
.mini-btn {
  padding: 7px 4px;
  color: #cdeee6;
  background: rgb(28 60 63 / 78%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 4px;
  font:
    600 10px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.14s ease;
}
.btn-grid button:hover:not(:disabled),
.mini-btn:hover {
  color: #eafff8;
  background: rgb(44 88 90 / 85%);
  border-color: rgb(121 230 202 / 45%);
}
.btn-grid button:active:not(:disabled) {
  transform: scale(0.97);
}
.btn-grid button:disabled {
  color: #4d6f6c;
  background: rgb(16 36 39 / 60%);
  border-color: rgb(121 230 202 / 10%);
  cursor: not-allowed;
}
.btn-grid button.primary {
  color: #042b24;
  background: #79e6ca;
  border-color: #b4ffeb;
  font-weight: 700;
}
.btn-grid button.primary:disabled {
  color: #4d6f6c;
  background: rgb(16 36 39 / 60%);
  border-color: rgb(121 230 202 / 10%);
}
.btn-grid button.warn {
  color: #2c1b00;
  background: #ffc53d;
  border-color: #ffe08a;
}
.btn-grid button.danger {
  color: #ffd9d3;
  background: rgb(84 26 22 / 85%);
  border-color: rgb(255 122 106 / 45%);
}
.btn-grid button.danger:hover:not(:disabled) {
  color: #fff;
  background: rgb(122 35 28 / 92%);
}
.btn-grid button.danger:disabled {
  color: #6e4a46;
  background: rgb(34 20 19 / 60%);
  border-color: rgb(255 122 106 / 12%);
}
.btn-grid button.wide {
  grid-column: 1 / -1;
}
.block-hint {
  margin: 8px 0 0;
  padding: 5px 7px;
  color: #ffb3a6;
  background: rgb(84 26 22 / 55%);
  border: 1px solid rgb(255 122 106 / 30%);
  border-radius: 3px;
  font:
    600 8.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

/* ═══════════════════════════ 分段控件 ═══════════════════════════ */
.segmented {
  display: grid;
  gap: 4px;
}
.segmented.two {
  grid-template-columns: repeat(2, 1fr);
}
.segmented.three {
  grid-template-columns: repeat(3, 1fr);
}
.segmented.four {
  grid-template-columns: repeat(4, 1fr);
}
.segmented.five {
  grid-template-columns: repeat(5, 1fr);
}
.segmented button {
  padding: 5px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 62%);
  border: 1px solid rgb(121 230 202 / 20%);
  border-radius: 3px;
  font:
    600 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.14s ease;
}
.segmented button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 75%);
}
.segmented button.active {
  color: #04211d;
  background: #79e6ca;
  border-color: #b4ffeb;
}
.segmented button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ═══════════════════════════ 流程 / 徽标 ═══════════════════════════ */
.flow {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.flow-step {
  padding: 3px 6px;
  color: #5f8b85;
  background: rgb(16 36 39 / 70%);
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 3px;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.flow-step.done {
  color: #7fd3bd;
  border-color: rgb(121 230 202 / 26%);
}
.flow-step.active {
  color: #04211d;
  background: #79e6ca;
  border-color: #b4ffeb;
}
.flow-step.tail {
  background: #ffc53d;
  border-color: #ffe08a;
}
.badge {
  padding: 2px 6px;
  color: #7fb3aa;
  background: rgb(24 52 56 / 80%);
  border: 1px solid rgb(121 230 202 / 20%);
  border-radius: 3px;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  font-style: normal;
  letter-spacing: 0.05em;
}
.badge.on {
  color: #04211d;
  background: #79e6ca;
  border-color: #b4ffeb;
}
.badge.ok {
  color: #04211d;
  background: #79e6ca;
}
.badge.warn {
  color: #2c1b00;
  background: #ffc53d;
  border-color: #ffe08a;
}
.badge.bad {
  color: #fff;
  background: #d2402f;
  border-color: #ff8674;
}
.badge.rec {
  color: #fff;
  background: #d2402f;
  border-color: #ff8674;
  animation: recPulse 1.1s ease-in-out infinite;
}
@keyframes recPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
.next-step {
  margin: 0 0 2px;
  padding: 6px 8px;
  border-left: 2px solid rgb(121 230 202 / 40%);
  color: #a9d8cd;
  background: rgb(18 42 46 / 60%);
  font:
    500 9.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.next-step.ok {
  color: #a9f2dc;
  border-left-color: #6ff0d0;
}
.next-step.warn {
  color: #ffe0a3;
  border-left-color: #ffc53d;
  background: rgb(46 36 12 / 60%);
}
.next-step.error {
  color: #ffc0b4;
  border-left-color: #ff5b4a;
  background: rgb(58 20 16 / 65%);
}

/* ═══════════════════════════ 检查单 ═══════════════════════════ */
.checklist,
.part-list,
.fault-list,
.timeline,
.event-log {
  margin: 0;
  padding: 0;
  list-style: none;
}
.checklist li,
.part-list li {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px dashed rgb(121 230 202 / 10%);
}
.checklist li:last-child,
.part-list li:last-child {
  border-bottom: 0;
}
.checklist .dot,
.part-list .dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 1px;
  background: #6ff0d0;
  border-radius: 50%;
  box-shadow: 0 0 6px rgb(111 240 208 / 55%);
}
.checklist li.bad .dot,
.part-list li.missing .dot {
  background: #ff5b4a;
  box-shadow: 0 0 6px rgb(255 91 74 / 55%);
}
.checklist li > div,
.part-list li > div {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}
.checklist li strong,
.part-list li strong {
  color: #cdeee6;
  font:
    600 9.5px/1.25 ui-sans-serif,
    system-ui,
    sans-serif;
}
.checklist li span,
.part-list li span {
  overflow: hidden;
  color: #5e8b84;
  font:
    400 8.5px/1.35 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  flex: none;
  padding: 1px 5px;
  color: #ffb3a6;
  background: rgb(84 26 22 / 70%);
  border-radius: 2px;
  font:
    600 8px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.tag.ok {
  color: #6ff0d0;
  background: rgb(16 60 52 / 75%);
}
.tag.bad {
  color: #ffb3a6;
  background: rgb(84 26 22 / 70%);
}
.part-list li.drivable strong {
  color: #9ff1dc;
}

/* ═══════════════════════════ 警告 / 故障 ═══════════════════════════ */
.warn-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.warn-list span {
  padding: 3px 6px;
  color: #ffd9a8;
  background: rgb(58 44 12 / 72%);
  border: 1px solid rgb(255 197 61 / 30%);
  border-radius: 3px;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.minimap-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgb(121 230 202 / 12%);
}
.switch {
  display: flex;
  gap: 5px;
  align-items: center;
  color: #8fb8b0;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  cursor: pointer;
}
.switch input {
  width: 12px;
  height: 12px;
  accent-color: #79e6ca;
  cursor: pointer;
}
button.mini {
  padding: 4px 7px;
  color: #bfe8de;
  background: rgb(30 63 65 / 62%);
  border: 1px solid rgb(121 230 202 / 20%);
  border-radius: 3px;
  font:
    600 8.5px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
}
button.mini:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 78%);
}
.fault-list li {
  margin-bottom: 5px;
}
.switch-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  padding: 7px 8px;
  color: #cdeee6;
  background: rgb(22 46 50 / 70%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 4px;
  text-align: left;
  cursor: pointer;
  transition: 0.14s ease;
}
.switch-row:hover {
  border-color: rgb(121 230 202 / 40%);
}
.switch-row .knob {
  position: relative;
  flex: none;
  width: 26px;
  height: 14px;
  margin-top: 1px;
  background: rgb(9 22 26 / 90%);
  border: 1px solid rgb(121 230 202 / 26%);
  border-radius: 8px;
  transition: 0.16s ease;
}
.switch-row .knob::after {
  position: absolute;
  top: 1.5px;
  left: 1.5px;
  width: 9px;
  height: 9px;
  content: '';
  background: #6d948e;
  border-radius: 50%;
  transition: 0.16s ease;
}
.switch-row.on {
  border-color: rgb(255 197 61 / 55%);
  background: rgb(48 38 12 / 72%);
}
.switch-row.on .knob {
  background: rgb(255 197 61 / 25%);
  border-color: #ffc53d;
}
.switch-row.on .knob::after {
  left: 13px;
  background: #ffc53d;
}
.switch-row.danger {
  border-color: rgb(255 122 106 / 55%);
  background: rgb(58 22 18 / 72%);
}
.switch-row.danger .knob {
  background: rgb(255 91 74 / 25%);
  border-color: #ff8674;
}
.switch-row.danger .knob::after {
  background: #ff8674;
}
.switch-row > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.switch-row strong {
  font:
    600 9.5px/1.25 ui-sans-serif,
    system-ui,
    sans-serif;
}
.switch-row span {
  color: #6f9c95;
  font:
    400 8.5px/1.35 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.timeline li {
  padding: 6px 8px;
  margin-bottom: 5px;
  color: #7fa8a1;
  background: rgb(18 40 44 / 60%);
  border-left: 2px solid rgb(121 230 202 / 22%);
  font:
    400 9px/1.45 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.timeline li.armed {
  color: #ffdca3;
  background: rgb(50 38 14 / 72%);
  border-left-color: #ffc53d;
}

/* ═══════════════════════════ 滑块 ═══════════════════════════ */
.slider-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.slider-label {
  flex: none;
  width: 50px;
  color: #6f9c95;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.slider-row input[type='range'] {
  flex: 1;
  height: 3px;
  min-width: 0;
  accent-color: #79e6ca;
  cursor: pointer;
}
.slider-row input[type='range']:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.slider-row strong {
  min-width: 46px;
  color: #d8fff5;
  font:
    600 9.5px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-align: right;
}

/* ═══════════════════════════ 灯光 ═══════════════════════════ */
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.status-button {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 5px 6px;
  color: #bfe8de;
  background: rgb(30 63 65 / 62%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  text-align: left;
  cursor: pointer;
  transition: 0.15s ease;
}
.status-button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 72%);
}
.status-button.active {
  color: #04211d;
  background: #79e6ca;
  border-color: #b4ffeb;
}
.led-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 5px rgb(255 255 255 / 30%);
}
.pattern-meaning {
  margin: 7px 0 0;
  color: #7fb3a9;
  font:
    400 9px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.battery-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.battery-dot {
  width: 11px;
  height: 11px;
  background: rgb(121 230 202 / 10%);
  border: 1px solid rgb(121 230 202 / 28%);
  border-radius: 2px;
}
.battery-dot.on,
.battery-dot.blink {
  background: #9fffcb;
  border-color: #d9ffef;
  box-shadow: 0 0 7px rgb(159 255 203 / 60%);
}
.battery-dot.blink {
  animation: batteryBlink 0.48s step-end infinite;
}
@keyframes batteryBlink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.18;
  }
}
.battery-text {
  margin-left: auto;
  color: #7fb3a9;
  font:
    500 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.aux-status {
  margin: 7px 0 0;
  color: #7fb3a9;
  font:
    600 9.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.aux-status.lit {
  color: #ffe2a8;
  text-shadow: 0 0 8px rgb(255 226 168 / 45%);
}
.aux-hint {
  margin: 5px 0 0;
  color: #c9a15a;
  font:
    400 8.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

/* ═══════════════════════════ HUD ═══════════════════════════ */
.status-card {
  background: rgb(14 36 40 / 78%);
}
.status-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.status-line .phase {
  color: #eafff8;
  font:
    700 15px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  letter-spacing: 0.02em;
}
.status-line .chips {
  display: flex;
  gap: 4px;
}
.status-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  color: #6f9c95;
  font:
    500 8.5px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.status-sub.alt {
  margin-top: 4px;
  color: #ffcf8a;
}
.telemetry {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 6px;
}
.cell {
  min-width: 0;
}
.cell span {
  display: block;
  margin-bottom: 3px;
  overflow: hidden;
  color: #5e8b84;
  font:
    700 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell strong {
  color: #d8fff5;
  font:
    600 14px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.cell small {
  margin-left: 2px;
  color: #6f9c95;
  font-size: 8px;
  font-weight: 500;
}
.cell strong.up {
  color: #6ff0d0;
}
.cell strong.down {
  color: #ffb08a;
}
.coord-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 9px;
  padding-top: 7px;
  border-top: 1px solid rgb(121 230 202 / 12%);
  color: #5e8b84;
  font:
    500 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.instruments {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.instrument {
  min-width: 0;
}
.attitude {
  display: block;
  width: 100%;
  height: auto;
}
.battery-bar {
  height: 9px;
  overflow: hidden;
  background: rgb(9 22 26 / 90%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
}
.battery-bar span {
  display: block;
  height: 100%;
  transition:
    width 0.3s ease,
    background 0.3s ease;
}
.battery-meta {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px 8px;
  margin-top: 8px;
}
.battery-meta div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.battery-meta span {
  color: #5e8b84;
  font:
    700 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.05em;
}
.battery-meta strong {
  color: #d8fff5;
  font:
    600 10px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.signal-row {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-bottom: 5px;
}
.signal-label {
  flex: none;
  width: 54px;
  color: #5e8b84;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.bar {
  width: 5px;
  height: 12px;
  background: rgb(20 44 48 / 90%);
  border-radius: 1px;
}
.bar.on {
  background: #6ff0d0;
  box-shadow: 0 0 5px rgb(111 240 208 / 45%);
}
.obstacle-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgb(121 230 202 / 12%);
}

/* ───────────────────── 测距雷达 ───────────────────── */
.radar-block {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgb(121 230 202 / 12%);
}
.radar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #9fd8cc;
  font:
    600 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.radar-group {
  margin-top: 7px;
}
.radar-aim {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;

  .radar-aim-label {
    color: #5e8b84;
    font:
      700 8px/1.4 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: 0.08em;
  }

  button {
    padding: 3px 7px;
    color: #7fb6ab;
    background: rgb(18 40 44 / 70%);
    border: 1px solid rgb(121 230 202 / 18%);
    border-radius: 3px;
    cursor: pointer;
    font:
      600 9px/1.2 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }

  button.on {
    color: #0f1b1e;
    background: #6ff0d0;
    border-color: #6ff0d0;
  }
}
.radar-group-label {
  display: block;
  margin-bottom: 1px;
  color: #5e8b84;
  font:
    700 8px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.1em;
}
.radar-rays {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 4px;
}
.radar-ray {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 4px;
  background: rgb(18 40 44 / 70%);

  span {
    color: #5e8b84;
    font:
      700 8px/1.2 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: 0.08em;
  }

  strong {
    font:
      700 13px/1.3 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }

  em {
    font-style: normal;
    font-size: 9px;
    color: #5e8b84;
  }

  &.near {
    border-color: rgb(255 77 77 / 55%);
    strong {
      color: #ff6b6b;
    }
  }

  &.mid {
    border-color: rgb(255 193 77 / 45%);
    strong {
      color: #ffc14d;
    }
  }

  &.far {
    border-color: rgb(53 224 138 / 35%);
    strong {
      color: #35e08a;
    }
  }
}
/* 上视组远距用蓝色,与前视(绿)区分 */
.radar-group.up .radar-ray.far {
  border-color: rgb(77 195 255 / 35%);
}
.radar-group.up .radar-ray.far strong {
  color: #4dc3ff;
}
.obs-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  padding: 4px 1px;
  background: rgb(18 40 44 / 70%);
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 3px;
}
.obs-cell span {
  color: #5e8b84;
  font:
    700 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.obs-cell strong {
  color: #a9d8cd;
  font:
    600 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.obs-cell.near {
  background: rgb(58 38 12 / 78%);
  border-color: rgb(255 197 61 / 40%);
}
.obs-cell.near strong {
  color: #ffc53d;
}
.brake-flag {
  margin: 7px 0 0;
  padding: 4px 7px;
  color: #ffd9a8;
  background: rgb(58 44 12 / 72%);
  border-radius: 3px;
  font:
    600 9px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.event-log {
  display: flex;
  flex: 1;
  min-height: 90px;
  max-height: 210px;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.event-log li {
  display: flex;
  gap: 6px;
  padding: 3px 5px;
  color: #a9d8cd;
  background: rgb(16 36 39 / 55%);
  border-left: 2px solid rgb(121 230 202 / 30%);
  border-radius: 2px;
  font:
    500 8.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.event-log li .t {
  flex: none;
  color: #4f7570;
}
.event-log li.warn {
  color: #ffdca3;
  background: rgb(48 38 14 / 62%);
  border-left-color: #ffc53d;
}
.event-log li.error {
  color: #ffb3a6;
  background: rgb(52 20 16 / 62%);
  border-left-color: #ff5b4a;
}
.event-log li.success {
  color: #a9f2dc;
  border-left-color: #6ff0d0;
}
.event-log li.muted {
  color: #4f7570;
  background: transparent;
  border-left-color: transparent;
}

/* ═══════════════════════════ 摇杆台 ═══════════════════════════ */
.stick-deck {
  position: absolute;
  right: 368px;
  bottom: 12px;
  left: 346px;
  z-index: 5;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 20px;
  padding: 12px 14px;
  background: rgb(7 17 22 / 82%);
  border: 1px solid rgb(121 230 202 / 26%);
  border-radius: 6px;
  box-shadow: 0 14px 34px rgb(0 0 0 / 30%);
  backdrop-filter: blur(12px);
  pointer-events: auto;
}
.deck-center {
  display: flex;
  width: 218px;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 4px;
}
.deck-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #9ff1dc;
  font:
    700 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.1em;
}
.deck-title em {
  color: #629a90;
  font-size: 8.5px;
  font-style: normal;
}
.deck-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.deck-actions button {
  padding: 6px 0;
  color: #cdeee6;
  background: rgb(28 60 63 / 78%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 4px;
  font:
    600 10px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
}
.deck-actions button.danger {
  color: #ffd9d3;
  background: rgb(84 26 22 / 85%);
  border-color: rgb(255 122 106 / 45%);
}
.deck-actions button:disabled {
  color: #4d6f6c;
  background: rgb(16 36 39 / 60%);
  border-color: rgb(121 230 202 / 10%);
  cursor: not-allowed;
}
.keyhint {
  margin: 0;
  color: #4f7570;
  font:
    500 7.5px/1.6 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.02em;
  text-align: center;
}

/* ═══════════════════════════ 航线任务 ═══════════════════════════ */
.waypoint-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.waypoint-list {
  /* 航点再多也不能把整块面板撑长:超出就在列表内部滚(约 4 个航点的高度) */
  max-height: 340px;
  margin: 0;
  padding: 0 3px 0 0;
  overflow-x: hidden;
  overflow-y: auto;
  list-style: none;
  scrollbar-color: rgb(121 230 202 / 35%) transparent;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}
.waypoint-list::-webkit-scrollbar {
  width: 5px;
}
.waypoint-list::-webkit-scrollbar-track {
  background: transparent;
}
.waypoint-list::-webkit-scrollbar-thumb {
  background: rgb(121 230 202 / 30%);
  border-radius: 3px;
}
.waypoint-list::-webkit-scrollbar-thumb:hover {
  background: rgb(121 230 202 / 55%);
}
.waypoint-list li {
  margin-bottom: 6px;
  padding: 6px 7px;
  background: rgb(10 26 30 / 62%);
  border: 1px solid rgb(121 230 202 / 14%);
  border-radius: 4px;
  cursor: pointer;
}
.waypoint-list li:last-child {
  margin-bottom: 0;
}
.waypoint-list li:hover {
  border-color: rgb(121 230 202 / 34%);
}
.waypoint-list li.active {
  background: rgb(58 44 12 / 58%);
  border-color: rgb(255 197 61 / 45%);
}
/* 场景编辑选中的航点:与场景里那圈亮青色高亮同一个颜色 */
.waypoint-list li.selected {
  background: rgb(12 48 58 / 72%);
  border-color: rgb(158 244 255 / 62%);
  box-shadow: 0 0 0 1px rgb(158 244 255 / 22%);
}
.wp-head {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 5px;
}
.wp-index {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #04140f;
  background: #6ff0d0;
  border-radius: 50%;
  font:
    700 9px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.waypoint-list li.active .wp-index {
  background: #ffc53d;
}
.wp-coord {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #5e8b84;
  font:
    400 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wp-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
.wp-row:last-of-type {
  margin-bottom: 0;
}
.wp-field {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 3px;
  align-items: center;
  color: #6f9c95;
  font:
    600 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.wp-field input[type='checkbox'] {
  flex: none;
  width: 11px;
  height: 11px;
  accent-color: #79e6ca;
  cursor: pointer;
}
.wp-input,
.wp-select {
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: 3px 4px;
  color: #cdeee6;
  background: rgb(6 18 22 / 88%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    600 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.wp-input:focus,
.wp-select:focus {
  border-color: rgb(121 230 202 / 55%);
  outline: none;
}
.wp-input:disabled {
  color: #4d6f6b;
  cursor: not-allowed;
}
.wp-flag {
  display: inline-block;
  margin-top: 5px;
  padding: 1px 5px;
  color: #ffd9a8;
  background: rgb(84 58 12 / 78%);
  border-radius: 2px;
  font:
    600 8px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  font-style: normal;
}
/* 场景内编辑:手势说明与选中信息 */
.gesture-list {
  margin: 7px 0 0;
  padding: 0;
  list-style: none;
}
.gesture-list li {
  display: flex;
  gap: 7px;
  align-items: baseline;
  padding: 2px 0;
  color: #6f9c95;
  font:
    500 8.5px/1.45 ui-sans-serif,
    system-ui,
    sans-serif;
}
.gesture-list b {
  flex: none;
  min-width: 88px;
  color: #9ff1dc;
  font:
    700 8.5px/1.45 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.scene-edit-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 7px 0;
  padding: 5px 7px;
  color: #7fb3aa;
  background: rgb(8 22 26 / 66%);
  border: 1px dashed rgb(121 230 202 / 22%);
  border-radius: 4px;
  font:
    500 8.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.scene-edit-status b {
  color: #9ef4ff;
}
.scene-edit-status em {
  margin-left: auto;
  color: #ffc53d;
  font-style: normal;
}
.progress-head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  color: #9ff1dc;
  font:
    600 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.progress-head em {
  color: #6ff0d0;
  font:
    600 9px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  font-style: normal;
}
.progress-bar {
  height: 5px;
  margin: 5px 0 7px;
  overflow: hidden;
  background: rgb(8 24 28 / 85%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 3px;
}
.progress-bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #2f9d84, #6ff0d0);
  transition: width 120ms linear;
}
.mission-meta {
  display: grid;
  gap: 4px 8px;
  grid-template-columns: 1fr 1fr;
}
.mission-meta > div {
  display: flex;
  gap: 6px;
  align-items: baseline;
  justify-content: space-between;
  padding: 3px 6px;
  background: rgb(10 26 30 / 62%);
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 3px;
}
.mission-meta span {
  color: #5e8b84;
  font:
    400 8.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.mission-meta strong {
  color: #a9d8cd;
  font:
    600 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

@media (max-width: 1400px) {
  .panel-left {
    width: 296px;
  }
  .panel-right {
    width: 318px;
  }
  .stick-deck {
    right: 342px;
    left: 320px;
    gap: 14px;
  }
  .deck-center {
    width: 196px;
  }
}
</style>
