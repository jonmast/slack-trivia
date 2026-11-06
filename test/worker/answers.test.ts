import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import worker, { SLACK_EVENTS_PATH } from '../../worker/index'
import { SPEED_BONUS_MAX } from '../../src/trivia-core'
import {
  SlackRecorder,
  channelObject,
  createTriviaQuestions,
  headerText,
  interceptTrivia,
  sleep,
  waitForCalls,
  COUNTDOWN_ORIGIN,
  SLACK_BOT_TOKEN,
} from './fixtures'

/**
 * Issue #10: answers are recorded durably and scored.
 *
 * Everything is asserted through the leaderboards Slack receives: the results
 * frame shows whole points only, so the speed bonus is read off the final
 * summary, which lists it separately to two decimal places.
 */

const WINDOW = '1s'
const LONG_WINDOW = '30s'

const slack = new SlackRecorder()

async function start(channelId: string, args: string, questionCount: number) {
  interceptTrivia(createTriviaQuestions(questionCount))
  const stub = channelObject(channelId)
  const result = await stub.startQuiz(channelId, args, COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)
  expect(result.ok).toBe(true)

  return stub
}

/** The answer IDs are generated per question, so they only exist in the blocks. */
function optionValue(blocks: any[], text: string): string {
  const option = blocks[1].accessory.options.find((o: any) => o.text.text === text)

  if (!option) throw new Error(`No option ${text} in ${JSON.stringify(blocks[1].accessory.options)}`)

  return option.value
}

function blockId(blocks: any[]): string {
  return blocks[1].block_id
}

/** The `N. <@user>: P points · ⚡ B · a/b answered` lines of the final summary. */
function finalLeaderboard(blocks: any[]): string[] {
  const text: string = blocks[1].text.text

  return text.split('\n').slice(1)
}

/** A final summary line split into its parts, for bonuses that depend on timing. */
function parseEntry(line: string) {
  const match = /^(\d+)\. <@([^>]+)>: (\d+) points? · ⚡ (\d+\.\d\d) · (\d+\/\d+) answered$/.exec(line)

  if (!match) throw new Error(`Unexpected leaderboard line: ${line}`)
  const [, rank, userId, points, speedBonus, answered] = match

  return { rank: Number(rank), userId, points: Number(points), answered, speedBonus: Number(speedBonus) }
}

function frame(calls: { blocks: any[] }[], header: string): any[] {
  const call = calls.find((c) => headerText(c.blocks) === header)

  if (!call) throw new Error(`No frame ${header}`)

  return call.blocks
}

/** Sign a body the way Slack does, with the test binding's signing secret. */
async function sign(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  )

  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `v0=${hex}`
}

/** A signed POST to the events endpoint, the shape Slack dispatches to. */
async function slackRequest(body: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000).toString()

  return new Request(`https://example.com${SLACK_EVENTS_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': await sign(body, timestamp),
    },
    body,
  })
}

/** Slack's auth.test, called by the framework while authorizing a request. */
function interceptAuthTest() {
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/auth.test', method: 'POST' })
    .reply(200, { ok: true, team_id: 'T1', user_id: 'U0', bot_id: 'B0' })
}

describe('recording answers', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    slack.install()
  })

  beforeEach(() => {
    slack.reset()
  })

  it('scores a correct answer with a speed bonus, larger the faster it came', async () => {
    const stub = await start('C-ANSWER', `1 ${WINDOW}`, 1)
    const question = slack.calls[0].blocks
    const correct = optionValue(question, 'Correct 1')
    const now = Date.now()

    await stub.submitAnswer('U-FAST', correct, blockId(question), now)
    await stub.submitAnswer('U-SLOW', correct, blockId(question), now + 500)

    await waitForCalls(slack, 3)
    // Both earn the base point; the faster click earns the bigger bonus, so it
    // wins the tie and leads the board.
    const [fast, slow, ...rest] = finalLeaderboard(slack.lastBlocks).map(parseEntry)
    expect(rest).toEqual([])
    expect(fast).toMatchObject({ rank: 1, userId: 'U-FAST', points: 1, answered: '1/1' })
    expect(slow).toMatchObject({ rank: 2, userId: 'U-SLOW', points: 1, answered: '1/1' })
    expect(fast.speedBonus).toBeCloseTo(SPEED_BONUS_MAX, 1)
    expect(slow.speedBonus).toBeCloseTo(SPEED_BONUS_MAX / 2, 1)

    // The results leaderboard, shown before the summary, has them too, in
    // whole points.
    expect(frame(slack.calls, 'Answer 1/1:')[2].text.text).toContain(
      '1. <@U-FAST>: 1 point\n2. <@U-SLOW>: 1 point',
    )
  })

  it('still awards the base point for an answer after the answer window', async () => {
    const stub = await start('C-LATE-ANSWER', `1 ${WINDOW}`, 1)
    const question = slack.calls[0].blocks

    // Ten seconds into a one-second window: the bonus floors at zero rather
    // than going negative, and Slack delivery lag costs nothing else.
    await stub.submitAnswer(
      'U-LAGGED',
      optionValue(question, 'Correct 1'),
      blockId(question),
      Date.now() + 10_000,
    )

    await waitForCalls(slack, 3)
    expect(finalLeaderboard(slack.lastBlocks)).toEqual([
      '1. <@U-LAGGED>: 1 point · ⚡ 0.00 · 1/1 answered',
    ])
  })

  it('credits an answer to the question its block named, not the current one', async () => {
    const stub = await start('C-PRIOR', `2 ${WINDOW}`, 2)
    const question1 = slack.calls[0].blocks
    const correct1 = optionValue(question1, 'Correct 1')

    // Wait until the quiz has moved on, then deliver the click for question 1.
    await waitForCalls(slack, 3)
    expect(headerText(slack.calls[2].blocks)).toBe('Question 2/2:')
    await stub.submitAnswer('U-LATE', correct1, blockId(question1), Date.now())

    await waitForCalls(slack, 5)
    // Credited to question 1, where that answer ID is correct; had it landed on
    // question 2 it would have matched nothing and scored zero.
    expect(finalLeaderboard(slack.lastBlocks)).toEqual([
      '1. <@U-LATE>: 1 point · ⚡ 0.00 · 1/2 answered',
    ])
  })

  it('refunds the previous answer when a participant changes their mind', async () => {
    const stub = await start('C-CHANGE', `1 ${WINDOW}`, 1)
    const question = slack.calls[0].blocks
    const now = Date.now()

    await stub.submitAnswer('U-FICKLE', optionValue(question, 'Correct 1'), blockId(question), now)
    await stub.submitAnswer('U-FICKLE', optionValue(question, 'W1-1'), blockId(question), now)

    await waitForCalls(slack, 3)
    // Only the final choice counts: the point and bonus from the first pick are
    // refunded, and the change is not a second answer.
    expect(finalLeaderboard(slack.lastBlocks)).toEqual([
      '1. <@U-FICKLE>: 0 points · ⚡ 0.00 · 1/1 answered',
    ])
  })

  it('ignores and logs an answer that arrives after the quiz has finished', async () => {
    const stub = await start('C-FINISHED', `1 ${WINDOW}`, 1)
    const question = slack.calls[0].blocks

    await waitForCalls(slack, 3)
    const summaryBefore = slack.lastBlocks
    const log = vi.spyOn(console, 'log')

    await stub.submitAnswer(
      'U-TOO-LATE',
      optionValue(question, 'Correct 1'),
      blockId(question),
      Date.now(),
    )

    await sleep(200)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no running quiz'))
    log.mockRestore()

    // Nothing was re-rendered, and the last leaderboard Slack saw still has no
    // participants.
    expect(slack.calls).toHaveLength(3)
    expect(finalLeaderboard(summaryBefore)).toEqual(['No participants'])

    // The channel is free, and the ignored answer did not leak into a new quiz.
    interceptTrivia(createTriviaQuestions(1))

    const restart = await channelObject('C-FINISHED').startQuiz(
      'C-FINISHED',
      `1 ${LONG_WINDOW}`,
      COUNTDOWN_ORIGIN,
      SLACK_BOT_TOKEN,
    )

    expect(restart.ok).toBe(true)
  })

  it('records an answer dispatched as a signed Slack block_actions request', async () => {
    await start('C-DISPATCH', `1 ${WINDOW}`, 1)
    const question = slack.calls[0].blocks

    // Authorizing the incoming request calls Slack's auth.test itself; the
    // recorder's chat.* interceptors already cover everything else.
    interceptAuthTest()

    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U-CLICKER' },
      channel: { id: 'C-DISPATCH' },
      team: { id: 'T1' },
      trigger_id: '123.456.abc',
      response_url: 'https://hooks.slack.test/actions/T1/123/abc',
      api_app_id: 'A000',
      actions: [
        {
          type: 'radio_buttons',
          action_id: 'radio_sel',
          block_id: blockId(question),
          // Slack stamps the click time in seconds; the worker treats it as
          // the answer time so the bonus is not charged for delivery lag.
          action_ts: String(Date.now() / 1000),
          selected_option: { value: optionValue(question, 'Correct 1') },
        },
      ],
    })

    const ctx = createExecutionContext()

    const response = await worker.fetch(
      await slackRequest(new URLSearchParams({ payload }).toString()),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    await waitOnExecutionContext(ctx)

    await waitForCalls(slack, 3)
    // Stamped moments after the question went up, the click earns the base
    // point plus the near-max speed bonus.
    const [clicker, ...rest] = finalLeaderboard(slack.lastBlocks).map(parseEntry)
    expect(rest).toEqual([])
    expect(clicker).toMatchObject({ rank: 1, userId: 'U-CLICKER', points: 1, answered: '1/1' })
    expect(clicker.speedBonus).toBeCloseTo(SPEED_BONUS_MAX, 1)
  })
})
