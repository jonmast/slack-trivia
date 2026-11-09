import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  COUNTDOWN_ORIGIN,
  POST_MESSAGE_TS,
  SLACK_AUTH_HEADERS,
  channelObject,
  createTriviaQuestions,
  interceptTrivia,
  parseSlackMessage,
  type SlackMessageBody,
} from './fixtures'

/**
 * Issue #8: `/quizzo` starts a quiz — the ChannelObject fetches trivia
 * questions and durably posts the ready screen to the channel. These tests
 * drive `ChannelObject.startQuiz()` over RPC and assert on what Slack
 * receives. (The `/quizzo` handler wiring itself lives in
 * slack-request.test.ts.)
 *
 * Outbound fetch is faked with `fetchMock` and net connect stays disabled,
 * so any unmocked request fails the test instead of reaching the network.
 */

/** The `chat.postMessage` response body; `ts` is absent when the post fails. */
type PostMessageReply = { ok: boolean; ts?: string }

let postedBodies: SlackMessageBody[] = []

/** One chat.postMessage reply per call; request bodies collect in `postedBodies`. */
function interceptPostMessage(reply: PostMessageReply = { ok: true, ts: POST_MESSAGE_TS }): void {
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/chat.postMessage', method: 'POST', headers: SLACK_AUTH_HEADERS })
    .reply(200, (options) => {
      postedBodies.push(parseSlackMessage(options.body))

      return reply
    })
}

/** The countdown GIF URL the question message links from its context block. */
function countdownUrl(origin: string, secs: number, questionId: string): string {
  return `${origin.replace(/\/$/, '')}/countdown/${secs}.gif?q=${questionId}`
}

/** Matches the `READY_SECS` worker test binding in vitest.config.ts. */
const READY_SECS = 1

/**
 * Assert the ready screen a quiz opens on (`renderChannelReady` output): a
 * header, what the quiz will be, and the countdown to the first question.
 * The first question itself replaces it on the ready alarm; see
 * alarm-progression.test.ts.
 */
function expectReadyBlocks(
  blocks: any[],
  firstQuestionId: string,
  origin: string,
  timeoutSecs: number,
): void {
  expect(blocks).toHaveLength(3)

  expect(blocks[0]).toEqual({
    type: 'header',
    text: { type: 'plain_text', text: 'Get ready!' },
  })

  expect(blocks[1]).toEqual({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🧠 *Trivia time!*\n\n3 questions, ${timeoutSecs} seconds each. Answer fast for a speed bonus.`,
    },
  })

  expect(blocks[2]).toEqual({
    type: 'context',
    elements: [
      {
        type: 'image',
        image_url: countdownUrl(origin, READY_SECS, `${firstQuestionId}-ready`),
        alt_text: `${READY_SECS} second countdown`,
      },
      { type: 'mrkdwn', text: `⏭️ First question in ${READY_SECS} seconds` },
    ],
  })
}

describe('ChannelObject.startQuiz', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  beforeEach(() => {
    postedBodies = []
  })

  // Catches leaked mocks: every interceptor registered in a test must match
  // exactly the requests the test expects.
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
  })

  it('starts a quiz and posts the ready screen', async () => {
    const questions = createTriviaQuestions(3)
    interceptTrivia(questions)
    interceptPostMessage()

    const result = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(result.ok).toBe(true)
    expect(result.text).toBe('Quiz started!')
    expect(result.messageTs).toBe(POST_MESSAGE_TS)

    const posted = postedBodies[0]
    expect(posted).toBeDefined()
    expect(posted.channel).toBe('C1')
    expectReadyBlocks(posted.blocks, questions[0].id, COUNTDOWN_ORIGIN, 10)
  })

  it('refuses a second quiz while one is running in the channel', async () => {
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()

    const first = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(first.ok).toBe(true)

    // No new interceptors: a running quiz is refused before any fetch, so a
    // trivia/Slack call here would fail loudly (net connect is disabled).
    const second = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(second.ok).toBe(false)
    expect(second.text).toMatch(/already running/i)
  })

  it('fails the start when the trivia API returns too few questions', async () => {
    interceptTrivia(createTriviaQuestions(2)) // the quiz asked for 3

    const result = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/trivia/i)

    // No chat.postMessage interceptor was registered: a stray post would throw
    // instead of being answered, so this also proves Slack was never called.
    expect(postedBodies).toHaveLength(0)
  })

  it('fails the start when chat.postMessage fails, leaving no quiz running', async () => {
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage({ ok: false })

    const result = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/post/i)

    // Cleanup: the failed start must not leave a quiz running, so a fresh
    // start in the same channel succeeds.
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()

    const retry = await channelObject('C1').startQuiz(
      'C1',
      '3 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(retry.ok).toBe(true)
    expect(retry.messageTs).toBe(POST_MESSAGE_TS)
  })

  it('returns the parse error for a bad argument', async () => {
    const result = await channelObject('C1').startQuiz(
      'C1',
      '999 10s',
      COUNTDOWN_ORIGIN,
    )

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Invalid number of questions')
    expect(postedBodies).toHaveLength(0)
  })

  it('defaults to 3 questions with a 5s answer window when no arguments are given', async () => {
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()

    const result = await channelObject('C1').startQuiz('C1', '', COUNTDOWN_ORIGIN)

    expect(result.ok).toBe(true)
    expect(result.text).toBe('Quiz started!')
    expectReadyBlocks(postedBodies[0].blocks, 'q-1', COUNTDOWN_ORIGIN, 5)
  })

  it('derives the countdown URL from the origin argument', async () => {
    const firstOrigin = 'https://countdown.one.example.com'
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()
    await channelObject('C7A').startQuiz('C7A', '3 10s', firstOrigin)

    // A trailing slash on the origin is tolerated.
    const secondOrigin = 'https://countdown.two.example.com/'
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()
    await channelObject('C7B').startQuiz('C7B', '3 10s', secondOrigin)

    expect(postedBodies[0].blocks[2].elements[0].image_url).toBe(
      countdownUrl(firstOrigin, READY_SECS, 'q-1-ready'),
    )
    expect(postedBodies[1].blocks[2].elements[0].image_url).toBe(
      countdownUrl(secondOrigin, READY_SECS, 'q-1-ready'),
    )
  })

  it('keeps quizzes isolated per channel', async () => {
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()
    const first = await channelObject('C8A').startQuiz('C8A', '3 10s', COUNTDOWN_ORIGIN)

    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()
    const second = await channelObject('C8B').startQuiz('C8B', '3 10s', COUNTDOWN_ORIGIN)

    expect(first.ok).toBe(true)
    expect(first.messageTs).toBe(POST_MESSAGE_TS)
    expect(second.ok).toBe(true)
    expect(second.messageTs).toBe(POST_MESSAGE_TS)
  })

  it('keeps the running quiz on the channel object after a successful start', async () => {
    interceptTrivia(createTriviaQuestions(3))
    interceptPostMessage()

    const result = await channelObject('C1').startQuiz('C1', '2 10s', COUNTDOWN_ORIGIN)

    expect(result.ok).toBe(true)
    expect(result.messageTs).toBe(POST_MESSAGE_TS)

    // The object remembered its channel and still hosts the running quiz — a
    // second start is refused while it runs (see the refusals test above).
    expect(await channelObject('C1').getChannelId()).toBe('C1')
  })
})