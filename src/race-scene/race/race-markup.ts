/**
 * 海湾竞速场景的 DOM 骨架。
 *
 * 原样迁移自上游 `race.html` 的 `<body>`,改动只有三处:
 * 1. 外层从 `<body class="race-page">` 收成容器 class(见 race-viewer.vue),避免 SPA 里污染全局样式;
 * 2. 无人机面板补上接管/起飞/降落/返航按钮;
 * 3. 新增接管飞行时的读数 HUD 与按键提示。
 *
 * 场景脚本靠 id 查找这些元素,改名必须同步改 main.ts。
 */
/** 场景 DOM 骨架字符串;race-viewer.vue 把它赋给容器 innerHTML 后再调 mountRace 挂载。 */
export const RACE_MARKUP = `
<div id='race-app'>
  <div id='race-viewport' aria-label='桥面驾驶场景'></div>
  <div class='race-hud'>
    <div class='race-hud-row'><span>速度</span><strong id='hud-speed'>0 km/h</strong></div>
    <div class='race-hud-row'><span>帧率</span><strong id='hud-fps'>--</strong></div>
    <div class='race-hud-row'><span>前轮转角</span><strong id='hud-steer'>0°</strong></div>
    <div class='race-hud-row'><span>里程</span><strong id='hud-distance'>0 m</strong></div>
    <div class='race-hud-row'><span>过弯辅助</span><strong id='hud-assist'>--</strong></div>
    <div class='race-hud-row'><span>车灯</span><strong id='hud-lights'>--</strong></div>
    <div class='race-hud-row'><span>时段</span><strong id='hud-time'>白天</strong></div>
    <div class='race-hud-row'><span>自动驾驶</span><strong id='hud-auto'>--</strong></div>
    <div class='race-hud-note' id='hud-map'>载入地图…</div>
    <div class='race-hud-note' id='hud-wheels'>正在载入车辆…</div>
  </div>

  <div id='race-drone-hud' class='race-drone-hud' hidden>
    <div class='race-drone-hud-head'><span>无人机 · 已接管</span><b id='drone-hud-phase'>—</b></div>
    <div class='race-drone-hud-row'><span>高度</span><strong id='drone-hud-altitude'>—</strong></div>
    <div class='race-drone-hud-row'><span>水平速度</span><strong id='drone-hud-speed'>—</strong></div>
    <div class='race-drone-hud-row'><span>电量</span><strong id='drone-hud-battery'>—</strong></div>
    <div class='race-drone-hud-row'><span>机头</span><strong id='drone-hud-heading'>—</strong></div>
    <div class='race-drone-hud-row'><span>姿态</span><strong id='drone-hud-attitude'>—</strong></div>
    <div class='race-drone-hud-row'><span>定位</span><strong id='drone-hud-home'>—</strong></div>
    <div id='drone-hud-warning' class='race-drone-hud-warning' hidden></div>
    <div class='race-drone-hud-stick'>
      <div class='race-stick'><span class='race-stick-bar'><i id='drone-hud-stick-throttle'></i></span><em>升降</em></div>
      <div class='race-stick'><span class='race-stick-bar'><i id='drone-hud-stick-yaw'></i></span><em>偏航</em></div>
      <div class='race-stick'><span class='race-stick-bar'><i id='drone-hud-stick-pitch'></i></span><em>前后</em></div>
      <div class='race-stick'><span class='race-stick-bar'><i id='drone-hud-stick-roll'></i></span><em>横滚</em></div>
      <div class='race-stick-cam'>云台 <b id='drone-hud-gimbal'>—</b></div>
    </div>
    <div class='race-drone-hud-keys'>
      <b>W / S</b> 前后　<b>A / D</b> 左右转　<b>Z / X</b> 升降　<b>Q / E</b> 偏航（<b>↑↓←→</b> 同义）<br />
      <b>I / K</b> 前后　<b>J / L</b> 左右平移　<b>T / F</b> 云台俯仰<br />
      <b>M</b> 跟拍 / 机载　<b>V</b> 起飞·降落　<b>B</b> 返航　<b>U</b> 交还（键盘还给汽车）
    </div>
  </div>

  <div class='race-tools'>
    <button id='race-tree-toggle' class='race-settings' aria-controls='race-tree' aria-expanded='false'>模型树</button>
    <button id='race-settings' class='race-settings' aria-controls='race-panel' aria-expanded='false'>设置</button>
  </div>
  <section id='race-tree' class='race-tree' hidden aria-label='车辆模型树'>
    <div class='race-panel-head'>
      <h1>模型树<span id='race-tree-count' class='race-tree-count'></span></h1>
      <button id='race-tree-close' aria-label='关闭模型树'>×</button>
    </div>
    <input id='race-tree-search' class='race-tree-search' type='search' placeholder='筛选名字，例如 Door / WingMirror / glass' />
    <div id='race-tree-host'></div>
    <p class='race-tree-hint'>点树里的节点＝在场景里框出它；点场景里的部件＝树会自动展开到它。</p>
  </section>
  <section id='race-panel' class='race-panel' hidden aria-label='驾驶场景设置'>
    <div class='race-panel-head'>
      <h1>驾驶设置</h1>
      <button id='race-close' aria-label='关闭设置'>×</button>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>车辆<span class='race-panel-note'>（切换会重新载入模型）</span></span>
      <div class='race-panel-row' id='race-car-row'></div>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>地图</span>
      <div class='race-panel-row'>
        <button type='button' data-map='bridge'>海湾大桥 · 单程</button>
        <button type='button' data-map='circuit'>海湾环线 · 计时圈</button>
        <button type='button' data-map='endless'>无尽技术赛道</button>
      </div>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>大疆无人机<span class='race-panel-note'>（可操控）</span></span>
      <label class='race-panel-check'><input id='race-drone' type='checkbox' checked /> 显示无人机</label>
      <span id='race-drone-status' class='race-panel-note' role='status'>正在载入无人机…</span>
      <button id='race-drone-pilot' class='race-panel-wide race-drone-pilot' type='button' disabled>接管操控</button>
      <div class='race-panel-row'>
        <button id='race-drone-takeoff' type='button' disabled>起飞</button>
        <button id='race-drone-land' type='button' disabled>降落</button>
        <button id='race-drone-rth' type='button' disabled>返航</button>
      </div>
      <button id='race-drone-focus' class='race-panel-wide' type='button' disabled>查看无人机</button>
      <span class='race-panel-label'>镜头<span class='race-panel-note'>（与操控解耦：开着车也能切机载）</span></span>
      <div class='race-panel-row'>
        <button id='race-drone-cam-car' type='button'>车辆视角</button>
        <button id='race-drone-cam-drone' type='button'>跟拍</button>
        <button id='race-drone-cam-fpv' type='button'>机载视角</button>
      </div>
      <span class='race-panel-note'>按 <b>U</b>（或上面的按钮）接管操控。<b>接管期间键盘整体交给无人机</b>：<b>W / S</b> 前后、<b>A / D</b> 左右转、<b>Z / X</b> 升降、<b>Q / E</b> 偏航（<b>↑↓←→</b> 与 W/S/A/D 同义；<b>I / K</b> 前后、<b>J / L</b> 平移也照旧可用），详见左下角读数卡（带摇杆量指示）。再按 <b>U</b> 交还，键盘立刻还给汽车。车在接管期间<b>不会被暂停</b>（自动驾驶与滑行照旧），只是不吃键盘。<b>T / F</b> 云台俯仰、<b>M</b> 跟拍 / 机载、<b>V</b> 起飞·降落、<b>B</b> 返航、<b>C</b> 回车辆视角。</span>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>赛道种子<span class='race-panel-note'>（仅无尽赛道）</span></span>
      <div class='race-panel-row'>
        <input id='race-seed' type='number' min='1' step='1' value='1' />
        <button id='race-seed-apply' type='button'>换一条</button>
      </div>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>开关</span>
      <label class='race-panel-check'><input id='race-assist' type='checkbox' checked /> 过弯辅助（自动收油）</label>
      <label class='race-panel-check'><input id='race-reflection' type='checkbox' checked /> 水面倒影</label>
      <label class='race-panel-check'><input id='race-auto' type='checkbox' /> 自动驾驶（沿赛道行驶，按 G 切换）</label>
      <label class='race-panel-check'><input id='race-headlights' type='checkbox' checked /> 前大灯（日行灯，夜间自动更亮）</label>
      <label class='race-panel-check'><input id='race-hazards' type='checkbox' /> 双闪（前后转向灯同时闪）</label>
      <label class='race-panel-check'><input id='race-mirror-reflection' type='checkbox' /> 后视镜镜面反射</label>
      <label class='race-panel-check'><input id='race-bloom' type='checkbox' checked /> 泛光（Bloom，仅夜间灯效）</label>
      <label class='race-panel-check race-panel-range'>泛光强度
        <input id='race-bloom-strength' type='range' min='0' max='2' step='0.05' value='0.55' />
        <b id='race-bloom-value'>0.55</b>
      </label>
      <label class='race-panel-check race-panel-range'>选中辉光
        <input id='race-glow-strength' type='range' min='0' max='2' step='0.05' value='0.6' />
        <b id='race-glow-value'>0.60</b>
      </label>
      <label class='race-panel-check race-panel-range'>夜间亮度
        <input id='race-night-brightness' type='range' min='0.3' max='1.5' step='0.05' value='1' />
        <b id='race-night-brightness-value'>1.00</b>
      </label>
      <button id='race-time' type='button' class='race-panel-wide'>切到黑夜</button>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>天气</span>
      <label class='race-panel-check'><input id='race-rain' type='checkbox' /> 雨天（雨丝、湿路与水花）</label>
      <label class='race-panel-check race-panel-range'>雨量
        <input id='race-rain-strength' type='range' min='0' max='1' step='0.05' value='0.65' />
        <b id='race-rain-value'>0.65</b>
      </label>
      <label class='race-panel-check race-panel-range'>涟漪密度
        <input id='race-rain-density' type='range' min='0' max='2' step='0.05' value='1' />
        <b id='race-rain-density-value'>1.00</b>
      </label>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>车身</span>
      <label class='race-panel-check'><input id='race-windows' type='checkbox' /> 车窗降下</label>
      <label class='race-panel-check'><input id='race-mirrors' type='checkbox' /> 后视镜收起</label>
      <label class='race-panel-check'><input id='race-sunroof' type='checkbox' /> 天窗打开</label>
      <span class='race-panel-label'>上车<span class='race-panel-note'>（司机从左侧上车，会自己开门、坐下、关门）</span></span>
      <button id='race-board' class='race-panel-wide' type='button'>播放上车动作</button>
      <span class='race-panel-label'>车门<span class='race-panel-note'>（每一扇单独开关）</span></span>
      <div class='race-panel-doors'>
        <label class='race-panel-check'><input id='race-door-fl' type='checkbox' /> 前左</label>
        <label class='race-panel-check'><input id='race-door-fr' type='checkbox' /> 前右</label>
        <label class='race-panel-check'><input id='race-door-rl' type='checkbox' /> 后左</label>
        <label class='race-panel-check'><input id='race-door-rr' type='checkbox' /> 后右</label>
      </div>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>水面</span>
      <label class='race-panel-check race-panel-range'>水流
        <input id='race-wind' type='range' min='-1' max='4' step='0.05' value='0.35' />
        <b id='race-wind-value'>0.35</b>
      </label>
      <label class='race-panel-check race-panel-range'>波纹大小
        <input id='race-ripple' type='range' min='0.4' max='2.5' step='0.05' value='1' />
        <b id='race-ripple-value'>1.00</b>
      </label>
      <label class='race-panel-check race-panel-range'>波浪
        <input id='race-wave' type='range' min='0' max='1' step='0.05' value='0.45' />
        <b id='race-wave-value'>0.45</b>
      </label>
    </div>
    <div class='race-panel-block'>
      <span class='race-panel-label'>操作</span>
      <ul class='race-panel-keys'>
        <li><b>W / ↑</b> 加速　<b>S / ↓</b> 刹车与倒车</li>
        <li><b>A D / ← →</b> 转向　<b>R</b> 复位　<b>P</b> 暂停</li>
        <li><b>拖动鼠标</b> 自由视角（右键平移 / 滚轮缩放）　<b>C</b> 回追尾视角</li>
        <li><b>G</b> 自动驾驶　<b>H</b> 双闪　<b>N</b> 白天 / 黑夜　<b>Y</b> 雨天</li>
        <li><b>U</b> 接管 / 交还无人机（接管期间键盘交给飞机，车不吃键盘但照常滑行）</li>
        <li><b>V</b> 起飞 / 降落　<b>B</b> 返航（接管无人机后生效）</li>
      </ul>
    </div>
    <p class='race-panel-foot'>这些开关也会写进地址栏，可以直接分享链接。</p>
  </section>
  <div id='race-pick' class='race-pick' hidden></div>
  <div class='race-hint'>W / ↑ 加速　S / ↓ 刹车与倒车　A D / ← → 转向　R 复位　P 暂停　拖动鼠标 自由视角　右上角"设置"切换地图与开关　<b>G</b> 自动驾驶　<b>Y</b> 雨天　<b>U</b> 操控无人机（接管期间键盘交给飞机，W/S/A/D 也能飞）</div>
  <div id='race-drone-toast' class='race-drone-toast' hidden></div>
  <div id='race-status' class='race-status'>载入车辆模型 0%</div>
</div>
`
