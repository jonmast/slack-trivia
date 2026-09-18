declare module "gifenc" {
  export type Palette = number[][]

  export interface FrameOptions {
    palette?: Palette
    delay?: number
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
    first?: boolean
  }

  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder
}
