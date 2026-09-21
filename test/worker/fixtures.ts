import { env, fetchMock } from 'cloudflare:test'
import type { TriviaQuestion } from '../../src/trivia-core'

/** Shared plumbing for worker tests: the channel stub and the fake Slack/Trivia network. */

export const SLACK_BOT_TOKEN = 'xoxb-test-token'
export const COUNTDOWN_ORIGIN = 'https://example.com'
export const POST_MESSAGE_TS = '1234567890.0001'

export function channelObject(channelId: string) {
  return env.CHANNEL_OBJECT.get(env.CHANNEL_OBJECT.idFromName(channelId))
}

/** Questions as the Trivia API returns them; ids are `q-1`, `q-2`, ... */
export function createTriviaQuestions(count: number, prefix = 'q'): TriviaQuestion[] {
  return Array.from({ length: count }, (_, i) => ({
    category: 'Test',
    id: `${prefix}-${i + 1}`,
    correctAnswer: `Correct ${i + 1}`,
    incorrectAnswers: [`W1-${i + 1}`, `W2-${i + 1}`, `W3-${i + 1}`],
    question: { text: `Question ${i + 1}?` },
    tags: ['test'],
    type: 'text_choice',
    difficulty: 'easy',
    regions: ['US'],
    isNiche: false,
  }))
}

export type SlackCall = {
  method: 'chat.postMessage' | 'chat.update'
  channel: string
  ts?: string
  text: string
  blocks: any[]
}

/**
 * Records every Slack call the object makes, so tests assert on what Slack
 * receives rather than on storage. `failUpdate` lets a test reject a specific
 * edit (a message that can no longer be updated).
 */
export class SlackRecorder {
  calls: SlackCall[] = []
  /** Return a Slack error string to reject the edit, or null to accept it. */
  failUpdate: (call: SlackCall) => string | null = () => null
  /** Return an HTTP status to fail the edit at the transport level. */
  failHttp: (call: SlackCall) => number | null = () => null
  private posted = 0

  /** Forget what a previous test sent, keeping the interceptors in place. */
  reset(): void {
    this.calls = []
    this.posted = 0
    this.failUpdate = () => null
    this.failHttp = () => null
  }

  get updates(): SlackCall[] {
    return this.calls.filter((call) => call.method === 'chat.update')
  }

  get lastBlocks(): any[] {
    return this.calls[this.calls.length - 1].blocks
  }

  /**
   * Intercept Slack for the rest of the test. The Trivia API is intercepted
   * per start, since each quiz fetches its own questions.
   */
  install(): void {
    fetchMock
      .get('https://slack.com')
      .intercept({ path: '/api/chat.postMessage', method: 'POST' })
      .reply(200, (options) => {
        const body = JSON.parse(options.body as string)
        this.calls.push({ method: 'chat.postMessage', ...body })
        // Slack never reuses a timestamp; the first post gets POST_MESSAGE_TS.
        this.posted += 1
        return { ok: true, ts: this.posted === 1 ? POST_MESSAGE_TS : `1234567890.000${this.posted}` }
      })
      .persist()

    fetchMock
      .get('https://slack.com')
      .intercept({ path: '/api/chat.update', method: 'POST' })
      .reply((options) => {
        const body = JSON.parse(options.body as string)
        const call: SlackCall = { method: 'chat.update', ...body }
        this.calls.push(call)

        const status = this.failHttp(call)
        if (status) {
          return { statusCode: status, data: 'rate limited' }
        }
        const error = this.failUpdate(call)
        return { statusCode: 200, data: error ? { ok: false, error } : { ok: true } }
      })
      .persist()
  }
}

/** One trivia fetch; the worker asks for `/v2/questions?limit=N`. */
export function interceptTrivia(questions: TriviaQuestion[]): void {
  fetchMock
    .get('https://the-trivia-api.com')
    .intercept({ path: /^\/v2\/questions/, method: 'GET' })
    .reply(200, questions)
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until Slack has received `count` calls, or fail the test. */
export async function waitForCalls(
  recorder: SlackRecorder,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (recorder.calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} Slack calls; got ${recorder.calls.length}: ` +
          recorder.calls.map((call) => call.text).join(' | '),
      )
    }
    await sleep(25)
  }
}

/** Header text of a channel frame, e.g. `Question 2/3:` or `Answer 1/3:`. */
export function headerText(blocks: any[]): string | undefined {
  return blocks.find((block) => block.type === 'header')?.text?.text
}
