import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, it, expect, beforeAll } from "vitest"
import worker, { SLACK_EVENTS_PATH } from '../../worker/index'
import type { TriviaQuestion } from '../../src/trivia-core'
import { renderRecapModal } from '../../src/slack-ui'
import {
  SlackRecorder,
  channelObject,
  createTriviaQuestions,
  interceptTrivia,
  parseSlackResponse,
  requestBodyText,
  slackRequest,
  waitForCalls,
  COUNTDOWN_ORIGIN,
  SLACK_BOT_TOKEN,
  type SlackResponse,
} from './fixtures'

/**
 * Issue #11: the Recap button on any final summary keeps working, and opens
 * the quiz that summary belongs to.
 *
 * Everything is asserted on what Slack receives: the modal sent to
 * `views.open`, or the ephemeral text sent to the button's response_url.
 */

const CHANNEL = 'C-RECAP'
const PARTICIPANT = 'U-PLAYER'
const BYSTANDER = 'U-WATCHER'
const RESPONSE_URL_ORIGIN = 'https://hooks.slack.test'
const RESPONSE_URL_PATH = '/actions/T1/123/abc'

const slack = new SlackRecorder()

/** Questions whose text names the quiz, so a recap can only match one of them. */
function questionsFor(label: string, count: number): TriviaQuestion[] {
  return createTriviaQuestions(count, label).map((question) => ({
    ...question,
    question: { text: `${label} question ${question.id}?` },
  }))
}

function recapButtonValue(blocks: any[]): string | undefined {
  return blocks.find((block) => block.type === 'actions')?.elements?.[0]?.value
}

/** The option the participant should click to be right. */
function correctOption(postedBlocks: any[]): string {
  const options = postedBlocks[1].accessory.options

  return options.find((option: any) => option.text.text.startsWith('Correct')).value
}

/**
 * Run a one-question quiz in the channel to completion, with the participant
 * answering it, and return the timestamp its final summary carries.
 */
async function playQuiz(label: string): Promise<string> {
  const before = slack.calls.length
  interceptTrivia(questionsFor(label, 1))
  const stub = channelObject(CHANNEL)
  const started = await stub.startQuiz(CHANNEL, '1 2s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)
  expect(started.ok).toBe(true)

  const posted = slack.calls[before]
  await stub.submitAnswer(
    PARTICIPANT,
    correctOption(posted.blocks),
    posted.blocks[1].block_id,
    Date.now(),
  )

  // question posted, results, final summary
  await waitForCalls(slack, before + 3)
  const summary = slack.calls[before + 2]
  const messageTs = recapButtonValue(summary.blocks)
  expect(messageTs).toBeTruthy()

  return messageTs!
}

function actionBody(userId: string, messageTs: string): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: userId },
      api_app_id: 'A1',
      channel: { id: CHANNEL, name: 'trivia' },
      trigger_id: '123.456.abc',
      response_url: `${RESPONSE_URL_ORIGIN}${RESPONSE_URL_PATH}`,
      actions: [
        {
          type: 'button',
          action_id: 'recap',
          block_id: 'summary',
          value: messageTs,
          action_ts: `${Date.now() / 1000}`,
        },
      ],
    }),
  }).toString()
}

type Opened = { trigger_id?: string; view?: any }

let opened: Opened | undefined
let replied: SlackResponse | undefined

/**
 * Capture whatever a Recap click produces. The interceptors persist for the
 * file: a fresh one per click would sit unconsumed and swallow a later test's
 * call instead.
 */
function interceptClicks(): void {
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/auth.test', method: 'POST' })
    .reply(200, { ok: true, team_id: 'T1', user_id: 'U0', bot_id: 'B0' })
    .persist()
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/views.open', method: 'POST' })
    .reply(200, (options) => {
      // The Workers Slack client posts form-encoded arguments.
      const form = new URLSearchParams(requestBodyText(options.body))
      opened = {
        trigger_id: form.get('trigger_id') ?? undefined,
        view: JSON.parse(form.get('view') ?? 'null'),
      }

      return { ok: true }
    })
    .persist()
  fetchMock
    .get(RESPONSE_URL_ORIGIN)
    .intercept({ path: RESPONSE_URL_PATH, method: 'POST' })
    .reply(200, (options) => {
      replied = parseSlackResponse(options.body)

      return 'ok'
    })
    .persist()
}

/** Click a Recap button and return whatever Slack got back. */
async function clickRecap(userId: string, messageTs: string) {
  opened = undefined
  replied = undefined
  const ctx = createExecutionContext()

  const response = await worker.fetch(
    await slackRequest(SLACK_EVENTS_PATH, actionBody(userId, messageTs)),
    env,
    ctx,
  )

  expect(response.status).toBe(200)
  await waitOnExecutionContext(ctx)

  return { modal: () => opened, ephemeral: () => replied }
}

/** The question lines of a recap modal. */
function recapLines(view: any): string[] {
  return view.blocks
    .filter((block: any) => block.type === 'section')
    .map((block: any) => block.text.text)
}

describe('recap button', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
    slack.install()
    interceptClicks()
  })

  it('opens the right quiz for each summary, forever', async () => {
    // Two quizzes really played to completion in the same channel.
    const olderTs = await playQuiz('Older')
    const newerTs = await playQuiz('Newer')
    expect(olderTs).not.toBe(newerTs)

    const newer = await clickRecap(PARTICIPANT, newerTs)
    expect(newer.modal()?.trigger_id).toBe('123.456.abc')
    expect(newer.modal()?.view.type).toBe('modal')
    expect(newer.modal()?.view.title.text).toBe('Your recap')
    expect(recapLines(newer.modal()?.view).join('\n')).toContain(
      'Newer question Newer-1?',
    )

    // The older summary's button opens the older quiz, not the newer one.
    const older = await clickRecap(PARTICIPANT, olderTs)
    const lines = recapLines(older.modal()?.view).join('\n')
    expect(lines).toContain('Older question Older-1?')
    expect(lines).not.toContain('Newer question')
    // The participant answered correctly in both, so both recaps say so.
    expect(lines).toContain('✅ Correct 1')
    expect(older.ephemeral()).toBeUndefined()

    // ...and it is the existing recap renderer's modal, unchanged.
    const recap = await channelObject(CHANNEL).getRecap(PARTICIPANT, olderTs)
    expect(older.modal()?.view).toEqual(JSON.parse(JSON.stringify(renderRecapModal(recap!))))
  })

  it('tells a non-participant the recap is no longer available', async () => {
    const messageTs = await playQuiz('Solo')

    const clicked = await clickRecap(BYSTANDER, messageTs)

    expect(clicked.modal()).toBeUndefined()
    expect(clicked.ephemeral()?.response_type).toBe('ephemeral')
    expect(clicked.ephemeral()?.text).toBe("That quiz's recap is no longer available.")
  })

  it('tells a participant with an unknown message timestamp the same', async () => {
    await playQuiz('Known')

    const clicked = await clickRecap(PARTICIPANT, '1111111111.9999')

    expect(clicked.modal()).toBeUndefined()
    expect(clicked.ephemeral()?.text).toBe("That quiz's recap is no longer available.")
  })
})
