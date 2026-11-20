import { fetchMock, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { ChannelObject } from '../../worker/channel-object'
import type { Question, TriviaQuestion } from '../../src/trivia-core'
import { renderChannelReady, renderChannelResults, renderFinalSummary } from '../../src/slack-ui'
import { countdownGifUrl } from '../../src/countdown'
import {
  JevFake,
  SlackRecorder,
  channelObject,
  createTriviaQuestions,
  headerText,
  interceptTrivia,
  sleep,
  waitForCalls,
  COUNTDOWN_ORIGIN,
  POST_MESSAGE_TS,
} from './fixtures'
import { NO_AWARDS } from '../test-utils'

/**
 * Issue #9: the quiz runs itself to completion on Durable Object alarms.
 *
 * Every assertion is on what Slack receives. The ready screen and the results
 * window are one second each here (`READY_SECS` and `RESULTS_SECS` in the
 * worker test bindings), so a whole quiz plays out in a few seconds of real
 * time.
 *
 * Alarms really are scheduled, so the runtime delivers most of them by itself;
 * where a test needs a delivery the platform would not make — a duplicate, or
 * a wake long after a deadline — it invokes `alarm()` directly.
 */

const WINDOW = '1s'
const LONG_WINDOW = '30s'

/** Matches the `RESULTS_SECS` worker test binding in vitest.config.ts. */
const RESULTS_SECS = 1

/** Matches the `READY_SECS` worker test binding in vitest.config.ts. */
const READY_SECS = 1

/**
 * One recorder for the file: `fetchMock` interceptors persist across tests, so
 * a per-test recorder would only ever see the first test's traffic.
 */
const slack = new SlackRecorder()

/** Clears every question, so these quizzes run screened on what they fetch. */
const jev = new JevFake()

async function start(
  channelId: string,
  args: string,
  questionCount: number,
) {
  interceptTrivia(createTriviaQuestions(questionCount))
  const stub = channelObject(channelId)
  const result = await stub.startQuiz(channelId, args, COUNTDOWN_ORIGIN)
  expect(result.ok).toBe(true)

  return stub
}

/** Deliver the alarm the way the platform would, bypassing its schedule. */
function fireAlarm(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  return runInDurableObject(stub, (instance) => instance.alarm!())
}

/** Take the scheduled alarm away: the object was gone when it should have run. */
function dropScheduledAlarm(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm())
}

/** Drop the instance itself; its storage survives, as after a deploy or crash. */
async function dropInstance(stub: DurableObjectStub<ChannelObject>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.abort('test restart')).catch(
    () => {},
  )
}

/**
 * Rebuild the question the way the participants saw it — the answer IDs are
 * generated per question, so they can only come from the posted blocks.
 */
function questionFrom(postedBlocks: any[], apiQuestion: TriviaQuestion): Question {
  const answers = postedBlocks[1].accessory.options.map((option: any) => ({
    id: option.value,
    text: option.text.text,
  }))

  return {
    question: apiQuestion,
    answers,
    correctAnswer: answers.find((answer: any) => answer.text === apiQuestion.correctAnswer)!,
    timestamp: new Date(0),
    responses: [],
  }
}

function recapButtonValue(blocks: any[]): string | undefined {
  const actions = blocks.find((block) => block.type === 'actions')

  return actions?.elements?.[0]?.value
}

describe('alarm-driven progression', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    slack.install()
    jev.install()
  })

  beforeEach(() => {
    slack.reset()
    jev.reset()
  })

  it('runs a whole quiz to completion, one Slack edit per transition', async () => {
    const stub = await start('C-FLOW', `2 ${WINDOW}`, 2)

    // post ready screen, question 1, results 1, question 2, results 2, final summary
    await waitForCalls(slack, 6)

    const [post, question1, results1, question2, results2, summary] = slack.calls
    expect(post.method).toBe('chat.postMessage')
    expect(jev.items).toHaveLength(2)

    // The quiz opens on the ready screen, not the first question.
    expect(post.blocks).toEqual(
      renderChannelReady(
        2,
        1,
        READY_SECS,
        countdownGifUrl(COUNTDOWN_ORIGIN, READY_SECS, 'q-1-ready'),
      ),
    )

    // Every later frame is an edit of the same channel message.
    for (const call of slack.updates) {
      expect(call.method).toBe('chat.update')
      expect(call.channel).toBe('C-FLOW')
      expect(call.ts).toBe(POST_MESSAGE_TS)
    }

    expect(headerText(question1.blocks)).toBe('Question 1/2:')
    expect(question1.blocks[1].block_id).toBe('q-1')
    expect(question1.blocks[1].accessory.action_id).toBe('radio_sel')
    expect(question1.blocks[2].elements[0].image_url).toBe(
      countdownGifUrl(COUNTDOWN_ORIGIN, 1, 'q-1'),
    )

    // The results frame is exactly what the channel results renderer produces
    // for the question that was asked.
    expect(results1.blocks).toEqual(
      renderChannelResults(
        questionFrom(question1.blocks, createTriviaQuestions(1)[0]),
        [],
        1,
        2,
        RESULTS_SECS,
        countdownGifUrl(COUNTDOWN_ORIGIN, RESULTS_SECS, 'q-1-results'),
      ),
    )
    expect(results1.text).toBe('Answer: Correct 1 — Question 1?')

    expect(headerText(question2.blocks)).toBe('Question 2/2:')
    expect(question2.blocks[1].accessory.action_id).toBe('radio_sel')
    expect(question2.blocks[1].accessory.options.map((o: any) => o.text.text).sort()).toEqual([
      'Correct 2',
      'W1-2',
      'W2-2',
      'W3-2',
    ])

    expect(headerText(results2.blocks)).toBe('Answer 2/2:')
    expect(results2.blocks[3].elements[1].text).toBe('🏁 Final results in 1 seconds')

    // The final summary is the existing renderer's output, Recap button and
    // all, carrying the timestamp of the message hosting the quiz.
    expect(summary.blocks).toEqual(renderFinalSummary([], 2, POST_MESSAGE_TS, NO_AWARDS))
    expect(summary.text).toContain('completed')
    expect(recapButtonValue(summary.blocks)).toBe(POST_MESSAGE_TS)

    // Completion sets no alarm, and nothing further reaches Slack.
    expect(await runDurableObjectAlarm(stub)).toBe(false)
    await fireAlarm(stub)
    expect(slack.calls).toHaveLength(6)

    // The channel is free again.
    interceptTrivia(createTriviaQuestions(2))

    const restart = await channelObject('C-FLOW').startQuiz(
      'C-FLOW',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(restart.ok).toBe(true)
    await dropScheduledAlarm(stub)
  })

  it('never edits the question while the answer window is open', async () => {
    const stub = await start('C-OPEN', `2 ${LONG_WINDOW}`, 2)
    await waitForCalls(slack, 2) // question 1

    // An alarm exists (it is set for the window's end) but is not yet due.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await fireAlarm(stub)
    await sleep(300)

    expect(slack.updates).toHaveLength(1)
    await dropScheduledAlarm(stub)
  })

  it('does not ask the first question early on a duplicate ready alarm', async () => {
    const stub = await start('C-READY-DUP', `2 ${LONG_WINDOW}`, 2)

    // Delivered while the ready screen is still up: nothing is due yet.
    await fireAlarm(stub)
    await fireAlarm(stub)
    expect(slack.updates).toHaveLength(0)

    // The first question still goes up exactly once, when the screen ends.
    await waitForCalls(slack, 2)
    expect(headerText(slack.calls[1].blocks)).toBe('Question 1/2:')
    await sleep(200)
    expect(slack.updates).toHaveLength(1)
    await dropScheduledAlarm(stub)
  })

  it('treats a duplicate alarm for a passed transition as a no-op', async () => {
    const stub = await start('C-DUP', `2 ${WINDOW}`, 2)

    await waitForCalls(slack, 3) // results for question 1
    expect(headerText(slack.calls[2].blocks)).toBe('Answer 1/2:')

    // The platform re-delivers the question alarm. It must change nothing.
    await fireAlarm(stub)
    await fireAlarm(stub)
    expect(slack.calls).toHaveLength(3)

    // ...and the results transition still happens exactly once, on time.
    await waitForCalls(slack, 4)
    expect(headerText(slack.calls[3].blocks)).toBe('Question 2/2:')
    await sleep(200)
    expect(slack.calls.filter((call) => headerText(call.blocks) === 'Question 2/2:')).toHaveLength(1)
  })

  it('goes straight to results when it wakes long after the deadline', async () => {
    const stub = await start('C-LATE', `2 ${WINDOW}`, 2)
    await waitForCalls(slack, 2) // question 1

    // Nothing fires while the object is "down": the window expires unattended.
    await dropScheduledAlarm(stub)
    await sleep(1500)
    expect(slack.updates).toHaveLength(1)

    await fireAlarm(stub)

    // Results, not a re-post of the question the participants already saw.
    expect(slack.updates).toHaveLength(2)
    expect(headerText(slack.updates[1].blocks)).toBe('Answer 1/2:')
    expect(slack.updates[1].text).toContain('Answer: Correct 1')

    // The results still get their full run: downtime must not flash the answer
    // past the channel and jump to the next question.
    await sleep(500)
    expect(slack.updates).toHaveLength(2)
    await waitForCalls(slack, 4)
    expect(headerText(slack.calls[3].blocks)).toBe('Question 2/2:')
    await dropScheduledAlarm(stub)
  })

  it('retries rather than ending the quiz when Slack fails transiently', async () => {
    let rateLimited = true
    slack.failHttp = (call) => {
      if (!rateLimited || headerText(call.blocks) !== 'Answer 1/2:') return null
      rateLimited = false

      return 429
    }

    const warn = vi.spyOn(console, 'warn')
    const stub = await start('C-RATE-LIMIT', `2 ${WINDOW}`, 2)

    // The first results edit is rate-limited; the quiz must survive it.
    await waitForCalls(slack, 3)
    expect(slack.updates).toHaveLength(2)
    await sleep(100)
    // ...and the failure that made the alarm reject is on record.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat.update HTTP 429'))
    warn.mockRestore()

    // The platform retries the alarm; this time the edit lands.
    await fireAlarm(stub)
    expect(slack.updates).toHaveLength(3)
    expect(headerText(slack.updates[2].blocks)).toBe('Answer 1/2:')

    // Still a live quiz, not one ended by a rate limit.
    const refused = await channelObject('C-RATE-LIMIT').startQuiz(
      'C-RATE-LIMIT',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(refused.ok).toBe(false)
    await dropScheduledAlarm(stub)
  })

  it('continues the quiz after the object is dropped mid-question', async () => {
    const stub = await start('C-RESTART', `2 ${WINDOW}`, 2)
    await waitForCalls(slack, 2) // question 1

    await dropScheduledAlarm(stub)
    await dropInstance(stub)
    await sleep(1200)

    // A genuinely new instance, built from storage alone.
    const revived = channelObject('C-RESTART')
    await fireAlarm(revived)

    // It picks up where it left off and runs the rest of the quiz by itself.
    await waitForCalls(slack, 6)
    expect(slack.updates.map((call) => headerText(call.blocks))).toEqual([
      'Question 1/2:',
      'Answer 1/2:',
      'Question 2/2:',
      'Answer 2/2:',
      undefined, // final summary has no header block
    ])
    expect(slack.lastBlocks[0].text.text).toContain('Trivia Quiz Complete!')
  })

  it('ends the quiz with a final summary when the next-question edit fails', async () => {
    slack.failUpdate = (call) =>
      headerText(call.blocks) === 'Question 2/2:' ? 'message_not_found' : null
    const stub = await start('C-UPDATE-FAIL', `2 ${WINDOW}`, 2)

    // ready screen, question 1, results, failed question 2, best-effort final summary
    await waitForCalls(slack, 5)
    expect(slack.lastBlocks[0].text.text).toContain('Trivia Quiz Complete!')
    expect(recapButtonValue(slack.lastBlocks)).toBe(POST_MESSAGE_TS)

    // The quiz is over: no further alarm, and the channel takes `/quizzo` again.
    expect(await runDurableObjectAlarm(stub)).toBe(false)
    interceptTrivia(createTriviaQuestions(2))

    const restart = await channelObject('C-UPDATE-FAIL').startQuiz(
      'C-UPDATE-FAIL',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(restart.ok).toBe(true)
    await dropScheduledAlarm(stub)
  })

  it('frees the channel even when the final summary itself cannot be posted', async () => {
    slack.failUpdate = () => 'message_not_found'
    const stub = await start('C-DEAD-MESSAGE', `2 ${WINDOW}`, 2)

    // ready screen, failed question 1, then the best-effort summary attempt,
    // which also fails
    await waitForCalls(slack, 3)
    await sleep(300)
    expect(slack.calls).toHaveLength(3)
    expect(slack.lastBlocks[0].text.text).toContain('Trivia Quiz Complete!')
    expect(await runDurableObjectAlarm(stub)).toBe(false)

    slack.failUpdate = () => null
    interceptTrivia(createTriviaQuestions(2))

    const restart = await channelObject('C-DEAD-MESSAGE').startQuiz(
      'C-DEAD-MESSAGE',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(restart.ok).toBe(true)
    await dropScheduledAlarm(stub)
  })

  it('frees the channel when the running quiz can no longer be read', async () => {
    const stub = await start('C-UNREADABLE', `2 ${LONG_WINDOW}`, 2)

    // A stored quiz this code cannot decode, which every alarm would otherwise
    // fail on, holding the channel forever.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE quizzes SET state = '{}' WHERE status = 'running'")
    })

    await fireAlarm(stub)

    // There is no leaderboard to show, but the quiz is over: no further alarm,
    // and the channel takes `/quizzo` again.
    expect(slack.updates).toHaveLength(0)
    expect(await runDurableObjectAlarm(stub)).toBe(false)
    interceptTrivia(createTriviaQuestions(2))

    const restart = await channelObject('C-UNREADABLE').startQuiz(
      'C-UNREADABLE',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(restart.ok).toBe(true)
    await dropScheduledAlarm(stub)
  })

  it('posts the final summary exactly once, however often the alarm is delivered', async () => {
    const stub = await start('C-ONCE', `1 ${WINDOW}`, 1)

    // The last question's results go up...
    await waitForCalls(slack, 3)
    expect(headerText(slack.calls[2].blocks)).toBe('Answer 1/1:')

    // ...and a duplicate alarm delivered during them does not end the quiz
    // early, which is what would post a second summary later.
    await fireAlarm(stub)
    await fireAlarm(stub)
    expect(slack.calls).toHaveLength(3)

    await waitForCalls(slack, 4)
    // Alarms after the end find nothing left to do.
    await fireAlarm(stub)
    await sleep(300)
    expect(slack.calls.filter((call) => call.text.includes('completed'))).toHaveLength(1)
  })

  it('keeps two channels from affecting each other', async () => {
    const quick = await start('C-ONE', `1 ${WINDOW}`, 1)
    const slow = await start('C-TWO', `2 ${LONG_WINDOW}`, 2)

    // The quick channel finishes...
    await waitForCalls(slack, 6)
    const oneCalls = slack.calls.filter((call) => call.channel === 'C-ONE')
    expect(oneCalls.map((call) => call.method)).toEqual([
      'chat.postMessage',
      'chat.update',
      'chat.update',
      'chat.update',
    ])

    // ...while the other channel's quiz is untouched, still on its question.
    const twoCalls = slack.calls.filter((call) => call.channel === 'C-TWO')
    expect(twoCalls.map((call) => call.method)).toEqual(['chat.postMessage', 'chat.update'])
    expect(headerText(twoCalls[1].blocks)).toBe('Question 1/2:')

    // A finished quiz in one channel does not release or disturb the other.
    const refused = await channelObject('C-TWO').startQuiz(
      'C-TWO',
      `2 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
    )

    expect(refused.ok).toBe(false)
    expect(refused.text).toMatch(/already running/i)

    await dropScheduledAlarm(slow)
    expect(await runDurableObjectAlarm(quick)).toBe(false)
  })
})
