import { fetchMock, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { ChannelObject } from '../../worker/channel-object'
import { renderChannelCancelled, renderChannelExtended } from '../../src/slack-ui'
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

/** The Trivia API, serving as many fresh questions as each request asks for. */
class TriviaFake {
  limits: number[] = []
  private served = 0

  reset(): void {
    this.limits = []
    this.served = 0
  }

  install(): void {
    fetchMock
      .get('https://the-trivia-api.com')
      .intercept({ path: /^\/v2\/questions/, method: 'GET' })
      .reply(200, (options) => {
        const limit = Number(new URL(options.path, 'https://x').searchParams.get('limit'))
        this.limits.push(limit)

        return createTriviaQuestions(limit).map((question): TriviaApiQuestion => {
          this.served += 1
          const id = `t${this.served}`

          return { ...question, id, question: { text: `Question ${id}?` } }
        })
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

  it('records a row for every verdict', async () => {
    // t2 goes unanswered, which rejects it too.
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

    expect(rows[1]).toMatchObject({
      question_id: 't2',
      outcome: 'rejected',
      class: null,
      probabilities: null,
      model: 'jev-1.13',
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
})
