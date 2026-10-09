/**
 * 飞行场景的本地公制坐标系统(坐标换算 / 单位与精度工具)。
 *
 * 把 three.js 世界坐标当米使用,为遥测与场景提供统一单位与 2 位小数精度,
 * 并支持相对原点的本地坐标 <-> 世界坐标互转。纯工具,不含飞控逻辑。
 * 注意:所有返回值都已四舍五入,不要拿它做逐帧差分的积分累加。
 */
import * as THREE from 'three'

/** 本工程的坐标单位:米 */
export const PROJ_UNIT = 'm' as const
/** 默认保留的小数位数(2 位 = 厘米级),遥测与场景坐标共用 */
export const PROJ_PRECISION = 2

/** 本地坐标系下的直角坐标:与 three.js 一致,x 向东、y 向上、z 向南(单位米) */
export interface ProjCoordinate {
  x: number
  y: number
  z: number
}

/** 坐标入参的宽松形式:普通对象、THREE.Vector3 或三元组 */
export type ProjCoordinateInput = ProjCoordinate | THREE.Vector3 | readonly [number, number, number]

/**
 * A local metric coordinate system for the flight scene.
 *
 * Three.js units are treated as metres. Values returned by this class are
 * rounded to two decimal places so that telemetry and scene coordinates use
 * the same precision.
 */
export class ProjSystem {
  readonly unit = PROJ_UNIT
  readonly precision = PROJ_PRECISION
  readonly origin: THREE.Vector3

  constructor(origin: ProjCoordinateInput = [0, 0, 0]) {
    const coordinate = this.read(origin)
    this.origin = new THREE.Vector3(
      this.round(coordinate.x),
      this.round(coordinate.y),
      this.round(coordinate.z),
    )
  }

  /** Convert a world position to a local position relative to the origin. */
  toLocal(position: ProjCoordinateInput): THREE.Vector3 {
    const coordinate = this.read(position)
    return new THREE.Vector3(
      this.round(coordinate.x - this.origin.x),
      this.round(coordinate.y - this.origin.y),
      this.round(coordinate.z - this.origin.z),
    )
  }

  /** Convert a local position back to the world coordinate system. */
  toWorld(position: ProjCoordinateInput): THREE.Vector3 {
    const coordinate = this.read(position)
    return new THREE.Vector3(
      this.round(coordinate.x + this.origin.x),
      this.round(coordinate.y + this.origin.y),
      this.round(coordinate.z + this.origin.z),
    )
  }

  /** Return a rounded plain object, useful for telemetry or serialization. */
  normalize(position: ProjCoordinateInput): ProjCoordinate {
    const coordinate = this.read(position)
    return {
      x: this.round(coordinate.x),
      y: this.round(coordinate.y),
      z: this.round(coordinate.z),
    }
  }

  /** Format one metric value with the configured precision and unit. */
  format(value: number): string {
    return `${this.round(value).toFixed(this.precision)} ${this.unit}`
  }

  /** Format a coordinate as a readable XYZ metric string. */
  formatCoordinate(position: ProjCoordinateInput): string {
    const coordinate = this.normalize(position)
    return `X ${this.format(coordinate.x)} · Y ${this.format(coordinate.y)} · Z ${this.format(coordinate.z)}`
  }

  private round(value: number): number {
    const factor = 10 ** this.precision
    // +Number.EPSILON:补偿二进制浮点误差(否则 1.005 会被截成 1.00)
    return Math.round((value + Number.EPSILON) * factor) / factor
  }

  private read(input: ProjCoordinateInput): ProjCoordinate {
    if (input instanceof THREE.Vector3) {
      return { x: input.x, y: input.y, z: input.z }
    }
    if (Array.isArray(input)) {
      return { x: input[0], y: input[1], z: input[2] }
    }
    return input as ProjCoordinate
  }
}
