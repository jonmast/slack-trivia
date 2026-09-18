import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SlackQuiz, RESULTS_SECS } from '../src/slack-quiz'
import { createMockTriviaQuestion } from './test-utils'

const makeClient = () => ({
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123' }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
  views: {
    publish: vi.fn().mockResolvedValue({ ok: true, view: { id: 'view123' } }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
})

const makeLogger = () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })

const makeStore = (available: number) => {
  let n = 0
  return {
    ensure: vi.fn().mockImplementation(async (count: number) => count <= available),
    get: vi.fn().mockImplementation(() => {
      if (n >= available) throw new Error('No questions available')
      n++
      return createMockTriviaQuestion({ id: `q-${n}`, question: { text: `Question ${n}?` } })
    }),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TIMEOUT = 5
const BASE_URL = 'https://trivia.test'

/** Age the current question so its answer window and results window have passed. */
const expireResults = (quiz: SlackQuiz) => {
  ;(quiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT + RESULTS_SECS + 1) * 1000)
}

describe('SlackQuiz resilience (channel mode)', () => {
  let unhandled: unknown[]
  const onUnhandled = (reason: unknown) => unhandled.push(reason)

  beforeEach(() => {
    unhandled = []
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  it('refuses to start when the store cannot supply enough questions, without locking the channel', async () => {
    const client = makeClient()
    const onEnd = vi.fn()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(1) as any, 'C1', onEnd, 3, TIMEOUT, BASE_URL)

    await expect(quiz.startChannelQuiz('U1')).rejects.toThrow(/Could not load enough trivia questions/)
    expect(client.chat.postMessage).not.toHaveBeenCalled()
    quiz.abort()
    expect(quiz.isFinished()).toBe(true)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('ends the quiz gracefully (no unhandled rejection) if the store runs dry mid-quiz', async () => {
    const client = makeClient()
    const logger = makeLogger()
    const onEnd = vi.fn()
    const store = makeStore(1)
    store.ensure.mockResolvedValue(true) // lie: claim 3 are available
    const quiz = new SlackQuiz(client as any, logger as any, store as any, 'C1', onEnd, 3, TIMEOUT, BASE_URL)

    await quiz.startChannelQuiz('U1')
    expireResults(quiz)
    await sleep(250)

    expect(unhandled).toEqual([])
    expect(quiz.isFinished()).toBe(true)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Quiz failed to advance; ending quiz:', expect.any(Error))
    // Final summary was still posted.
    const last = client.chat.update.mock.calls.at(-1)![0]
    expect(last.text).toContain('completed')
  })

  it('ends the quiz gracefully if Slack rejects the next-question update', async () => {
    const client = makeClient()
    const onEnd = vi.fn()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(5) as any, 'C1', onEnd, 3, TIMEOUT, BASE_URL)

    await quiz.startChannelQuiz('U1')
    client.chat.update.mockRejectedValue(new Error('ratelimited'))
    expireResults(quiz)
    await sleep(250)

    expect(unhandled).toEqual([])
    expect(quiz.isFinished()).toBe(true)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('does not re-send an unchanged channel message every tick', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(5) as any, 'C1', undefined, 3, 30, BASE_URL)
    await quiz.startChannelQuiz('U1')
    await sleep(1250)
    // ~12 ticks; the GIF animates client-side so the open question is never edited.
    expect(client.chat.update).not.toHaveBeenCalled()
    quiz.abort()
  })

  it('calls onQuizEnd exactly once when the quiz completes', async () => {
    const client = makeClient()
    const onEnd = vi.fn()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(5) as any, 'C1', onEnd, 1, TIMEOUT, BASE_URL)
    await quiz.startChannelQuiz('U1')
    expireResults(quiz)
    await sleep(250)
    expect(quiz.isFinished()).toBe(true)
    quiz.abort()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

})

describe('SlackQuiz home tab mode', () => {
  it('publishes (not updates) the home view for every participant', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(5) as any, undefined, undefined, 3, 30)
    await quiz.initialize('U1')
    await quiz.initialize('U2')

    expect(client.views.publish).toHaveBeenCalledTimes(2)
    expect(client.views.publish.mock.calls.map((c) => c[0].user_id)).toEqual(['U1', 'U2'])
    expect(client.views.update).not.toHaveBeenCalled()

    // Second user joined the *same* question rather than restarting.
    expect((quiz as any).quiz.getQuestions()).toHaveLength(1)
    expect((quiz as any).quiz.getUsers()).toEqual(['U1', 'U2'])

    // Age the question by a second so the countdown changes -> one publish per user.
    client.views.publish.mockClear()
    ;(quiz as any).state.question.timestamp = new Date(Date.now() - 1000)
    await sleep(150)
    expect(client.views.publish).toHaveBeenCalledTimes(2)
    expect(client.views.update).not.toHaveBeenCalled()
    quiz.abort()
  })

  it('does not spam publishes while showing results', async () => {
    const client = makeClient()
    const quiz = new SlackQuiz(client as any, makeLogger() as any, makeStore(5) as any, undefined, undefined, 3, 1)
    await quiz.initialize('U1')
    // Expire the question: question -> processing (1.5s) -> results
    ;(quiz as any).state.question.timestamp = new Date(Date.now() - 2000)
    client.views.publish.mockClear()
    await sleep(2200)
    expect((quiz as any).state.type).toBe('results')
    // One publish for "time's up", one for results. Not one per 100ms tick.
    expect(client.views.publish.mock.calls.length).toBeLessThanOrEqual(3)
    quiz.abort()
  })
})
