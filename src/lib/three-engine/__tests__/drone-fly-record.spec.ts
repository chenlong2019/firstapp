import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DroneFly } from '../drone-fly'

/**
 * 录像取景的回归护栏。
 *
 * 真机只有一个云台相机,所以录到的画面必须恒为云台取景 —— 无论用户当前在看
 * 观察者 / 跟随 / 机载哪个视角。这层行为没法靠肉眼在页面上看出来(屏幕显示的
 * 始终是用户视角),所以在这里用假渲染器把它钉死。
 *
 * 注意录制源是独立的离屏画布:主画布随后还要渲染用户视角,而画布捕获是按
 * "绘制之后"抓帧的,直接抓主画布会把用户视角录进去。所以"录到了什么"这件事
 * 等价于"搬进录制画布的那一帧是什么"。
 */

/** 云台在世界坐标里的位置(测试里固定住,便于断言) */
const GIMBAL_POSITION = new THREE.Vector3(0, 1.2, 0)
/** 镜头沿光轴前移量,与实现里的 GIMBAL_CAMERA_OFFSET 保持一致 */
const GIMBAL_OFFSET = 0.12
/** 观察者视角下相机故意摆得离飞机很远,用来区分"用户视角帧"和"云台取景帧" */
const ORBIT_POSITION = new THREE.Vector3(6, 3.5, 7)

/**
 * 组装一个最小录像环境:假渲染器记录每次 render 时的相机位置(即"这一帧拍到了什么"),
 * 假云台只回传固定位姿;录制画布与轨道占位在构造后由 setTrack 注入,供各用例断言。
 * @param gimbalReady 云台位姿是否可用,传 false 用于验证降级路径
 */
function createHarness(gimbalReady = true) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000)
  camera.position.copy(ORBIT_POSITION)

  /* 记录每一次 render 时相机在哪 —— 这就是"这一帧拍到了什么"的判据 */
  const renderedFrom: THREE.Vector3[] = []
  const renderer = {
    domElement: document.createElement('canvas'),
    render: (_scene: unknown, cam: THREE.PerspectiveCamera): void => {
      renderedFrom.push(cam.position.clone())
    },
  }

  const fly = new DroneFly(scene, camera, renderer as never, null)
  fly.rig = {
    getGimbalCameraTransform: (target: THREE.Object3D): boolean => {
      if (!gimbalReady) return false
      target.position.copy(GIMBAL_POSITION)
      target.quaternion.identity()
      return true
    },
  } as never

  /* 录制画布:搬进这里的那一帧就是录到的画面。尺寸与主画布一致,不触发重设 */
  const drawImage = vi.fn()
  const track = { requestFrame: vi.fn() }
  const recordContext = {
    canvas: document.createElement('canvas'),
    drawImage,
  } as unknown as CanvasRenderingContext2D
  const setTrack = (): void => {
    const target = fly as unknown as { captureTrack: unknown; recordContext: unknown }
    target.captureTrack = track
    target.recordContext = recordContext
  }
  return { fly, camera, renderedFrom, track, drawImage, setTrack }
}

// 验证录到的画面恒为云台取景,与用户当前所处的观察者/跟随/机载哪个视角无关
describe('DroneFly 录像取景', () => {
  // 未开启录制时 captureRecordingFrame 应完全空转:不渲染、不搬帧、相机位姿不变
  it('未录制时不渲染取景帧、不动相机(零开销)', () => {
    const { fly, camera, renderedFrom, track, drawImage } = createHarness()

    fly.captureRecordingFrame()

    expect(renderedFrom).toHaveLength(0)
    expect(track.requestFrame).not.toHaveBeenCalled()
    expect(drawImage).not.toHaveBeenCalled()
    expect(camera.position.toArray()).toEqual(ORBIT_POSITION.toArray())
  })

  // 观察者视角下录制:恰好渲一帧且相机从云台位置出发(而非用户所在的观察者位置),结束后位姿还原
  it('观察者视角下录的是云台取景,且相机位姿原样还回去', () => {
    const { fly, camera, renderedFrom, track, drawImage, setTrack } = createHarness()
    setTrack()
    fly.cameraMode = 'orbit'

    fly.captureRecordingFrame()

    // 恰好渲一帧,且是从云台镜片位置渲的(而不是用户所在的观察者位置)
    expect(renderedFrom).toHaveLength(1)
    const expected = GIMBAL_POSITION.clone()
    expected.z -= GIMBAL_OFFSET
    expect(renderedFrom[0]?.toArray()).toEqual(expected.toArray())
    // 这一帧必须被搬进录制画布,否则录制器没有内容可录
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(track.requestFrame).toHaveBeenCalledTimes(1)
    // 屏幕上的观察者视角不受影响:位姿必须已还原
    expect(camera.position.toArray()).toEqual(ORBIT_POSITION.toArray())
  })

  // 跟随视角与观察者视角同理:录制帧来自云台位置,用户相机位姿不受影响
  it('跟随视角下同样以云台取景,且相机位姿原样还回去', () => {
    const { fly, camera, renderedFrom, track, drawImage, setTrack } = createHarness()
    setTrack()
    fly.cameraMode = 'follow'

    fly.captureRecordingFrame()

    expect(renderedFrom).toHaveLength(1)
    expect(renderedFrom[0]?.x).toBeCloseTo(GIMBAL_POSITION.x, 6)
    expect(renderedFrom[0]?.y).toBeCloseTo(GIMBAL_POSITION.y, 6)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(track.requestFrame).toHaveBeenCalledTimes(1)
    expect(camera.position.toArray()).toEqual(ORBIT_POSITION.toArray())
  })

  // 机载视角下相机本就在云台位:直接搬走当前帧,渲完前后相机位姿都应保持不变
  it('机载视角下相机本就在云台上,直接搬走这一帧,不做多余摆动', () => {
    const { fly, camera, renderedFrom, track, drawImage, setTrack } = createHarness()
    setTrack()
    fly.cameraMode = 'fpv'
    const before = camera.position.clone()

    fly.captureRecordingFrame()

    expect(renderedFrom).toHaveLength(1)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(track.requestFrame).toHaveBeenCalledTimes(1)
    expect(renderedFrom[0]?.toArray()).toEqual(before.toArray())
    expect(camera.position.toArray()).toEqual(before.toArray())
  })

  // 云台位姿获取失败(getGimbalCameraTransform 返回 false)时:不抓帧,且相机位姿不被污染
  it('云台不可用时不抓帧,也不留下半截位姿', () => {
    const { fly, camera, renderedFrom, track, drawImage, setTrack } = createHarness(false)
    setTrack()
    fly.cameraMode = 'orbit'

    fly.captureRecordingFrame()

    expect(renderedFrom).toHaveLength(0)
    expect(track.requestFrame).not.toHaveBeenCalled()
    expect(drawImage).not.toHaveBeenCalled()
    expect(camera.position.toArray()).toEqual(ORBIT_POSITION.toArray())
  })
})
