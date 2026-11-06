import { fetchMock } from 'cloudflare:test'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import {
  COUNTDOWN_ORIGIN,
  POST_MESSAGE_TS,
  SLACK_BOT_TOKEN,
  channelObject,
  createTriviaQuestions,
  interceptTrivia,
} from './fixtures'

function interceptPostMessage(ts = POST_MESSAGE_TS) {
  let body: Record<string, unknown> | undefined
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/chat.postMessage', method: 'POST' })
    .reply(200, (opts) => {
      body = JSON.parse(opts.body as string)

      return { ok: true, ts }
    })

  return () => body
}

describe('ChannelObject.startQuiz', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => fetchMock.assertNoPendingInterceptors())

  it('parses args, posts the first question, and stores a running quiz', async () => {
    interceptTrivia(createTriviaQuestions(3))
    const getBody = interceptPostMessage(POST_MESSAGE_TS)

    const result = await channelObject('C1').startQuiz('C1', '3 10s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(true)
    expect(result.text).toBe('Quiz started!')
    expect(result.messageTs).toBe(POST_MESSAGE_TS)

    // chat.postMessage should have been called with valid blocks.
    const body = getBody()!
    expect(body.channel).toBe('C1')
    expect(Array.isArray(body.blocks)).toBe(true)
    const blocks = body.blocks as any[]
    expect(blocks).toHaveLength(3)
    // Header: Question 1/3:
    expect(blocks[0].type).toBe('header')
    expect(blocks[0].text.text).toBe('Question 1/3:')
    // Section: radio buttons with question ID as block_id
    expect(blocks[1].type).toBe('section')
    expect(blocks[1].block_id).toBe('q-1')
    expect(blocks[1].accessory.type).toBe('radio_buttons')
    expect(blocks[1].accessory.action_id).toBe('radio_sel')
    expect(blocks[1].accessory.options).toHaveLength(4)
    // Context: countdown GIF derived from origin
    expect(blocks[2].type).toBe('context')
    expect(blocks[2].elements[0].type).toBe('image')
    expect(blocks[2].elements[0].image_url).toMatch(/^https:\/\/example\.com\/countdown\/10\.gif\?q=/)
  })

  it('defaults to 3 questions and 5s when no args are given', async () => {
    interceptTrivia(createTriviaQuestions(3))
    const getBody = interceptPostMessage('1234567890.0002')

    const result = await channelObject('C1').startQuiz('C1', '', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(true)
    const body = getBody()!
    const blocks = body.blocks as any[]
    expect(blocks[0].text.text).toBe('Question 1/3:')
    // Default 5s countdown
    expect(blocks[2].elements[0].image_url).toMatch(/countdown\/5\.gif/)
  })

  it('returns the parse error for bad arguments', async () => {
    const result = await channelObject('C1').startQuiz('C1', '999 10s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Invalid number of questions')
  })

  it('refuses a second start while a quiz is running', async () => {
    interceptTrivia(createTriviaQuestions(1))
    interceptPostMessage('1111')

    await channelObject('C2').startQuiz('C2', '1 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    // Second call without intercepting new trivia/postMessage – should not fetch.
    const result = await channelObject('C2').startQuiz('C2', '1 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('already running')
  })

  it('fails when the Trivia API returns fewer questions than requested', async () => {
    interceptTrivia(createTriviaQuestions(1)) // request 3, get 1

    const result = await channelObject('C3').startQuiz('C3', '3 10s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Could not load enough trivia questions')
    // No chat.postMessage should have been attempted.
  })

  it('releases the channel when chat.postMessage fails', async () => {
    interceptTrivia(createTriviaQuestions(2))
    fetchMock
      .get('https://slack.com')
      .intercept({ path: '/api/chat.postMessage', method: 'POST' })
      .reply(200, { ok: false, error: 'channel_not_found' })

    const result = await channelObject('C4').startQuiz('C4', '2 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Failed to post')

    // Channel should not be locked: a second start is accepted.
    interceptTrivia(createTriviaQuestions(1))
    interceptPostMessage('2222')
    const retry = await channelObject('C4').startQuiz('C4', '1 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)
    expect(retry.ok).toBe(true)
  })

  it('derives the countdown GIF URL from the request origin', async () => {
    interceptTrivia(createTriviaQuestions(1))
    const getBody = interceptPostMessage('3333')

    await channelObject('C5').startQuiz('C5', '1 5s', 'https://trivia.app', SLACK_BOT_TOKEN)

    const body = getBody()!
    const blocks = body.blocks as any[]
    expect(blocks[2].elements[0].image_url).toMatch(/^https:\/\/trivia\.app\/countdown\/5\.gif/)
  })

  it('isolates quizzes across channels', async () => {
    interceptTrivia(createTriviaQuestions(1))
    interceptPostMessage('aaa')
    await channelObject('CA').startQuiz('CA', '1 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    interceptTrivia(createTriviaQuestions(1))
    interceptPostMessage('bbb')
    await channelObject('CB').startQuiz('CB', '1 5s', COUNTDOWN_ORIGIN, SLACK_BOT_TOKEN)

    expect(await channelObject('CA').hasRunningQuiz()).toBe(true)
    expect(await channelObject('CB').hasRunningQuiz()).toBe(true)
  })
})
