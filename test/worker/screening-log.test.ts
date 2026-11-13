import { describe, it, expect, vi } from 'vitest'
import { Effect, Layer } from 'effect'
import { WorkerLogger } from '../../worker/logger'
import { ScreeningDatabase, ScreeningLog } from '../../worker/screening-log'
import type { Verdict } from '../../worker/screening'

/** Issue #16: recording verdicts never fails, whatever state D1 is in. */

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
  it('logs a missing DB binding as a failed record', async () => {
    const error = vi.spyOn(console, 'error')

    await record(undefined)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('The DB binding is missing'))
    error.mockRestore()
  })
})
