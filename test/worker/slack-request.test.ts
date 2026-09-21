import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import worker, { SLACK_EVENTS_PATH } from '../../worker/index'

const RESPONSE_URL_ORIGIN = 'https://hooks.slack.test'
const RESPONSE_URL_PATH = '/commands/T1/123/abc'

function commandBody(text: string): string {
  return new URLSearchParams({
    command: '/quizzo',
    text,
    channel_id: 'C123',
    channel_name: 'trivia',
    user_id: 'U123',
    team_id: 'T1',
    response_url: `${RESPONSE_URL_ORIGIN}${RESPONSE_URL_PATH}`,
    trigger_id: '123.456.abc',
  }).toString()
}

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

async function slackRequest(body: string, signed = true): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signed) {
    headers['x-slack-request-timestamp'] = timestamp
    headers['x-slack-signature'] = await sign(body, timestamp)
  }
  return new Request(`https://example.com${SLACK_EVENTS_PATH}`, {
    method: 'POST',
    headers,
    body,
  })
}

/** Slack's auth.test, called while authorizing every incoming request. */
function interceptAuthTest() {
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/auth.test', method: 'POST' })
    .reply(200, { ok: true, team_id: 'T1', user_id: 'U0', bot_id: 'B0' })
}

/** The Trivia API request the DO makes when starting a quiz. */
function interceptTrivia(count: number) {
  const questions = Array.from({ length: count }, (_, i) => ({
    category: 'Test',
    id: `q${i + 1}`,
    correctAnswer: `Correct ${i + 1}`,
    incorrectAnswers: [`W1`, `W2`, `W3`],
    question: { text: `Question ${i + 1}?` },
    tags: ['test'],
    type: 'text_choice' as const,
    difficulty: 'easy' as const,
    regions: ['US'],
    isNiche: false,
  }))
  fetchMock
    .get('https://the-trivia-api.com')
    .intercept({ path: /^\/v2\/questions/, method: 'GET' })
    .reply(200, questions)
}

/** The chat.postMessage the DO calls to post the first question. */
function interceptPostMessage(ts = '1234567890.123') {
  fetchMock
    .get('https://slack.com')
    .intercept({ path: '/api/chat.postMessage', method: 'POST' })
    .reply(200, { ok: true, ts })
}

type Reply = { response_type?: string; text?: string }

/** Captures the one message the lazy listener posts back to response_url. */
function interceptResponseUrl(): () => Reply | undefined {
  let replied: Reply | undefined
  fetchMock
    .get(RESPONSE_URL_ORIGIN)
    .intercept({ path: RESPONSE_URL_PATH, method: 'POST' })
    .reply(200, (options) => {
      replied = JSON.parse(options.body as string)
      return 'ok'
    })
  return () => replied
}

describe('Slack request handling', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => fetchMock.assertNoPendingInterceptors())

  // Guards the isolation from local env files. A leaked key changes how the
  // app behaves (an app token turns on Socket Mode, which skips signature
  // verification) and can send live calls to Slack with real credentials.
  it('runs on the test credentials, never a local env file', () => {
    expect(env.SLACK_SIGNING_SECRET).toBe('test-signing-secret')
    expect(env.SLACK_BOT_TOKEN).toBe('xoxb-test-token')
    expect(env.SLACK_APP_TOKEN).toBeUndefined()
  })

  it('rejects an unsigned request', async () => {
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      await slackRequest(commandBody('3 10s'), false),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
  })

  it('rejects a request signed with the wrong secret', async () => {
    const body = commandBody('3 10s')
    const request = await slackRequest(body)
    request.headers.set('x-slack-signature', 'v0=deadbeef')

    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
  })

  it('acks /quizzo and starts a real quiz via the DO', async () => {
    interceptAuthTest()
    interceptTrivia(3)
    interceptPostMessage('1234567890.123')
    // No response_url interceptor—on success the Worker sends no ephemeral.

    const ctx = createExecutionContext()
    const response = await worker.fetch(
      await slackRequest(commandBody('3 10s')),
      env,
      ctx,
    )

    expect(response.status).toBe(200)

    await waitOnExecutionContext(ctx)
    // The lazy listener ran and completed; no response_url call is made on success.
  })

  it('replies with the parse error for a bad argument', async () => {
    interceptAuthTest()
    const replied = interceptResponseUrl()

    const ctx = createExecutionContext()
    const response = await worker.fetch(
      await slackRequest(commandBody('999 10s')),
      env,
      ctx,
    )
    expect(response.status).toBe(200)
    await waitOnExecutionContext(ctx)
    // The lazy listener fires after the ack via ctx.waitUntil(); give it time
    // to complete the context.respond() call to response_url.
    await new Promise((r) => setTimeout(r, 200))

    expect(replied()?.response_type).toBe('ephemeral')
    expect(replied()?.text).toContain('Invalid number of questions')
  })
})
