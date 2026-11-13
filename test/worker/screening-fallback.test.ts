import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { ChannelObject } from '../../worker/channel-object'
import type { StartQuizResult } from '../../worker/channel-quiz'
import type { Env } from '../../worker/env'
import {
  JEV_AUTH_HEADERS,
  JEV_ORIGIN,
  JEV_PATH,
  SlackRecorder,
  channelObject,
  createTriviaQuestions,
  headerText,
  interceptTrivia,
  screeningRows,
  waitForCalls,
  COUNTDOWN_ORIGIN,
  POST_MESSAGE_TS,
} from './fixtures'

/**
 * Issue #16: when Jev cannot screen the questions, the quiz goes ahead with
 * them unscreened, as it did before screening, and says so in the log and in
 * the `screenings` record; when that record cannot be written, the quiz goes
 * ahead all the same.
 *
 * Each test answers its one Jev request with a failure; Jev's timeout is
 * 300 ms in the worker test bindings (`JEV_TIMEOUT_MS`).
 */

const LONG_WINDOW = '30s'

const slack = new SlackRecorder()

/**
 * One Jev request, answered with `status` and the JSON `body`, after
 * `delayMs`. The pending-interceptor check after each test proves the
 * request was made.
 */
function interceptJev(status: number, body: string, delayMs?: number): void {
  const scope = fetchMock
    .get(JEV_ORIGIN)
    .intercept({ path: JEV_PATH, method: 'POST', headers: JEV_AUTH_HEADERS })
    .reply(status, () => body)

  if (delayMs) scope.delay(delayMs)
}

function dropScheduledAlarm(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm())
}

/**
 * Start a quiz on a second channel object over `stub`'s storage, built from
 * `objectEnv` rather than the test bindings. Alarms still reach the object
 * the platform built.
 */
async function startWithEnv(
  stub: DurableObjectStub<ChannelObject>,
  channelId: string,
  objectEnv: Env,
): Promise<StartQuizResult> {
  return runInDurableObject(stub, (_instance, state) =>
    new ChannelObject(state, objectEnv).startQuiz(channelId, `2 ${LONG_WINDOW}`, COUNTDOWN_ORIGIN),
  )
}

/** One answer as Jev's wire format has it, class IDs and all. */
type WireAnswer = { choice: string; probabilities: { [classId: string]: number } }

/** A Jev reply with `answer` for every item of a four-question request, keyed by `key`. */
function replyFor(key: (index: number) => string, answer: WireAnswer): string {
  return JSON.stringify({
    model: 'jev-1.13',
    answers: Object.fromEntries([0, 1, 2, 3].map((i) => [key(i), answer])),
  })
}

/**
 * Start a two-question quiz on four fetched questions and see it ask the
 * first, unscreened. `startQuiz` starts it; by default through the stub.
 */
async function expectUnscreenedQuiz(
  channelId: string,
  startQuiz: (stub: DurableObjectStub<ChannelObject>) => Promise<{ ok: boolean }> = (stub) =>
    stub.startQuiz(channelId, `2 ${LONG_WINDOW}`, COUNTDOWN_ORIGIN),
): Promise<void> {
  const warn = vi.spyOn(console, 'warn')
  interceptTrivia(createTriviaQuestions(4))

  const stub = channelObject(channelId)
  const result = await startQuiz(stub)
  expect(result.ok).toBe(true)

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Jev is unavailable'))
  warn.mockRestore()

  // The quiz starts on time with the questions as fetched.
  await waitForCalls(slack, 2)
  expect(headerText(slack.updates[0].blocks)).toBe('Question 1/2:')
  expect(slack.updates[0].blocks[1].block_id).toBe('q-1')

  const rows = await screeningRows(channelId)
  expect(rows.map((row) => row.question_id)).toEqual(['q-1', 'q-2', 'q-3', 'q-4'])

  for (const row of rows) {
    expect(row).toMatchObject({
      channel_id: channelId,
      message_ts: POST_MESSAGE_TS,
      outcome: 'unscreened',
      class: null,
      probabilities: null,
      model: null,
    })
  }

  await dropScheduledAlarm(stub)
}

describe('screening that cannot be done or recorded', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    slack.install()
  })

  beforeEach(() => {
    slack.reset()
  })

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
  })

  it('asks questions unscreened when Jev answers with an error', async () => {
    interceptJev(500, JSON.stringify({ error: 'internal' }))
    await expectUnscreenedQuiz('C-JEV-500')
  })

  it('asks questions unscreened when Jev answers with something else', async () => {
    interceptJev(200, JSON.stringify({ hello: 'world' }))
    await expectUnscreenedQuiz('C-JEV-GARBAGE')
  })

  it('asks questions unscreened when Jev does not answer in time', async () => {
    interceptJev(200, JSON.stringify({ model: 'jev-1.13', answers: {} }), 2000)
    await expectUnscreenedQuiz('C-JEV-SLOW')
  })

  it.each([
    ['no answers', JSON.stringify({ model: 'jev-1.13', answers: {} })],
    ['answers keyed by something else', replyFor((i) => `q-${i + 1}`, { choice: 'c0', probabilities: { c0: 0.95 } })],
    ['choices that are not its classes', replyFor((i) => `i${i}`, { choice: 'good', probabilities: { good: 0.95 } })],
    ['probabilities keyed by class name', replyFor((i) => `i${i}`, { choice: 'c0', probabilities: { good: 0.95 } })],
  ])('asks questions unscreened when Jev answers with %s', async (_case, body) => {
    interceptJev(200, body)
    await expectUnscreenedQuiz('C-JEV-UNUSABLE')
  })

  it('asks questions unscreened, without calling Jev, when there is no OpenCode key', async () => {
    // No Jev interceptor: a call would fail the test.
    await expectUnscreenedQuiz('C-NO-KEY', (stub) =>
      startWithEnv(stub, 'C-NO-KEY', { ...env, OPENCODE_API_KEY: undefined }),
    )
  })

  it('keeps the channel object working when the DB binding is missing', async () => {
    const error = vi.spyOn(console, 'error')
    interceptJev(500, JSON.stringify({ error: 'internal' }))
    interceptTrivia(createTriviaQuestions(4))

    const stub = channelObject('C-NO-DB')

    await runInDurableObject(stub, async (_instance, state) => {
      const unbound = new ChannelObject(state, { ...env, DB: undefined })
      const result = await unbound.startQuiz('C-NO-DB', `2 ${LONG_WINDOW}`, COUNTDOWN_ORIGIN)

      expect(result.ok).toBe(true)
      expect(unbound.hasRunningQuiz()).toBe(true)
      expect(unbound.getChannelId()).toBe('C-NO-DB')
      // No question is up yet, so the answer is ignored, but the call works.
      expect(() => unbound.submitAnswer('U1', 'a1', 'q-1', Date.now())).not.toThrow()
    })

    expect(error).toHaveBeenCalledWith(expect.stringContaining('The DB binding is missing'))
    error.mockRestore()
    expect(await screeningRows('C-NO-DB')).toEqual([])

    await waitForCalls(slack, 2)
    expect(headerText(slack.updates[0].blocks)).toBe('Question 1/2:')
    await dropScheduledAlarm(stub)
  })

  it('carries on when the verdicts cannot be recorded', async () => {
    await env.DB.exec('DROP TABLE screenings')
    const error = vi.spyOn(console, 'error')
    interceptJev(500, JSON.stringify({ error: 'internal' }))
    interceptTrivia(createTriviaQuestions(4))

    const stub = channelObject('C-NO-D1')
    const result = await stub.startQuiz('C-NO-D1', `2 ${LONG_WINDOW}`, COUNTDOWN_ORIGIN)
    expect(result.ok).toBe(true)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to record screening verdicts'))
    error.mockRestore()

    await waitForCalls(slack, 2)
    expect(headerText(slack.updates[0].blocks)).toBe('Question 1/2:')
    await dropScheduledAlarm(stub)
  })
})
