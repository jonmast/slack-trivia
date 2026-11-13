import { env } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { Effect, Layer } from 'effect'
import { WorkerLogger } from '../../worker/logger'
import { ScreeningDatabase, ScreeningLog } from '../../worker/screening-log'
import type { Verdict } from '../../worker/screening'

/**
 * Issue #16: recording verdicts never holds up a quiz. The channel object
 * awaits the record after saving the quiz, so a D1 that never answers must
 * not hold the record up for long either.
 */

const QUIZ = { channelId: 'C-LOG', messageTs: '1234567890.0001' }

const VERDICT: Verdict = {
  question: {
    id: 'q-1',
    correctAnswer: 'Correct',
    incorrectAnswers: ['W1', 'W2', 'W3'],
    question: { text: 'Question?' },
  },
  outcome: 'unscreened',
  screeningClass: null,
  probabilities: null,
  model: null,
}

function record(db: D1Database | undefined): Promise<void> {
  return Effect.runPromise(
    ScreeningLog.use((log) => log.record(QUIZ, [VERDICT])).pipe(
      Effect.provide(
        Layer.mergeAll(
          ScreeningLog.layer.pipe(Layer.provide(Layer.succeed(ScreeningDatabase)(db))),
          WorkerLogger,
        ),
      ),
    ),
  )
}

describe('ScreeningLog', () => {
  it('gives up on a D1 that never answers after a few seconds', async () => {
    const hung: Pick<D1Database, 'prepare' | 'batch'> = {
      prepare: (query) => env.DB.prepare(query),
      batch: () => new Promise(() => {}),
    }

    const error = vi.spyOn(console, 'error')
    const started = Date.now()

    // SAFETY: ScreeningLog only ever calls `prepare` and `batch`.
    await record(hung as D1Database)

    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to record screening verdicts'))
    error.mockRestore()
  })

  it('logs a missing DB binding as a failed record', async () => {
    const error = vi.spyOn(console, 'error')

    await record(undefined)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('The DB binding is missing'))
    error.mockRestore()
  })
})
