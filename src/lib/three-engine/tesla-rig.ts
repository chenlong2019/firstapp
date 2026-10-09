/**
 * Tesla Model 3(2024)整车骨架层:把 `2024_tesla_model_3_rigged.glb` 装成一个可操纵的整车对象。
 *
 * 在整体里的位置:与 race-scene/race/car 平行的一条"单车型装配 + 驱动"路径,但走法不同 ——
 * 那边面向的是"只有几何、命名各异的通用车模",所以要在 loadCar 里做名字匹配、按象限切几何、
 * 兜底造轮子;这份 GLB 出厂前已被 Blender 按语义改装过,层级里直接就有 `DOOR_FL` / `STEER_FL` /
 * `WHEEL_FL` 这样的节点,于是这里不做任何几何切割,只按节点名绑定对象后旋转节点。
 *
 * 复用的资产与上游模块:
 * - 模型资产:`public/models/2024_tesla_model_3_rigged.glb`(8.1 MB,146,739 三角面,1:1 真车尺寸),
 *   与 bmw_x1 / volkswagen 等车模同级放置,页面按 `/models/xxx.glb` 复用同一份文件;
 * - 加载层:`model-loaders` 的 `loadModelFromUrl`(统一处理 draco / meshopt / 进度回调);
 * - 基础设施:`three-viewer` 的 `THREEViewer`(场景 / 相机 / 轨道控制 / 光照由调用方创建,
 *   本层只负责把车挂进它给的场景,不持有渲染器)。
 *
 * 契约来源:`public/models/2024_tesla_model_3_rigged.nodes.md`(与资产一同提供)。
 * 三条容易踩的约定,在这里重申(违反不会报错,只会静默走样):
 * 1. **车头朝 +Z**,左为 +X,地面 y = 0;与"航向 0° = −Z"的项目世界约定差 180°,
 *    需要与其它场景对齐时由调用方一次性摆正,别在门 / 轮这些子节点上逐个补角度。
 * 2. 门 / 后视镜 / 转向节点**自身没有旋转**,它们的 local Y 就是世界竖直轴,
 *    所以直接写 `rotation.y` 即可,不必换算四元数。
 * 3. 车轮绕 **local X** 滚动,角度可累加;前轮的自转轴挂在转向节点下面,
 *    因此转向时滚动轴会跟着转 —— 这是真车的运动方式,不需要额外补偿。
 */
import * as THREE from 'three'
import { loadModelFromUrl } from './model-loaders'

/** 静态资产地址:页面与通用查看器都按这个 URL 复用同一份模型文件。 */
export const TESLA_RIGGED_URL = '/models/2024_tesla_model_3_rigged.glb'
/** 随资产一起提供的节点契约文档(供人查阅,不在运行时使用)。 */
export const TESLA_NODES_DOC_URL = '/models/2024_tesla_model_3_rigged.nodes.md'

/** 车门位置:前左 / 前右 / 后左 / 后右。`x > 0` 为车左侧。 */
export type TeslaDoorId = 'fl' | 'fr' | 'rl' | 'rr'
/** 四个门位的固定顺序:前左 / 前右 / 后左 / 后右。 */
export const TESLA_DOOR_IDS: readonly TeslaDoorId[] = ['fl', 'fr', 'rl', 'rr']

/** 后视镜只有前门两个。 */
export type TeslaMirrorId = 'fl' | 'fr'
/** 后视镜顺序:左 / 右。 */
export const TESLA_MIRROR_IDS: readonly TeslaMirrorId[] = ['fl', 'fr']

/**
 * 灯光分组。资产把每盏灯做成独立 mesh + **按角复制的独立材质**
 * (如 `Lights_HEAD_FL` / `Lights_HEAD_FR`),所以分组只能按材质名归类,
 * 一组一个开关 —— 想单独点亮某一只大灯要再往下拆到材质级。
 */
export type TeslaLampGroup = 'head' | 'tail' | 'ambient' | 'door'
/** 灯光分组顺序:大灯 / 尾灯 / 氛围灯带 / 门内 LED。 */
export const TESLA_LAMP_GROUPS: readonly TeslaLampGroup[] = ['head', 'tail', 'ambient', 'door']

/** 门全开角度(度)。左右方向相反,见 {@link TeslaRig.setDoor}。 */
export const TESLA_DOOR_OPEN_DEG = 58
/** 后视镜全折角度(度)。 */
export const TESLA_MIRROR_FOLD_DEG = 78
/** 前轮最大转向角(度)。 */
export const TESLA_STEER_MAX_DEG = 26

/** 灯罩材质名(大灯/尾灯的玻璃外罩,见 nodes.md 的灯光表;名字里不含 `Lights_` 前缀)。 */
const LAMP_COVER = /^ext_(head|tail)light_glass_/i

/** 后视镜镜片材质名(资产里镜片是独立小面片,左右镜共用一份材质)。 */
const MIRROR_FACE = /^mirror$/i

/**
 * 各灯组点亮时的自发光颜色与峰值强度。
 *
 * 这份资产里所有材质都是 `metallicFactor = 0` 的普通 PBR 材质,**没有任何 emissiveFactor**
 * (已逐材质核对过 glTF JSON),也就是说"灯"在模型里只是几何,亮不亮完全由渲染层决定。
 * 所以这里给每组一个合理的色温,点亮 = 写 emissive 颜色 + 抬 emissiveIntensity。
 */
const LAMP_STYLE: Record<TeslaLampGroup, { color: number; peak: number }> = {
  /** 大灯:暖白,含灯罩 / 灯碗 / 日行灯带三块材质,峰值给足以便 Bloom 起光晕。 */
  head: { color: 0xfff3dc, peak: 2.6 },
  /** 尾灯:正红。 */
  tail: { color: 0xff2a14, peak: 2.2 },
  /** 车内氛围灯带:冷青蓝,与页面主色一致。 */
  ambient: { color: 0x35c8ff, peak: 1.6 },
  /** 门内 LED:中性暖白,随门一起动。 */
  door: { color: 0xffe9c4, peak: 1.2 },
}

/**
 * 判定一个材质属于哪一组灯,不属于任何一组时返回 null。
 *
 * 两个必须按契约处理的地方:
 * - `EXT_Headlight_Glass_*` 名字里**不含** `Lights`,所以过滤条件用的是小写子串 `light`,
 *   而不是前缀 `Lights_`(doc 里专门警告过这一点);
 * - `Taillight_Detail_AMBIENT` 同时含 `tail` 与 `ambient`,必须先判 `ambient`,
 *   否则车内灯带会被并进尾灯组,尾灯一开连中控台一起亮。
 */
function classifyLamp(materialName: string): TeslaLampGroup | null {
  const name = materialName.toLowerCase()
  if (!name.includes('light') && !name.includes('led')) return null
  if (name.includes('ambient')) return 'ambient'
  if (name.startsWith('int_led')) return 'door'
  if (name.includes('tail')) return 'tail'
  if (name.includes('head')) return 'head'
  return null
}

/** 灯的亮/灭渐变速率(每秒逼近比例):数值越大切换越干脆。 */
const LAMP_FADE_RATE = 5

/**
 * 熄灯时灯组内部材质的底色压暗系数。
 *
 * 灯碗 / 日行灯带 / 反光碗(`Lights_*`)出厂是银白浅色 —— 不透明灯罩时代它们被罩着看不见,
 * 灯罩改成半透明后,熄灯时这层白底会直接透出来,看起来像点亮着。真实车里这些部件
 * 处于灯罩阴影中,只有点亮时才可见 —— 所以把底色压暗、反射压低,点亮交给
 * {@link LAMP_STYLE} 的 emissive(发光不受底色影响)。
 */
const LAMP_INNER_DIM = 0.22

/** 加载配置。 */
export interface TeslaRigLoadOptions {
  /** 下载进度回调:拿不到 content-length 时给 null。 */
  onProgress?: (progress: number | null) => void
}

/** 一个灯组的运行状态:开关目标 + 当前渐变值。 */
interface LampState {
  on: boolean
  /** 当前强度系数 0~1,由 {@link TeslaRig.update} 向 `on` 逼近。 */
  level: number
}

/**
 * 装配好的整车:根节点、按契约绑定的可动节点,以及门 / 镜 / 转向 / 轮 / 灯五组控制。
 *
 * 标量状态(门角、镜角、转向角、灯强度)由本类持有并直接写进节点,是唯一真相;
 * 页面只需把用户操作转成方法调用,再按需回读做显示。
 */
export class TeslaRig {
  /** 车辆根节点(`CAR_ROOT`),已挂进传入的场景。类型用 Object3D:加载层对它只有这个保证。 */
  readonly root: THREE.Object3D
  /** 前轮转向枢轴(`STEER_FL` / `STEER_FR`)。 */
  private readonly steerPivots: THREE.Object3D[] = []
  /** 车轮自转枢轴(`WHEEL_FL` / `WHEEL_FR` / `WHEEL_RL` / `WHEEL_RR`)。 */
  private readonly wheelPivots: THREE.Object3D[] = []
  /** 四个门节点,按门位索引。 */
  private readonly doors = new Map<TeslaDoorId, THREE.Object3D>()
  /** 两个后视镜节点,按侧索引。 */
  private readonly mirrors = new Map<TeslaMirrorId, THREE.Object3D>()
  /** 灯组 → 该组下的材质集合(同一材质只收一次,材质是按角复制的,不存在跨组共享)。 */
  private readonly lampMaterials = new Map<TeslaLampGroup, THREE.Material[]>()
  /** 灯组 → 运行状态。 */
  private readonly lampState = new Map<TeslaLampGroup, LampState>()

  /** 整车尺寸(米),取自几何包围盒:约 2.088 × 1.444 × 4.719。 */
  readonly size: THREE.Vector3
  /** 轮胎半径(米):取前轮心离地高度 —— 车贴地时轮心高度就是轮胎半径。 */
  readonly wheelRadius: number

  /** 车轮累计滚动角(弧度),由车速积分而来。 */
  private rollAngle = 0
  /** 车速(米/秒),正为前进(+Z)。 */
  private speed = 0
  /** 灯光总亮度倍率(0~2),供页面统一调暗调亮。 */
  private brightness = 1

  /** 门 / 镜 / 转向的当前值,供回读。 */
  private readonly doorOpen = new Map<TeslaDoorId, number>()
  private readonly mirrorFold = new Map<TeslaMirrorId, number>()
  private steeringDeg = 0

  /**
   * 构造函数私有:唯一入口是静态方法 {@link TeslaRig.load},
   * 以保证"节点齐不齐"这件事在对象存在之前就已经检查过。
   */
  private constructor(root: THREE.Object3D, size: THREE.Vector3, wheelRadius: number) {
    this.root = root
    this.size = size
    this.wheelRadius = wheelRadius
  }

  /**
   * 加载并装配一辆车。
   *
   * @param scene 车辆挂载到的场景(通常来自 `THREEViewer.getObject().scene`)
   * @param url 模型地址,缺省用随项目复用的 {@link TESLA_RIGGED_URL}
   * @param options 进度回调
   * @throws 模型缺少契约要求的节点时抛出 —— 早失败好过一堆部件不动还不报错
   */
  static async load(
    scene: THREE.Scene,
    url: string = TESLA_RIGGED_URL,
    options: TeslaRigLoadOptions = {},
  ): Promise<TeslaRig> {
    const model = await loadModelFromUrl(url, undefined, { onProgress: options.onProgress })
    const root = model.scene

    // 阴影:车库场景的地面要接住车身投影,零件自身也要互相遮挡,统一打开
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      object.castShadow = true
      object.receiveShadow = true
    })

    scene.add(root)
    root.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())

    const steerFront = requireNode(root, 'STEER_FL')
    // 轮心离地高度即轮胎半径:资产保证车贴地(y = 0),所以这个数直接可用,
    // 不必再去量轮胎几何的高度 —— 量出来的值还要处理轮毂与胎面的差异。
    const wheelRadius = Math.abs(steerFront.getWorldPosition(new THREE.Vector3()).y) || 0.33

    const rig = new TeslaRig(root, size, wheelRadius)
    rig.bind()
    return rig
  }

  /** 按契约把可动节点与灯材质绑到各自的控制组上。 */
  private bind(): void {
    for (const id of TESLA_DOOR_IDS) {
      this.doors.set(id, requireNode(this.root, `DOOR_${id.toUpperCase()}`))
      this.doorOpen.set(id, 0)
    }
    for (const id of TESLA_MIRROR_IDS) {
      this.mirrors.set(id, requireNode(this.root, `MIRROR_${id.toUpperCase()}`))
      this.mirrorFold.set(id, 0)
    }
    this.steerPivots.push(requireNode(this.root, 'STEER_FL'), requireNode(this.root, 'STEER_FR'))
    this.wheelPivots.push(
      requireNode(this.root, 'WHEEL_FL'),
      requireNode(this.root, 'WHEEL_FR'),
      requireNode(this.root, 'WHEEL_RL'),
      requireNode(this.root, 'WHEEL_RR'),
    )

    // 灯:按材质名归组。同一个材质可能被多个网格共用(如 INT_LED 挂在四个门上),
    // 用 Set 去重,否则同一次赋值会被重复执行、且统计数量会虚高。
    const collected = new Map<TeslaLampGroup, Set<THREE.Material>>()
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        const group = classifyLamp(material.name)
        if (!group) continue
        const bucket = collected.get(group) ?? new Set<THREE.Material>()
        bucket.add(material)
        collected.set(group, bucket)
      }
    })
    for (const group of TESLA_LAMP_GROUPS) {
      this.lampMaterials.set(group, [...(collected.get(group) ?? [])])
      this.lampState.set(group, { on: false, level: 0 })
    }
    // 熄灯底色压暗:灯碗/灯带/反光碗(Lights_*)出厂是银白浅色,灯罩半透明化后这层白底
    // 会在熄灯时直接透出来 —— 真车里它们处于灯罩阴影中,点亮交给 emissive(不受底色影响)
    for (const group of TESLA_LAMP_GROUPS) {
      for (const material of this.lampMaterials.get(group) ?? []) {
        if (LAMP_COVER.test(material.name ?? '')) continue // 灯罩已在 applyGlassTreatment 处理
        const surface = material as THREE.MeshStandardMaterial
        surface.color.multiplyScalar(LAMP_INNER_DIM)
        surface.roughness = Math.max(surface.roughness, 0.6)
        surface.envMapIntensity = 0.2
      }
    }
    // 初始状态:全部熄灭(组内材质可能自带发光,一并压掉)
    this.pushLampLevels()
    this.applyGlassTreatment()
  }

  /**
   * 车窗贴膜、全景玻璃车顶、后视镜镜面与大灯/尾灯罩的材质适配。
   *
   * 资产里所有玻璃类材质都是 OPAQUE 的不透明材质 —— 原本靠贴图画出深色观感,
   * 但在纯灯光照明下只会渲染成一整块浅灰。这里按"贴了深色隐私膜"适配:
   * 不透明纯黑 + 低粗糙度。透明这条路踩过坑:0.28 的"通透玻璃"会把车内浅色
   * 内饰整片透出来,窗户又亮又白,像没贴膜;调到 0.82 也还是会在车顶区域
   * 透出被环境光照亮的白色顶棚,叠加直射高光后越过 Bloom 阈值炸成白雾 ——
   * 最终回到不透明纯黑(真车隐私膜从车外本来就看不到内饰),观感最稳。
   *
   * 后视镜镜片(`Mirror` 材质,左右镜共用)出厂是 roughness≈0.96 的哑光白,反光为零;
   * 真车镜片是铬面镜,这里给满金属度 + 近零粗糙 + 高反射,靠页面的环境贴图(RoomEnvironment)
   * 成像 —— 没有环境贴图的场景里金属面会发黑,这是依赖而不是缺陷。
   *
   * 两个值得注意的归属:
   * - 移交到门下的 WIN_DOOR_* 侧窗与车身上的车顶玻璃共用材质名,按名字匹配即可全覆盖;
   * - 灯罩(EXT_Headlight/Taillight_Glass)单独给烟熏色:大灯偏中性深灰、尾灯带一点暗红,
   *   否则关灯时灯罩的不透明浅色底会露出一个"白罩子",开灯后才被 Bloom 掩盖。
   *   灯罩同时也在 head/tail 灯组里(材质名含 light),点亮时的 emissive 叠在半透明罩上,
   *   内部灯碗(Lights_*_GLO/REF)是 OPAQUE 全强度发光,从罩后透出,观感与真车一致。
   */
  private applyGlassTreatment(): void {
    const GLASS = /^(black_glass|ext_window|int_window)$/i
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        const name = material.name ?? ''
        const surface = material as THREE.MeshStandardMaterial
        if (GLASS.test(name)) {
          // 贴膜参数:不透明纯黑 + 中低粗糙度。真车隐私膜从车外基本看不到内饰,
          // 不透明化同时消灭了"透射亮内饰"这条污染源,也不再需要透明排序的
          // 深度写入开关;粗糙度 0.45 把直射太阳的镜面高光摊开(玻璃镜面峰值
          // 能到 1.4 以上,曾把车顶后上方炸成白雾;specularIntensity 在
          // WebGPU 管线里不生效,只能靠 roughness 摊开 + 页面 Bloom 阈值 1.9 兜底);
          // 反射给 0.4 保留"黑得发亮"的膜面质感。
          // 玻璃出厂是双面材质,双面渲染让每块玻璃贡献两份镜面高光
          // (EXT+INT 双层即四份),不透明贴膜后背面毫无意义,改单面。
          material.transparent = false
          material.depthWrite = true
          surface.opacity = 1
          surface.roughness = 0.45
          surface.metalness = 0.05
          surface.envMapIntensity = 0.4
          surface.side = THREE.FrontSide
          surface.color.setHex(0x05080c)
        } else if (MIRROR_FACE.test(name)) {
          // 铬面镜:金属度 1 + 低粗糙,反射来自场景环境贴图。
          // 粗糙度/反射强度不能给到完美镜面:镜面朝车后,后视角正好对着
          // RoomEnvironment 的 HDR 光源,峰值会越过 Bloom 阈值,在车顶后方
          // 炸出一团白雾 —— 0.12 的粗糙度真实镜片也说得过去,顺带把能量摊开
          surface.metalness = 1
          surface.roughness = 0.12
          surface.envMapIntensity = 1.0
          surface.color.setHex(0xdde3e8)
        } else if (LAMP_COVER.test(name)) {
          material.transparent = true
          material.depthWrite = false
          const isHead = /head/i.test(name)
          surface.opacity = isHead ? 0.45 : 0.55
          surface.roughness = 0.12
          surface.metalness = 0.05
          surface.envMapIntensity = 1.2
          surface.color.setHex(isHead ? 0x0d1214 : 0x331009)
        } else {
          continue
        }
        material.needsUpdate = true
      }
    })
  }

  // ————————————————————————— 车门 —————————————————————————

  /**
   * 开合一个门。
   *
   * @param id 门位
   * @param open 0 = 关,1 = 全开(超出区间会被夹取)
   *
   * 左右两侧的开门方向相反:车左侧(+X)是负角,右侧是正角 —— 铰链在门的前缘,
   * 两侧互为镜像,若统一用同一符号会出现"一边开门、一边把门压进车里"。
   */
  setDoor(id: TeslaDoorId, open: number): void {
    const door = this.doors.get(id)
    if (!door) return
    const value = clamp01(open)
    this.doorOpen.set(id, value)
    const sign = id === 'fl' || id === 'rl' ? -1 : 1
    door.rotation.y = THREE.MathUtils.degToRad(TESLA_DOOR_OPEN_DEG * value * sign)
  }

  /** 四个门一起开合(开门演示 / 一键复位用)。 */
  setAllDoors(open: number): void {
    for (const id of TESLA_DOOR_IDS) this.setDoor(id, open)
  }

  /** 同时开合两个前门或两个后门。 */
  setDoorRow(row: 'front' | 'rear', open: number): void {
    const ids: TeslaDoorId[] = row === 'front' ? ['fl', 'fr'] : ['rl', 'rr']
    for (const id of ids) this.setDoor(id, open)
  }

  /** 回读某个门的开度(0~1)。 */
  getDoorOpen(id: TeslaDoorId): number {
    return this.doorOpen.get(id) ?? 0
  }

  // ————————————————————————— 后视镜 —————————————————————————

  /**
   * 折叠 / 展开后视镜。
   *
   * @param id 侧别
   * @param folded 0 = 展开,1 = 完全折叠(向后收)
   */
  setMirror(id: TeslaMirrorId, folded: number): void {
    const mirror = this.mirrors.get(id)
    if (!mirror) return
    const value = clamp01(folded)
    this.mirrorFold.set(id, value)
    const sign = id === 'fl' ? -1 : 1
    mirror.rotation.y = THREE.MathUtils.degToRad(TESLA_MIRROR_FOLD_DEG * value * sign)
  }

  /** 两个后视镜一起折叠 / 展开。 */
  setAllMirrors(folded: number): void {
    for (const id of TESLA_MIRROR_IDS) this.setMirror(id, folded)
  }

  /** 回读某个后视镜的折叠度(0~1)。 */
  getMirrorFold(id: TeslaMirrorId): number {
    return this.mirrorFold.get(id) ?? 0
  }

  // ————————————————————————— 转向与车轮 —————————————————————————

  /**
   * 前轮转向。
   *
   * @param degrees 转向角,正值为左转 —— 车头朝 +Z、左侧为 +X,
   *   绕 +Y 的正向旋转会把车轮的指向从 +Z 摆向 +X,即向左。
   *   超出 ±{@link TESLA_STEER_MAX_DEG} 会被夹取(再大就是漂移而不是转向了)。
   */
  setSteering(degrees: number): void {
    this.steeringDeg = THREE.MathUtils.clamp(degrees, -TESLA_STEER_MAX_DEG, TESLA_STEER_MAX_DEG)
    const radians = THREE.MathUtils.degToRad(this.steeringDeg)
    for (const pivot of this.steerPivots) pivot.rotation.y = radians
  }

  /** 回读当前转向角(度)。 */
  getSteering(): number {
    return this.steeringDeg
  }

  /**
   * 设定车速,车轮按其滚动(负值为倒车)。
   *
   * @param metresPerSecond 车速(米/秒)
   *
   * 这里只做"车上台架"式的轮子自转,不产生世界位移 —— 整车走位、相机跟随属于上层场景的职责,
   * 让 rig 保持"只描述车辆自身状态",换到任何场景里都能直接用。
   */
  setSpeed(metresPerSecond: number): void {
    this.speed = metresPerSecond
  }

  /** 回读当前车速(米/秒)。 */
  getSpeed(): number {
    return this.speed
  }

  // ————————————————————————— 灯光 —————————————————————————

  /** 点亮 / 熄灭一组灯(带渐变,见 {@link TeslaRig.update})。 */
  setLamp(group: TeslaLampGroup, on: boolean): void {
    const state = this.lampState.get(group)
    if (state) state.on = on
  }

  /** 回读某组灯是开是关(渐变过程中的目标值)。 */
  isLampOn(group: TeslaLampGroup): boolean {
    return this.lampState.get(group)?.on ?? false
  }

  /** 灯光总亮度倍率(0~2),用于统一调暗 / 调亮。 */
  setBrightness(value: number): void {
    this.brightness = THREE.MathUtils.clamp(value, 0, 2)
    this.pushLampLevels()
  }

  /** 回读灯光总亮度倍率。 */
  getBrightness(): number {
    return this.brightness
  }

  /** 某组灯下绑到了几个材质(诊断用:为 0 说明分组规则没匹配上)。 */
  getLampMaterialCount(group: TeslaLampGroup): number {
    return this.lampMaterials.get(group)?.length ?? 0
  }

  /**
   * 把当前渐变值写进材质。
   *
   * `emissive` 是材质上的颜色、`emissiveIntensity` 是它的倍率,真正的自发光 =
   * 两者相乘,所以熄灭时把强度压到 0 就够了,不必反复改写颜色(避免丢失原色)。
   */
  private pushLampLevels(): void {
    for (const group of TESLA_LAMP_GROUPS) {
      const state = this.lampState.get(group)
      const materials = this.lampMaterials.get(group)
      if (!state || !materials) continue
      const style = LAMP_STYLE[group]
      const intensity = style.peak * state.level * this.brightness
      for (const material of materials) {
        const surface = material as THREE.MeshStandardMaterial
        // 只有带 emissive 的材质能当灯用;STL 之类的兜底材质没有这个字段,跳过而不是崩。
        if (!surface.emissive) continue
        surface.emissive.setHex(style.color)
        surface.emissiveIntensity = intensity
        surface.needsUpdate = true
      }
    }
  }

  // ————————————————————————— 每帧更新 —————————————————————————

  /**
   * 每帧推进:车轮滚动积分 + 灯光渐变。
   *
   * @param delta 距上一帧的秒数(调用方做上限截断,避免切标签页回来后一次跳太远)
   */
  update(delta: number): void {
    if (this.speed !== 0) {
      // 纯滚动:角速度 ω = v / r。四个轮子同向同速 —— 车体坐标系里轮轴都指向 +X,
      // 所以左右轮用同一个累加角就是对的(镜像的是安装位置,不是转向方向)。
      this.rollAngle = (this.rollAngle + (this.speed / this.wheelRadius) * delta) % (Math.PI * 2)
      for (const pivot of this.wheelPivots) pivot.rotation.x = this.rollAngle
    }

    let changed = false
    for (const group of TESLA_LAMP_GROUPS) {
      const state = this.lampState.get(group)
      if (!state) continue
      const target = state.on ? 1 : 0
      if (state.level === target) continue
      // 指数逼近:与帧率无关,亮灭都有个柔和的过渡,不会"啪"一下跳变
      state.level += (target - state.level) * Math.min(1, delta * LAMP_FADE_RATE)
      if (Math.abs(target - state.level) < 1e-3) state.level = target
      changed = true
    }
    if (changed) this.pushLampLevels()
  }

  // ————————————————————————— 释放 —————————————————————————

  /** 从场景里摘掉整车并释放几何 / 材质 / 贴图。 */
  dispose(): void {
    this.root.removeFromParent()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.geometry) geometries.add(mesh.geometry)
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) if (material) materials.add(material)
    })
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => {
      // 贴图挂在材质上,材质留着贴图就回收不掉;逐个字段扫一遍而不是写死贴图槽位,
      // 这样法线 / 金属粗糙度 / 遮蔽等非常规槽位也能覆盖。
      Object.values(material as unknown as Record<string, unknown>).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose()
      })
      material.dispose()
    })
  }
}

/**
 * 按名字取节点,取不到就抛错。
 *
 * 这里刻意不做"找不到就跳过"的容错:这份资产是按 nodes.md 的契约生成的,
 * 节点缺失意味着用错了文件(比如误用了未改装的 `tesla_model_3.glb`),
 * 此时安静地少动一个门,远比直接报出来更难排查。
 */
function requireNode(root: THREE.Object3D, name: string): THREE.Object3D {
  const node = root.getObjectByName(name)
  if (!node) {
    throw new Error(
      `Tesla 模型缺少节点 ${name}:该文件不是按契约改装的 rigged 版本(见 ${TESLA_NODES_DOC_URL})`,
    )
  }
  return node
}

/** 把数值夹到 0~1。 */
function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1)
}
