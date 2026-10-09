# 2024_tesla_model_3_rigged.glb — 节点契约

由 `2024_tesla_model_3__interior.glb`（B 模型）经 Blender 无头改装生成。
用途：灯光独立控制、四门独立开合、四轮独立转动、前轮转向、后视镜开合。

- 三角面 146,739 · 7.71 MB（源 167,747 / 11.02 MB）
- 坐标：glTF 标准 Y-up，**前 = +Z**，左 = +X，地面 y = 0
  - 判据（在 GLB 里量出的世界系包围盒，不是凭惯例假设）：大灯 `LIGHT_HEAD_FL/FR_GEO` 中心 z = **+1.62**、尾灯 `LIGHT_TAIL_RL/RR_GEO` 中心 z = **−2.12**、前轮 `WHEEL_FL_GEO` 中心 z = +1.46、后轮 `WHEEL_RL_GEO` 中心 z = −1.41、左后视镜 `MIRROR_FL_GEO` 在 x = +0.87~1.02。
  - 注意：**不是** glTF「前 = −Z」的常见约定。本资产车头朝 +Z。
- 尺寸：宽 2.088 m × 高 1.444 m × 长 4.719 m（真车 1:1）
- 已删除：`DAMAGE_GLASS`（碎裂玻璃变体，默认叠在车顶）、`Rim_Blur_Spoke*`（行驶模糊假轮毂）

## 层级

```
CAR_ROOT
├─ BODY
│  ├─ BODY_GEO                         车身（含侧围骨架/顶棚/内饰非门件）
│  ├─ CALIPER_RL_GEO / CALIPER_RR_GEO  后轮卡钳（不转向不自转）
│  ├─ LIGHT_HEAD_FL_GEO / _FR          大灯（左右独立）
│  ├─ LIGHT_TAIL_RL_GEO / _RR          尾灯（左右独立）
│  └─ LIGHT_AMBIENT_GEO                环境灯带
├─ DOOR_FL  @ (0.80, 0.65, 0.92)   ← glTF 空间铰链
│  ├─ DOOR_FL_GEO                      门皮+玻璃+门卡+密封条+把手+LED
│  └─ MIRROR_FL  @ 门内
│     └─ MIRROR_FL_GEO                 后视镜总成
├─ DOOR_FR / MIRROR_FR                 右前（镜像）
├─ DOOR_RL / DOOR_RR                   后门（无镜）
├─ STEER_FL @ 前轮心
│  ├─ CALIPER_FL_GEO                   前卡钳（随转向、不随滚动）
│  └─ WHEEL_FL @ 前轮心
│     └─ WHEEL_FL_GEO                  轮胎+轮毂+刹车盘
├─ STEER_FR / WHEEL_FR
├─ WHEEL_RL                            后轮（无转向节点）
└─ WHEEL_RR
```

## 动画轴（three.js 中直接 rotate 节点）

| 节点 | 轴 | 正方向含义 | 参考行程 |
|---|---|---|---|
| `DOOR_FL` / `DOOR_RL` | local Y (up) | 负角 = 开门 | 0 → −58° 全开 |
| `DOOR_FR` / `DOOR_RR` | local Y (up) | 正角 = 开门 | 0 → +58° 全开 |
| `MIRROR_FL` | local Y | 负角 = 折叠（向后收） | 0 → −78° 全折 |
| `MIRROR_FR` | local Y | 正角 = 折叠 | 0 → +78° 全折 |
| `STEER_FL` / `STEER_FR` | local Y | ± 转向 | ±26° 明显可见 |
| `WHEEL_*` | local X | 滚动 | 任意，累加 |

要点：门、镜、转向节点的局部 Y 即世界竖直轴（节点无自身旋转），X 即轮轴横向。

> ⚠ **朝向比世界约定差 180°**：本资产车头朝 +Z，而项目世界约定是「航向 0° = 北 = −Z」
> （无人机模型即如此：云台镜头 z = −7.77）。渲染层在装载时用
> `CAR_ASSET_FACE_YAW_DEG = 180` 一次性摆正（`packages/three-adapter/src/car-view.ts`），
> 对账测试 `apps/drone-simulator/src/__tests__/vehicle-model-axis.spec.ts`。
> 漏掉这一下的症状：车身「倒着开」、四轮滚动方向反向、上坡显示成下坡、右侧压坡显示成左侧压坡
> —— 四处同一个根因，别在别处逐个补号。
> 门/镜/转向都是绕 local Y 的旋转，与父级的 Y 旋转可交换，本身**不需要**补偿。

## 灯光

每盏灯是独立 mesh + **按角复制的独立材质**（如 `Lights_HEAD_FL` / `Lights_HEAD_FR`），
点亮 = 把该角材质的 `emissiveFactor` 与 `emissiveTexture` 打开（three.js 里改 `material.emissive` / `emissiveIntensity`）。

| 材质前缀 | 位置 |
|---|---|
| `Lights_*_HEAD_FL/_FR`、`Lights_Glo_*`、`Lights_Ref_*`、`EXT_Headlight_Glass_*` | 大灯（近光/日行灯/反光碗/灯罩） |
| `Lights_*_TAIL_RL/_RR`、`EXT_Taillight_Glass_*`、`Taillight_Detail_*` | 尾灯 |
| `Lights_AMBIENT`、`Taillight_Detail_AMBIENT` | 车内环境灯带 |
| `INT_LED`（在门上，随门动） | 门内氛围灯 |

注意：`EXT_Headlight_Glass` 名字里**不含** `Lights`，按材质名过滤时要用 `light`（小写、子串）匹配。

## 再生成

改装脚本（Blender 5.2 无头，可重复执行）：
`C:\Users\11746\WorkBuddy\2026-09-28-15-34-02\model-compare\rig_tesla.py`

```bash
D:/software/blender/blender.exe -b --factory-startup -P rig_tesla.py
```

分类逻辑：材质+连通块原子化（9133 块）→ 按包围盒规则归组，不做几何切割（门缝线本就是模型真实几何间隙）。

## v2 修订（firstapp 项目，2026-10-09）

初版分组留了三处"该随门动却留在 BODY"的贯通件，开门时会横在门洞上不动：

1. **贯通侧窗玻璃** `EXT_Window` / `INT_Window`（z 跨 3.276 m，与门上玻璃双层重叠）
2. **窗框黑条** `ext_carpaint_black` 的贯通段（A→C 柱，z 跨 2.44 m）
3. **氛围灯带** `INT_LED`（nodes.md 说"在门上随门动"，实际整条留在 BODY）

v2 处理：从 `BODY_GEO` 把门洞区域的面（材质 ∈ 上述三类、|x| > 0.5、高度 > 0.75、
车长向 z ∈ (−1.35, 0.75]、B 柱段 (−0.45, −0.30] 除外）拆出 1566 面，按门缝分成
四组挂到 `DOOR_FL/FR/RL/RR` 下，新节点 `WIN_DOOR_FL/FR/RL/RR`（变换与 `DOOR_*_GEO`
同构：T = 门铰链的相反数）。保留在车身的：A 柱段（z > 0.75）、B 柱段、后固定小窗（z ≤ −1.35）。

三角面从 146,739 → 162,046（Blender 往返导出的重三角化差异，几何无位移）。
