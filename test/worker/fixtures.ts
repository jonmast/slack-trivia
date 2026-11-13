import { env, fetchMock } from 'cloudflare:test'
import { Schema } from 'effect'
import type { TriviaQuestion } from '../../src/trivia-core'
import { SCREENING_CLASSES } from '../../worker/screening'

/** Shared plumbing for worker tests: the channel stub and the fake Slack/Trivia network. */

export const COUNTDOWN_ORIGIN = 'https://example.com'
export const POST_MESSAGE_TS = '1234567890.0001'

export function channelObject(channelId: string) {
  return env.CHANNEL_OBJECT.get(env.CHANNEL_OBJECT.idFromName(channelId))
}

/**
 * A question as the Trivia API sends it: the fields the app reads, plus the
 * ones decoding drops.
 */
export type TriviaApiQuestion = TriviaQuestion & {
  category: string
  tags: string[]
  type: string
  difficulty: string
  regions: string[]
  isNiche: boolean
}

/** Questions as the Trivia API returns them; ids are `q-1`, `q-2`, ... */
export function createTriviaQuestions(count: number, prefix = 'q'): TriviaApiQuestion[] {
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

/** A `chat.postMessage` or `chat.update` body, as Slack receives it. */
export type SlackMessageBody = {
  channel: string
  text: string
  ts?: string
  /** Left loose: tests reach deep into whichever block they check. */
  blocks: any[]
}

export type SlackCall = SlackMessageBody & {
  method: 'chat.postMessage' | 'chat.update'
}

/** A reply the Worker posts to a command's or button's `response_url`. */
export type SlackResponse = {
  response_type?: string
  replace_original?: boolean
  text?: string
}

/** The bot token the test bindings configure, as every Web API call must carry it. */
export const SLACK_AUTH_HEADERS = { authorization: 'Bearer xoxb-test-token' }

/**
 * The text of a request body captured by `fetchMock`. Whatever the Worker
 * sent — Effect's HttpClient sends JSON as a `Uint8Array`, the Slack framework
 * form-encodes — vitest-pool-workers buffers it and hands reply callbacks the
 * decoded text; this fails if that ever changes.
 */
export function requestBodyText(body: BodyInit | undefined): string {
  return Schema.decodeUnknownSync(Schema.String)(body)
}

const decodeSlackMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.String,
      text: Schema.String,
      ts: Schema.optional(Schema.String),
      blocks: Schema.Array(Schema.Unknown),
    }),
  ),
)

const decodeSlackResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      response_type: Schema.optional(Schema.String),
      replace_original: Schema.optional(Schema.Boolean),
      text: Schema.optional(Schema.String),
    }),
  ),
)

/** Parse the JSON body the Worker posts to `chat.postMessage`/`chat.update`. */
export function parseSlackMessage(body: BodyInit | undefined): SlackMessageBody {
  const message = decodeSlackMessage(requestBodyText(body))

  return { ...message, blocks: [...message.blocks] }
}

/** Parse the reply the Worker posts to a `response_url`. */
export function parseSlackResponse(body: BodyInit | undefined): SlackResponse {
  return decodeSlackResponse(requestBodyText(body))
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
      .intercept({ path: '/api/chat.postMessage', method: 'POST', headers: SLACK_AUTH_HEADERS })
      .reply(200, (options) => {
        const body = parseSlackMessage(options.body)
        this.calls.push({ method: 'chat.postMessage', ...body })
        // Slack never reuses a timestamp; the first post gets POST_MESSAGE_TS.
        this.posted += 1

        return { ok: true, ts: this.posted === 1 ? POST_MESSAGE_TS : `1234567890.000${this.posted}` }
      })
      .persist()

    fetchMock
      .get('https://slack.com')
      .intercept({ path: '/api/chat.update', method: 'POST', headers: SLACK_AUTH_HEADERS })
      .reply((options) => {
        const body = parseSlackMessage(options.body)
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
export function interceptTrivia(questions: TriviaApiQuestion[]): void {
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

/** Sign a body the way Slack does, so the worker's verification accepts it. */
export async function signSlackBody(body: string, timestamp: string): Promise<string> {
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

/** A request to the worker's Slack events path, signed unless told otherwise. */
export async function slackRequest(
  path: string,
  body: string,
  signed = true,
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
  })

  if (signed) {
    headers.set('x-slack-request-timestamp', timestamp)
    headers.set('x-slack-signature', await signSlackBody(body, timestamp))
  }

  return new Request(`${COUNTDOWN_ORIGIN}${path}`, { method: 'POST', headers, body })
}

/** Header text of a channel frame, e.g. `Question 2/3:` or `Answer 1/3:`. */
export function headerText(blocks: any[]): string | undefined {
  return blocks.find((block) => block.type === 'header')?.text?.text
}

export const JEV_ORIGIN = 'https://opencode.ai'
export const JEV_PATH = '/inference/systemone/v1/systemone'

/** The OpenCode key the test bindings configure, as every Jev call must carry it. */
export const JEV_AUTH_HEADERS = { authorization: 'Bearer test-opencode-key' }

export type ScreeningClassName = 'good' | 'misleading' | 'garbled' | 'stale' | 'giveaway'

/** A verdict as a test states it: classes by name, not by Jev's wire IDs. */
export type JevVerdict = {
  choice: ScreeningClassName
  probabilities: Partial<Record<ScreeningClassName, number>>
}

/** `choice` at probability `p`, the rest shared evenly among the other classes. */
export function verdict(choice: ScreeningClassName, p: number): JevVerdict {
  const others = SCREENING_CLASSES.filter(({ name }) => name !== choice)

  return {
    choice,
    probabilities: Object.fromEntries([
      [choice, p],
      ...others.map(({ name }) => [name, (1 - p) / others.length]),
    ]),
  }
}

const decodeJevRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      state: Schema.Struct({
        purpose: Schema.String,
        classes: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
      }),
      questions: Schema.Record(
        Schema.String,
        Schema.Struct({
          type: Schema.Literal('choice'),
          instructions: Schema.Struct({
            task: Schema.String,
            item: Schema.Struct({ text: Schema.String }),
          }),
          criteria: Schema.Record(Schema.String, Schema.Null),
        }),
      ),
    }),
  ),
)

export type JevRequest = ReturnType<typeof decodeJevRequest>

/** The question ID a screening item is about; `TriviaFake` puts it in the question text. */
export function itemQuestionId(item: string): string {
  const match = /^Question: Question (\S+)\?$/m.exec(item)

  if (!match) throw new Error(`No question ID in screening item: ${item}`)

  return match[1]
}

/**
 * Jev, answering every screening request for the rest of the file. `judge`
 * gives each item's verdict by its text, or undefined to leave it
 * unanswered; it is reset to passing everything between tests.
 */
export class JevFake {
  requests: JevRequest[] = []
  judge: (item: string) => JevVerdict | undefined = () => verdict('good', 0.95)

  reset(): void {
    this.requests = []
    this.judge = () => verdict('good', 0.95)
  }

  /** Every item Jev was asked about, across all requests, in order. */
  get items(): string[] {
    return this.requests.flatMap((request) =>
      Object.values(request.questions).map((question) => question.instructions.item.text),
    )
  }

  install(): void {
    fetchMock
      .get(JEV_ORIGIN)
      .intercept({ path: JEV_PATH, method: 'POST', headers: JEV_AUTH_HEADERS })
      .reply(200, (options) => {
        const request = decodeJevRequest(requestBodyText(options.body))
        this.requests.push(request)

        // Classes are matched by description, so the fake is blind to how
        // the worker numbers them.
        const idOf = (name: string) => {
          const { description } = SCREENING_CLASSES.find((c) => c.name === name)!

          return request.state.classes.find((c) => c.description === description)!.id
        }

        const answers = Object.entries(request.questions).flatMap(([key, question]) => {
          const judged = this.judge(question.instructions.item.text)

          if (!judged) return []

          const probabilities = Object.fromEntries(
            Object.entries(judged.probabilities).map(([name, p]) => [idOf(name), p]),
          )

          return [[key, { type: 'choice', choice: idOf(judged.choice), confidence: 0.9, probabilities }]]
        })

        return {
          model: request.model,
          answers: Object.fromEntries(answers),
          usage: { input_tokens: 100, output_tokens: 10 },
        }
      })
      .persist()
  }
}

/** A `screenings` row as D1 stores it. */
export type ScreeningRow = {
  question_id: string
  channel_id: string
  message_ts: string
  question: string
  options: string
  correct_answer: string
  outcome: string
  class: string | null
  probabilities: string | null
  model: string | null
  screened_at: string
}

/** Every verdict recorded for a channel's quizzes, in the order they were written. */
export async function screeningRows(channelId: string): Promise<ScreeningRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM screenings WHERE channel_id = ? ORDER BY id',
  )
    .bind(channelId)
    .all<ScreeningRow>()

  return results
}
