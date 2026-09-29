import * as THREE from 'three'

export const PROJ_UNIT = 'm' as const
export const PROJ_PRECISION = 2

export interface ProjCoordinate {
  x: number
  y: number
  z: number
}

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
