import { env, fetchMock, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { ChannelObject } from '../../worker/channel-object'
import { OPTION_TEXT_MAX, renderChannelCancelled, renderChannelExtended } from '../../src/slack-ui'
import {
  JevFake,
  SlackRecorder,
  channelObject,
  createTriviaQuestions,
  headerText,
  itemQuestionId,
  screeningRows,
  sleep,
  verdict,
  waitForCalls,
  COUNTDOWN_ORIGIN,
  POST_MESSAGE_TS,
  type TriviaApiQuestion,
} from './fixtures'

/**
 * Issue #16: questions are screened with Jev during the ready screen, and
 * only those it clears are asked.
 *
 * Jev, Slack and The Trivia API are faked for the whole file. Every question
 * the fake Trivia API serves has a fresh ID, `t1`, `t2`, ..., which its text
 * carries (`Question t1?`) so the fake Jev can judge each one by ID. The
 * ready screen is one second and an extended ready screen three
 * (`EXTENDED_READY_SECS` in the worker test bindings).
 */

const WINDOW = '1s'
const LONG_WINDOW = '30s'

const slack = new SlackRecorder()
const jev = new JevFake()

/**
 * The Trivia API, serving as many fresh questions as each request asks for,
 * or the IDs `ids` picks; `failStatus` and `delayMs` pick requests, by their
 * index in `limits`, to fail or slow down.
 */
class TriviaFake {
  limits: number[] = []
  ids: (index: number) => string[] | null = () => null
  failStatus: (index: number) => number | null = () => null
  delayMs: (index: number) => number = () => 0
  /** IDs of questions whose correct answer is one character too long for a Slack option. */
  longAnswers = new Set<string>()
  private served = 0

  reset(): void {
    this.limits = []
    this.ids = () => null
    this.failStatus = () => null
    this.delayMs = () => 0
    this.longAnswers = new Set()
    this.served = 0
  }

  install(): void {
    fetchMock
      .get('https://the-trivia-api.com')
      .intercept({ path: /^\/v2\/questions/, method: 'GET' })
      .reply<object>((options) => {
        const index = this.limits.length
        const limit = Number(new URL(options.path, 'https://x').searchParams.get('limit'))
        this.limits.push(limit)

        const status = this.failStatus(index)

        if (status) return { statusCode: status, data: { error: 'unavailable' } }

        const ids =
          this.ids(index) ??
          Array.from({ length: limit }, () => {
            this.served += 1

            return `t${this.served}`
          })

        const questions = createTriviaQuestions(ids.length).map(
          (question, i): TriviaApiQuestion => ({
            ...question,
            id: ids[i],
            question: { text: `Question ${ids[i]}?` },
            correctAnswer: this.longAnswers.has(ids[i]) ? 'x'.repeat(OPTION_TEXT_MAX + 1) : question.correctAnswer,
          }),
        )

        const delay = this.delayMs(index)

        // A promise body is answered once it settles.
        return { statusCode: 200, data: delay ? sleep(delay).then(() => questions) : questions }
      })
      .persist()
  }
}

const trivia = new TriviaFake()

/** Judge questions by ID; any not listed is rejected as misleading. */
function judgeByIds(verdicts: Record<string, ReturnType<typeof verdict>>) {
  return (item: string) => verdicts[itemQuestionId(item)] ?? verdict('misleading', 0.9)
}

async function start(channelId: string, args: string) {
  const stub = channelObject(channelId)
  const result = await stub.startQuiz(channelId, args, COUNTDOWN_ORIGIN)
  expect(result.ok).toBe(true)

  return stub
}

function dropScheduledAlarm(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm())
}

/** Deliver the alarm the way the platform would, bypassing its schedule. */
function fireAlarm(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  return runInDurableObject(stub, (instance) => instance.alarm!())
}

/** Passes `t1` and anything after the first `firstBatch` questions; rejects the rest. */
function passFirstAndLater(firstBatch: number) {
  return (item: string) => {
    const id = itemQuestionId(item)

    return id === 't1' || Number(id.slice(1)) > firstBatch
      ? verdict('good', 0.95)
      : verdict('stale', 0.8)
  }
}

/** The IDs of the questions put to the channel, in order. */
function askedIds(): string[] {
  return slack.updates
    .filter((call) => headerText(call.blocks)?.startsWith('Question'))
    .map((call) => call.blocks[1].block_id)
}

describe('screening questions with Jev', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    slack.install()
    jev.install()
    trivia.install()
  })

  beforeEach(() => {
    slack.reset()
    jev.reset()
    trivia.reset()
  })

  it('asks only questions Jev clears as good with p >= 0.70', async () => {
    jev.judge = judgeByIds({
      t1: verdict('misleading', 0.8),
      t2: verdict('good', 0.95),
      t3: verdict('good', 0.69),
      t4: verdict('good', 0.7),
      t5: verdict('garbled', 0.6),
      t6: verdict('good', 0.9),
    })

    await start('C-SELECT', `3 ${WINDOW}`)

    // Twice the questions asked for, all screened in one request.
    expect(trivia.limits).toEqual([6])
    expect(jev.requests).toHaveLength(1)

    // ready, then question/results three times, then the final summary
    await waitForCalls(slack, 8)
    expect(askedIds()).toEqual(['t2', 't4', 't6'])
    expect(headerText(slack.updates[0].blocks)).toBe('Question 1/3:')
  })

  it('drops questions with an answer too long for a Slack option before screening, logging them', async () => {
    trivia.longAnswers = new Set(['t2'])
    const log = vi.spyOn(console, 'log')

    await start('C-LONG', `2 ${WINDOW}`)

    expect(jev.items.map(itemQuestionId)).toEqual(['t1', 't3', 't4'])
    expect((await screeningRows('C-LONG')).map((row) => row.question_id)).toEqual(['t1', 't3', 't4'])
    const dropped = log.mock.calls.flatMap(([line]) => (String(line).includes('too long for Slack') ? [JSON.parse(line)] : []))
    expect(dropped.map((line) => line.annotations.tooLong.id)).toEqual(['t2'])
    log.mockRestore()

    // ready, then question/results twice, then the final summary
    await waitForCalls(slack, 6)
    expect(askedIds()).toEqual(['t1', 't3'])
  })

  it('sends Jev each question with its category and options, the correct one marked', async () => {
    const stub = await start('C-REQUEST', `1 ${LONG_WINDOW}`)

    const [request] = jev.requests
    expect(request.model).toBe('jev-1.13')
    expect(request.state.classes.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(Object.keys(request.questions)).toEqual(['i0', 'i1'])

    expect(request.questions.i0).toEqual({
      type: 'choice',
      instructions: {
        task: 'Which class does this item belong to?',
        item: {
          text: [
            'Category: Test',
            'Question: Question t1?',
            'Options:',
            '- Correct 1 (correct)',
            '- W1-1',
            '- W2-1',
            '- W3-1',
          ].join('\n'),
        },
      },
      criteria: { c0: null, c1: null, c2: null, c3: null, c4: null },
    })

    await dropScheduledAlarm(stub)
  })

  it('records a row for every verdict, unscreened where Jev gave no answer', async () => {
    jev.judge = (item) =>
      itemQuestionId(item) === 't1' ? verdict('good', 0.95) : undefined

    const stub = await start('C-ROWS', `1 ${LONG_WINDOW}`)
    const rows = await screeningRows('C-ROWS')

    expect(rows).toHaveLength(2)

    expect(rows[0]).toMatchObject({
      question_id: 't1',
      channel_id: 'C-ROWS',
      message_ts: POST_MESSAGE_TS,
      question: 'Question t1?',
      correct_answer: 'Correct 1',
      outcome: 'served',
      class: 'good',
      model: 'jev-1.13',
    })
    expect(JSON.parse(rows[0].options)).toEqual(['Correct 1', 'W1-1', 'W2-1', 'W3-1'])
    expect(JSON.parse(rows[0].probabilities!)).toEqual(verdict('good', 0.95).probabilities)
    expect(Number.isNaN(Date.parse(rows[0].screened_at))).toBe(false)

    // Jev left t2 unanswered: it was not screened, so it may still be asked.
    expect(rows[1]).toMatchObject({
      question_id: 't2',
      outcome: 'unscreened',
      class: null,
      probabilities: null,
      model: null,
    })

    await dropScheduledAlarm(stub)
  })

  it('screens on the ready alarm when the object went away before screening finished', async () => {
    const stub = await start('C-EVICTED', `2 ${LONG_WINDOW}`)

    // As if the object had gone away mid-screening: the quiz is stored, but
    // still waiting to be screened.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE quizzes SET state = json_set(state, '$.phase', 'screening') WHERE status = 'running'",
      )
    })

    jev.judge = judgeByIds({ t2: verdict('good', 0.95), t3: verdict('good', 0.95) })

    // ready screen, first question: the alarm screened again and dropped t1.
    await waitForCalls(slack, 2)
    expect(jev.requests).toHaveLength(2)
    expect(askedIds()).toEqual(['t2'])

    await dropScheduledAlarm(stub)
  })

  it('keeps looking past the countdown and starts once enough pass', async () => {
    // Only one of the first six passes; every later question does.
    jev.judge = (item) => {
      const id = itemQuestionId(item)

      return id === 't1' || Number(id.slice(1)) > 6
        ? verdict('good', 0.95)
        : verdict('stale', 0.8)
    }

    const stub = await start('C-EXTEND', `3 ${LONG_WINDOW}`)

    // ready, extended ready screen, first question
    await waitForCalls(slack, 3)
    expect(slack.updates[0].blocks).toEqual(renderChannelExtended(3, 30))
    expect(slack.updates[0].ts).toBe(POST_MESSAGE_TS)

    // The search fetched twice the two still missing, and the quiz started
    // in full, without another countdown.
    expect(trivia.limits).toEqual([6, 4])
    expect(headerText(slack.updates[1].blocks)).toBe('Question 1/3:')
    expect(askedIds()).toEqual(['t1'])

    await dropScheduledAlarm(stub)
  })

  it('starts with the questions that passed, saying so, when the extended ready screen runs out', async () => {
    jev.judge = judgeByIds({ t1: verdict('good', 0.95), t4: verdict('good', 0.8) })

    const stub = await start('C-SHORT', `3 ${WINDOW}`)

    // ready, extended ready screen, shortened ready screen, first question
    await waitForCalls(slack, 4, 15_000)

    const [extended, shortened, question] = slack.updates
    expect(extended.blocks).toEqual(renderChannelExtended(3, 1))

    expect(headerText(shortened.blocks)).toBe('Get ready!')
    expect(shortened.blocks[1].text.text).toContain('2 questions')
    expect(shortened.blocks[2].elements[0].text).toBe(
      '🔎 We only found 2 good questions, so this quiz is shorter than planned.',
    )
    expect(shortened.text).toContain('2 good questions')

    expect(headerText(question.blocks)).toBe('Question 1/2:')

    // It searched more than once, each time for twice the one missing.
    expect(trivia.limits.length).toBeGreaterThan(2)
    expect(trivia.limits.slice(1).every((limit) => limit === 2)).toBe(true)

    // ...and plays out over the two questions that passed.
    await waitForCalls(slack, 8)
    expect(askedIds()).toEqual(['t1', 't4'])
    expect(slack.lastBlocks[0].text.text).toContain('Trivia Quiz Complete!')

    // Every question screened along the way has its row.
    const rows = await screeningRows('C-SHORT')
    expect(rows.map((row) => row.question_id)).toEqual(
      Array.from({ length: rows.length }, (_, i) => `t${i + 1}`),
    )
    expect(rows.length).toBe(jev.items.length)
    expect(rows.filter((row) => row.outcome === 'served').map((row) => row.question_id)).toEqual([
      't1',
      't4',
    ])
    expect(await runDurableObjectAlarm(stub)).toBe(false)
  })

  it('cancels with an apology when no question passes', async () => {
    jev.judge = () => verdict('garbled', 0.9)

    const stub = await start('C-NONE', `2 ${LONG_WINDOW}`)

    // ready, extended ready screen, apology
    await waitForCalls(slack, 3, 15_000)
    expect(slack.updates[1].blocks).toEqual(renderChannelCancelled())
    expect(slack.updates[1].ts).toBe(POST_MESSAGE_TS)

    // Nothing more happens, and the channel takes `/quizzo` again.
    await sleep(300)
    expect(slack.calls).toHaveLength(3)
    expect(await runDurableObjectAlarm(stub)).toBe(false)
    expect((await screeningRows('C-NONE')).every((row) => row.outcome === 'rejected')).toBe(true)

    jev.reset()
    const restart = await start('C-NONE', `2 ${LONG_WINDOW}`)
    await dropScheduledAlarm(restart)
  })

  it('never screens a question twice for one quiz', async () => {
    jev.judge = passFirstAndLater(4)
    // The search is served one question screened at start and one new one.
    trivia.ids = (index) => (index === 1 ? ['t2', 't5'] : null)

    const stub = await start('C-DEDUPE', `2 ${LONG_WINDOW}`)

    // ready, extended ready screen, first question
    await waitForCalls(slack, 3)
    expect(headerText(slack.updates[1].blocks)).toBe('Question 1/2:')

    expect(jev.requests).toHaveLength(2)
    expect(jev.items.map(itemQuestionId)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect((await screeningRows('C-DEDUPE')).map((row) => row.question_id)).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
    ])

    await dropScheduledAlarm(stub)
  })

  it('asks the questions a search found unscreened when Jev fails then', async () => {
    jev.judge = passFirstAndLater(99)
    jev.failStatus = (index) => (index === 1 ? 503 : null)

    const stub = await start('C-SEARCH-JEV', `2 ${LONG_WINDOW}`)

    // ready, extended ready screen, first question: no waiting out the rest.
    await waitForCalls(slack, 3)
    expect(headerText(slack.updates[1].blocks)).toBe('Question 1/2:')
    expect(trivia.limits).toEqual([4, 2])

    const rows = await screeningRows('C-SEARCH-JEV')
    expect(rows.slice(4).map((row) => [row.question_id, row.outcome])).toEqual([
      ['t5', 'unscreened'],
      ['t6', 'unscreened'],
    ])

    await dropScheduledAlarm(stub)
  })

  it('starts with what passed when The Trivia API fails during a search', async () => {
    jev.judge = passFirstAndLater(99)
    trivia.failStatus = (index) => (index > 0 ? 500 : null)
    const warn = vi.spyOn(console, 'warn')

    const stub = await start('C-SEARCH-TRIVIA', `2 ${LONG_WINDOW}`)

    // ready, extended ready screen, shortened ready screen
    await waitForCalls(slack, 3, 10_000)
    expect(slack.updates[1].blocks[2].elements[0].text).toBe(
      '🔎 We only found 1 good question, so this quiz is shorter than planned.',
    )
    expect(trivia.limits.length).toBeGreaterThan(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch more trivia questions'))
    warn.mockRestore()

    await dropScheduledAlarm(stub)
  })

  it('ends the extended ready screen on time even when a search hangs', async () => {
    jev.judge = passFirstAndLater(99)
    // Longer than the extended ready screen, and than a fetch is allowed.
    trivia.delayMs = (index) => (index > 0 ? 6000 : 0)

    const stub = await start('C-SEARCH-SLOW', `2 ${LONG_WINDOW}`)

    await waitForCalls(slack, 2)
    const extendedAt = Date.now()

    // The three-second extended ready screen ends when it should, not when
    // the hung fetch gives up.
    await waitForCalls(slack, 3, 10_000)
    expect(Date.now() - extendedAt).toBeLessThan(4500)
    expect(headerText(slack.updates[1].blocks)).toBe('Get ready!')
    expect(slack.updates[1].text).toContain('1 good question')

    await dropScheduledAlarm(stub)
  })

  it('retries starting the quiz without searching again when Slack fails', async () => {
    jev.judge = passFirstAndLater(4)
    let rateLimited = true
    slack.failHttp = (call) => {
      if (!rateLimited || headerText(call.blocks) !== 'Question 1/2:') return null
      rateLimited = false

      return 429
    }

    const stub = await start('C-SEARCH-SLACK', `2 ${LONG_WINDOW}`)

    // ready, extended ready screen, the rate-limited first question
    await waitForCalls(slack, 3)
    expect(jev.requests).toHaveLength(2)

    // The platform retries the alarm; the start goes through on what the
    // search already found.
    await fireAlarm(stub)
    expect(headerText(slack.updates[2].blocks)).toBe('Question 1/2:')
    expect(askedIds()).toEqual(['t1', 't1'])
    expect(jev.requests).toHaveLength(2)
    expect(trivia.limits).toEqual([4, 2])

    await dropScheduledAlarm(stub)
  })

  it('moves the quiz on once when the ready alarm fires while screening still waits on Jev', async () => {
    // Slower than the one-second ready screen, but within the inline
    // screening's own timeout; the ready alarm's object keeps the test
    // bindings' 300 ms and gives up on Jev first.
    jev.delayMs = 1500
    const stub = channelObject('C-RACE')

    await runInDurableObject(stub, async (_instance, state) => {
      const patient = new ChannelObject(state, { ...env, JEV_TIMEOUT_MS: '5000' })
      const result = await patient.startQuiz('C-RACE', `2 ${LONG_WINDOW}`, COUNTDOWN_ORIGIN)
      expect(result.ok).toBe(true)
    })

    await waitForCalls(slack, 2)
    await sleep(1000)

    expect(jev.requests).toHaveLength(2)
    expect(slack.updates.map((call) => headerText(call.blocks))).toEqual(['Question 1/2:'])

    // Only the run that moved the quiz on is recorded: the ready alarm's,
    // which asked them unscreened.
    const rows = await screeningRows('C-RACE')
    expect(rows.map((row) => row.outcome)).toEqual([
      'unscreened',
      'unscreened',
      'unscreened',
      'unscreened',
    ])

    await dropScheduledAlarm(stub)
  })
})
