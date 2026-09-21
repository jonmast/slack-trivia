import { describe, it, expect, vi } from 'vitest'
import {
  renderCountdownGif,
  getCountdownGif,
  countdownGifUrl,
  countdownRouteHandler,
} from '../src/countdown'
import { SlackQuiz, RESULTS_SECS } from '../src/slack-quiz'
import { createMockTriviaQuestion } from './test-utils'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

  it('memoises per duration', () => {
    expect(getCountdownGif(7)).toBe(getCountdownGif(7))
  })
})

describe('countdownGifUrl', () => {
  it('builds the route URL with a per-question cache buster', () => {
    expect(countdownGifUrl('https://h.example/', 20, 'q 1')).toBe('https://h.example/countdown/20.gif?q=q%201')
  })
})

describe('countdownRouteHandler', () => {
  const makeRes = () => {
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    return res
  }

  it('serves image/gif for a valid duration and honours HEAD', () => {
    const res = makeRes()
    countdownRouteHandler({ method: 'GET', params: { secs: '20.gif' } } as any, res)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'image/gif' }))
    expect(res.end.mock.calls[0][0]).toBeInstanceOf(Uint8Array)

    const head = makeRes()
    countdownRouteHandler({ method: 'HEAD', params: { secs: '20.gif' } } as any, head)
    expect(head.writeHead).toHaveBeenCalledWith(200, expect.anything())
    expect(head.end).toHaveBeenCalledWith()
  })

  it.each(['0.gif', '61.gif', 'abc.gif', '2.5.gif'])('404s for %s', (secs) => {
    const res = makeRes()
    countdownRouteHandler({ method: 'GET', params: { secs } } as any, res)
    expect(res.writeHead).toHaveBeenCalledWith(404)
  })
})

describe('SlackQuiz channel mode countdown', () => {
  const makeClient = () => ({
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.2' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  })
  const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any
  const makeStore = () => {
    let n = 0
    return {
      ensure: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockImplementation(() => {
        n++
        return createMockTriviaQuestion({ id: `q-${n}`, question: { text: `Question ${n}?` } })
      }),
    }
  }

  it('refuses to start a channel quiz without a base URL', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, logger, makeStore() as any, 'C1', undefined, 3, 30)
    await expect(quiz.startChannelQuiz('U1')).rejects.toThrow(/COUNTDOWN_BASE_URL/)
    expect(client.chat.postMessage).not.toHaveBeenCalled()
    quiz.abort()
  })

  it('posts the pie once and never edits the message while the question is open', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, logger, makeStore() as any, 'C1', undefined, 3, 30, 'https://h')
    await quiz.startChannelQuiz('U1')

    const posted = client.chat.postMessage.mock.calls[0][0]
    expect(posted.blocks[2].elements[0].image_url).toBe('https://h/countdown/30.gif?q=q-1')

    await sleep(1250) // ~12 ticks; the text timer would have edited at least once here
    expect(client.chat.update).not.toHaveBeenCalled()
    quiz.abort()
  })

  it('starts the answer window after the post resolves, not when the question was created', async () => {
    const client = makeClient()
    let resolvePost!: (v: any) => void
    client.chat.postMessage.mockReturnValue(new Promise((r) => (resolvePost = r)))
    const quiz = new SlackQuiz(client as any, logger, makeStore() as any, 'C1', undefined, 3, 30, 'https://h')

    const starting = quiz.startChannelQuiz('U1')
    await sleep(300)
    const before = Date.now()
    resolvePost({ ok: true, ts: '1.2' })
    await starting

    const stamped = (quiz as any).state.question.timestamp.getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
    quiz.abort()
  })

  it('still moves to results and on to the next question', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, logger, makeStore() as any, 'C1', undefined, 3, 5, 'https://h')
    await quiz.startChannelQuiz('U1')

    ;(quiz as any).state.question.timestamp = new Date(Date.now() - 6000)
    await sleep(250)
    const results = client.chat.update.mock.calls.at(-1)![0]
    expect(results.text).toMatch(/^Answer: /)
    expect(results.blocks[1].text.text).toContain('answered')
    expect(results.blocks[3].elements[0].image_url).toBe(`https://h/countdown/${RESULTS_SECS}.gif?q=q-1-results`)

    ;(quiz as any).state.question.timestamp = new Date(Date.now() - (5 + RESULTS_SECS + 1) * 1000)
    await sleep(250)
    const next = client.chat.update.mock.calls.at(-1)![0]
    expect(next.blocks[2].elements[0].image_url).toBe('https://h/countdown/5.gif?q=q-2')
    quiz.abort()
  })
})
