import { describe, it, expect } from 'vitest'
import {
  renderCountdownGif,
  countdownGifUrl,
} from '../src/countdown'

describe('renderCountdownGif', () => {
  it('produces a GIF89a with the expected frame count and no loop', () => {
    const gif = renderCountdownGif(5)
    expect(Buffer.from(gif.subarray(0, 6)).toString('ascii')).toBe('GIF89a')
    // Graphic Control Extension marker 0x21 0xF9 precedes every frame: 5s * 4fps + final hold.
    let frames = 0

    for (let i = 0; i < gif.length - 1; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) frames++
    expect(frames).toBe(21)
    // No NETSCAPE2.0 loop block => plays once.
    expect(Buffer.from(gif).includes('NETSCAPE2.0')).toBe(false)
  })

  it('shortens the animation by the lead time, floored at 1s', () => {
    const count = (gif: Uint8Array) => {
      let n = 0

      for (let i = 0; i < gif.length - 1; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) n++

      return n
    }

    expect(count(renderCountdownGif(10, 1))).toBe(count(renderCountdownGif(9)))
    expect(count(renderCountdownGif(1, 5))).toBe(count(renderCountdownGif(1)))
  })
})

describe('countdownGifUrl', () => {
  it('builds the route URL with a per-question cache buster', () => {
    expect(countdownGifUrl('https://h.example/', 20, 'q 1')).toBe('https://h.example/countdown/20.gif?q=q%201')
  })
})