# DJI Mini 4 Pro 模型 ID 与名称对应表

`ID` 直接使用 Blender / GLB 的对象名，可在 Three.js 中通过 `scene.getObjectByName(ID)` 获取。没有额外依赖数字索引；数字索引可能随导入器或导出顺序变化。

## 运动部件

| ID | 类型 | 中文名称 | 控制器 |
|---|---|---|---|
| `ARM_FrontLeft` | MESH | 前左机臂、电机座 | `CTRL_Arm_FrontLeft_Fold` |
| `ARM_FrontRight` | MESH | 前右机臂、电机座 | `CTRL_Arm_FrontRight_Fold` |
| `ARM_RearLeft` | MESH | 后左机臂、电机座 | `CTRL_Arm_RearLeft_Fold` |
| `ARM_RearRight` | MESH | 后右机臂、电机座 | `CTRL_Arm_RearRight_Fold` |
| `ROTOR_FrontLeft` | MESH | 前左转子桨毂（钟罩与桨叶的父节点） | `CTRL_Prop_FrontLeft_Spin` |
| `ROTOR_FrontRight` | MESH | 前右转子桨毂 | `CTRL_Prop_FrontRight_Spin` |
| `ROTOR_RearLeft` | MESH | 后左转子桨毂 | `CTRL_Prop_RearLeft_Spin` |
| `ROTOR_RearRight` | MESH | 后右转子桨毂 | `CTRL_Prop_RearRight_Spin` |
| `MOTOR_FrontLeft_RotorBell` | MESH | 前左磁钢钟罩（外转子壳） | 随 `ROTOR_FrontLeft` 旋转 |
| `MOTOR_FrontRight_RotorBell` | MESH | 前右磁钢钟罩 | 随 `ROTOR_FrontRight` 旋转 |
| `MOTOR_RearLeft_RotorBell` | MESH | 后左磁钢钟罩 | 随 `ROTOR_RearLeft` 旋转 |
| `MOTOR_RearRight_RotorBell` | MESH | 后右磁钢钟罩 | 随 `ROTOR_RearRight` 旋转 |
| `PROP_FrontLeft_Blade_1` | MESH | 前左桨叶 1 | `CTRL_Prop_FrontLeft_Spin` |
| `PROP_FrontLeft_Blade_2` | MESH | 前左桨叶 2 | `CTRL_Prop_FrontLeft_Spin` |
| `PROP_FrontRight_Blade_1` | MESH | 前右桨叶 1 | `CTRL_Prop_FrontRight_Spin` |
| `PROP_FrontRight_Blade_2` | MESH | 前右桨叶 2 | `CTRL_Prop_FrontRight_Spin` |
| `PROP_RearLeft_Blade_1` | MESH | 后左桨叶 1 | `CTRL_Prop_RearLeft_Spin` |
| `PROP_RearLeft_Blade_2` | MESH | 后左桨叶 2 | `CTRL_Prop_RearLeft_Spin` |
| `PROP_RearRight_Blade_1` | MESH | 后右桨叶 1 | `CTRL_Prop_RearRight_Spin` |
| `PROP_RearRight_Blade_2` | MESH | 后右桨叶 2 | `CTRL_Prop_RearRight_Spin` |
| `GEAR_FrontLeft_LandingLeg` | MESH | 前左脚撑 | `CTRL_Gear_FrontLeft_Fold` |
| `GEAR_FrontRight_LandingLeg` | MESH | 前右脚撑 | `CTRL_Gear_FrontRight_Fold` |

后起落架在原始 GLB 中没有可识别的独立网格，因此没有 `GEAR_Rear*` 网格对象。

自转链路为三级：`CTRL_Prop_<位置>_Spin`（自转控制器）→ `ROTOR_<位置>`（转子桨毂）→ `MOTOR_<位置>_RotorBell`（磁钢钟罩）与两片 `PROP_<位置>_Blade_1/2`。电机的固定电机座、定子和线圈属于 `ARM_<位置>`，自转时保持不动；折叠机臂时整个电机和桨叶跟随机臂。

> **Three.js 沙盒渲染约定**：钟罩 `MOTOR_<位置>_RotorBell` 是电机的固定外壳，**不随转子自转**。`DroneRig` 载入时用 `Object3D.attach` 把它从自转子树移到自转控制器的父级（世界变换保持不变），因此它只跟随机臂折叠、不参与自转；自转的只有 `ROTOR_<位置>` 桨毂与两片桨叶。若模型日后把钟罩直接挂在机臂下，这段摘出逻辑会自动跳过。
>
> **桨叶几何不做任何补烘**：出厂 GLB 已自洽——桨毂与钟罩的几何轴和自转节点局部 Y 同轴（偏差 <1.5°），桨叶自带 ~15° 桨距（攻角烘在顶点里，前左/后右 ≈ +15°，前右/后左 ≈ −15°）。自转方向据此推得：前左/后右俯视顺时针、前右/后左俯视逆时针，与桨距配对产生向上拉力。
>
> **叠桨与收纳（与真机一致）**：收纳时两片桨叶各自绕电机轴偏航叠拢、叠在一起；机臂完全展开后桨叶再以慢节奏缓缓转开复位（`DroneRig.updateBlades`）。叠拢角由几何实测（桨叶径向 → 机臂方向）作基准，再**整圈扫描**整体偏角，取对实体场（`BODY_/ARM_/MOTOR_` 折叠态逐格竖直区间，桨叶从实体**下方掠过不算侵入**）侵入最小、平手取"桨叶方向最贴近机身纵轴"的角度 —— 当前四桨全部零侵入零抬升（`foldLift = 0`，桨毂稳坐电机钟罩内；仅当几何上求不出零侵入时才以残余侵入量抬升转子兜底）。先后定姿的桨叶顶点写入避障场，后续桨扫描时避开，防桨叶互穿。两片桨叶叠拢时沿电机轴错开 12mm 层差，避免完全重合。
>
> ⚠️ **扫描环境必须与实况一致**：高度场/实体场必须在**机臂已折叠**的状态下构建 —— 展开态建场会漏掉折叠臂/电机扫过机身两侧的表面，桨叶会从其下方"幽灵穿越"。
>
> **停放配平（Stance Trim，随折叠状态过渡）**：**展开态**——模型出厂只有前脚撑（`GEAR_*_LandingLeg`）接地，机尾底部比前脚撑高 ~14° 对应的高度，机身平放会"一端着地一端悬空"。`DroneRig` 载入时实测前脚撑与机尾底部（`BODY_*` 网格机尾区域）两个触地带，解出让它们同时落地的抬头角（当前 ~13.6°），叠加在整机俯仰上并整体下沉贴地。该配平是刚体属性，悬停时同样生效——恰好抵消电机轴的前倾分量，使前桨盘接近水平（剩 ~6° 外倾）；后桨保留 ~12° 外倾（后机臂上反角，与实机一致）。**收纳态**——脚撑随机臂翻起不再接地，机身平贴地面（俯仰 0），下沉量 = 机身系（`BODY_/ARM_/MOTOR_`）最低点深度，脚撑藏在地面之下与真机收纳后平放一致。两态随折叠度线性过渡。云台增稳补偿包含当前配平角，画面地平线不受影响。

## 机身、云台、传感器与灯珠网格

| ID | 类型 | 中文名称 |
|---|---|---|
| `BODY_Main_Fuselage` | MESH | 机身主体与静态细节 |
| `BODY_Black_Underside_SensorHousing` | MESH | 黑色下壳与传感器壳体 |
| `GIMBAL_CameraHousing` | MESH | 云台相机壳体 |
| `GIMBAL_CameraLensFrame` | MESH | 云台镜头框 |
| `GIMBAL_Camera_SideRing_Right` | MESH | 云台相机右侧环形细节 |
| `SENSOR_Glass_GimbalLens` | MESH | 云台主镜片 |
| `SENSOR_Glass_Front_Left` | MESH | 前向视觉玻璃（左） |
| `SENSOR_Glass_Front_Right` | MESH | 前向视觉玻璃（右） |
| `SENSOR_Glass_Side_Left` | MESH | 侧向视觉玻璃（左） |
| `SENSOR_Glass_Side_Right` | MESH | 侧向视觉玻璃（右） |
| `SENSOR_Glass_Downward` | MESH | 下视传感器玻璃 |
| `SENSOR_FrontHousing_Left` | MESH | 前向视觉传感器壳体（左） |
| `SENSOR_FrontHousing_Right` | MESH | 前向视觉传感器壳体（右） |
| `LED_Status_Tail_Left` | MESH | 尾部状态灯网格（左） |
| `LED_Status_Tail_Right` | MESH | 尾部状态灯网格（右） |
| `LED_BatteryCharge_01` | MESH | 机背电池充电/电量指示灯珠 1（左） |
| `LED_BatteryCharge_02` | MESH | 机背电池充电/电量指示灯珠 2 |
| `LED_BatteryCharge_03` | MESH | 机背电池充电/电量指示灯珠 3 |
| `LED_BatteryCharge_04` | MESH | 机背电池充电/电量指示灯珠 4（右） |
| `BUTTON_Power` | MESH | 机背电池开机按钮 |
| `DECAL_Text_Labels` | MESH | 文字与贴花 |

## 动画控制器

| ID | 中文名称 | 作用 |
|---|---|---|
| `CTRL_DJI_Root` | 整机总控 | 平移、旋转、缩放整机 |
| `CTRL_Gimbal_Yaw` | 云台偏航 | 绕 Z 轴控制 |
| `CTRL_Gimbal_Pitch` | 云台俯仰 | 绕 X 轴控制 |
| `CTRL_Gimbal_Roll` | 云台横滚 | 绕 Y 轴控制 |
| `CTRL_Arm_<位置>_Fold` | 机臂折叠 | 对应机臂及其桨叶、前脚撑 |
| `CTRL_Prop_<位置>_Spin` | 转子自转（带动钟罩与桨叶） | Blender 局部 Z；本版 GLB 在 Three.js 中为局部 Y |
| `CTRL_Gear_<位置>_Fold` | 起落架折叠 | 前脚撑可直接驱动；后脚为占位 |

具体位置值为 `FrontLeft`、`FrontRight`、`RearLeft`、`RearRight`。

## 灯光对象

| ID | 类型 | 中文名称 |
|---|---|---|
| `LIGHT_StatusLED_Left` | LIGHT | 左尾部 Remote ID / 状态灯，默认红色 |
| `LIGHT_StatusLED_Right` | LIGHT | 右尾部 Remote ID / 状态灯，默认绿色 |
| `LIGHT_BottomAssist` | LIGHT | 底部辅助照明灯 |
| `LIGHT_BatteryLED_01` | LIGHT | 电池电量灯 1 |
| `LIGHT_BatteryLED_02` | LIGHT | 电池电量灯 2 |
| `LIGHT_BatteryLED_03` | LIGHT | 电池电量灯 3 |
| `LIGHT_BatteryLED_04` | LIGHT | 电池电量灯 4 |

所有灯光对象的 `Energy` 初始值为 0，便于在 Three.js 中接管灯语控制。

## 原始层级标识

| ID | 中文名称 |
|---|---|
| `SRC_DJI_Mini4Pro_AssetRoot` | 原始资产根节点 |
| `SRC_Imported_HierarchyRoot` | 导入层级根节点 |
| `SRC_GeometryRoot` | 几何根节点 |
| `SRC_MainBody_Arms_PropGeometry` | 原始主机身/机臂/桨叶几何组标识 |
| `SRC_TailStatusLED_Group` | 原始尾灯几何组标识 |
| `SRC_Decals_Group` | 原始贴花几何组标识 |
| `SRC_BlackHousing_Group` | 原始黑色壳体几何组标识 |
| `SRC_SensorGlass_Group` | 原始传感器玻璃几何组标识 |
