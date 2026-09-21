import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { MAX_TIMEOUT_SECS, RESULTS_SECS } from '../../src/trivia-core'

// The GIFs are pre-rendered into ./public by `pnpm build:assets` and served by
// the static-assets binding, so these go through the real asset router rather
// than any code of ours.
function get(path: string, method = 'GET'): Promise<Response> {
  return env.ASSETS.fetch(new Request(`https://example.com${path}`, { method }))
}

const magic = (body: ArrayBuffer) =>
  new TextDecoder().decode(new Uint8Array(body).subarray(0, 6))

describe('countdown GIF assets', () => {
  it('serves a real GIF89a at the countdown path', async () => {
    const response = await get('/countdown/20.gif')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/gif')
    expect(magic(await response.arrayBuffer())).toBe('GIF89a')
  })

  it('keeps the per-question cache buster on the URL working', async () => {
    const response = await get('/countdown/20.gif?q=some-question-id')

    expect(response.status).toBe(200)
    expect(magic(await response.arrayBuffer())).toBe('GIF89a')
  })

  it('caches for a day', async () => {
    const response = await get('/countdown/20.gif')

    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await get('/countdown/20.gif', 'HEAD')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/gif')
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it.each([1, RESULTS_SECS, MAX_TIMEOUT_SECS])(
    'has a GIF rendered for %is',
    async (secs) => {
      const response = await get(`/countdown/${secs}.gif`)

      expect(response.status).toBe(200)
      expect(magic(await response.arrayBuffer())).toBe('GIF89a')
    },
  )

  it('has nothing beyond the maximum timeout', async () => {
    const response = await get(`/countdown/${MAX_TIMEOUT_SECS + 1}.gif`)

    expect(response.status).toBe(404)
  })
})
