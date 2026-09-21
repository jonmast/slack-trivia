import { GIFEncoder } from "gifenc"

/**
 * Countdown pie GIFs for the channel quiz.
 *
 * Slack has no client-side timer primitive, and editing the message every
 * second fights rate limits and resets radio selections. An animated GIF is
 * the one thing the client animates for free, so the question message carries
 * a non-looping GIF that drains over the answer window. It sits in a `context`
 * block as an image *element*: Slack renders those in a ~20px square with no
 * file-preview chrome (an `image` block would get a collapsible header), which
 * is why the countdown is a pie rather than a bar.
 *
 * The GIFs are pre-rendered at build time and served by the Worker as static
 * assets. Slack fetches the image synchronously while posting, so the URL must
 * be publicly reachable and fast; a failed fetch fails the post.
 */

const SIZE = 64
const OUTER_R = SIZE / 2 - 1
const FPS = 4
const DELAY_MS = 1000 / FPS
/** Hold on the final (empty) frame for a long time; the message gets replaced anyway. */
const FINAL_HOLD_MS = 60_000

// Palette indices
const TRANSPARENT = 0
const TRACK = 1
const GREEN = 2
const AMBER = 3
const RED = 4
const PALETTE = [
  [0, 0, 0], // transparent slot
  [200, 200, 200], // drained track (reads on both light and dark themes)
  [46, 182, 125],
  [236, 178, 46],
  [224, 30, 90],
]
const WEDGE = -1

function colorFor(fraction: number): number {
  if (fraction > 0.5) return GREEN
  if (fraction > 0.2) return AMBER
  return RED
}

/**
 * Classify a point: outside the circle, in the remaining wedge, or in the
 * drained track. The wedge starts at 12 o'clock and runs clockwise; as
 * `fraction` falls its trailing edge sweeps back toward the top.
 */
function classify(x: number, y: number, fraction: number): number {
  const c = (SIZE - 1) / 2
  const dx = x - c
  const dy = y - c
  if (dx * dx + dy * dy > OUTER_R * OUTER_R) return TRANSPARENT
  let a = Math.atan2(dx, -dy) / (2 * Math.PI) // clockwise from 12 o'clock, [0, 1)
  if (a < 0) a += 1
  return a < fraction ? WEDGE : TRACK
}

const SUBSAMPLES: [number, number][] = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
]

function drawFrame(fraction: number): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE).fill(TRANSPARENT)
  const color = colorFor(fraction)

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 2x2 supersample with majority vote to soften the wedge edge and rim.
      const votes = new Map<number, number>()
      for (const [ox, oy] of SUBSAMPLES) {
        const k = classify(x + ox, y + oy, fraction)
        votes.set(k, (votes.get(k) ?? 0) + 1)
      }
      let best = TRANSPARENT
      let bestN = 0
      for (const [k, n] of votes) {
        if (n > bestN) {
          best = k
          bestN = n
        }
      }
      px[y * SIZE + x] = best === WEDGE ? color : best
    }
  }
  return px
}

/**
 * Render a non-looping pie that drains over `secs - leadSecs` seconds and then
 * holds empty. `leadSecs` compensates for Slack's fetch + render delay so the
 * pie empties just before, never after, the server-side deadline.
 */
export function renderCountdownGif(secs: number, leadSecs: number = 0): Uint8Array {
  const playSecs = Math.max(1, secs - leadSecs)
  const frames = Math.round(playSecs * FPS)
  const gif = GIFEncoder()

  for (let i = 0; i <= frames; i++) {
    const last = i === frames
    gif.writeFrame(drawFrame(1 - i / frames), SIZE, SIZE, {
      palette: PALETTE,
      delay: last ? FINAL_HOLD_MS : DELAY_MS,
      repeat: -1, // play once
      transparent: true,
      transparentIndex: TRANSPARENT,
    })
  }
  gif.finish()
  return gif.bytes()
}

/**
 * Seconds shaved off the animation; see renderCountdownGif. Measured in a
 * real workspace: with no lead the pie still showed a sliver when the results
 * edit landed, so it runs half a second ahead of the server clock. This fixed
 * value is applied when the GIFs are rendered at build time.
 */
export const COUNTDOWN_LEAD_SECS = 0.5

/**
 * URL for the countdown GIF. `cacheKey` (the question id) forces Slack's
 * image proxy to fetch fresh for each question rather than reuse a cached copy.
 */
export function countdownGifUrl(baseUrl: string, secs: number, cacheKey: string): string {
  return `${baseUrl.replace(/\/$/, "")}/countdown/${secs}.gif?q=${encodeURIComponent(cacheKey)}`
}
