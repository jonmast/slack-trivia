import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import {
  Quiz,
  SPEED_BONUS_MAX,
  parseQuizzoArgs,
  InvalidQuizzoArgsError,
  MAX_QUESTIONS,
  MAX_TIMEOUT_SECS,
  type QuestionSource,
} from '../src/trivia-core'
import { createQuestionSource, failureOf } from './test-utils'

describe('parseQuizzoArgs', () => {
  it('defaults to 3 questions / 5s', () => {
    expect(Effect.runSync(parseQuizzoArgs(''))).toEqual({ numQuestions: 3, timeoutSecs: 5 })
    expect(Effect.runSync(parseQuizzoArgs('   '))).toEqual({ numQuestions: 3, timeoutSecs: 5 })
  })

  it('parses question count and timeout', () => {
    expect(Effect.runSync(parseQuizzoArgs('5 10s'))).toEqual({ numQuestions: 5, timeoutSecs: 10 })
    expect(Effect.runSync(parseQuizzoArgs(' 7 '))).toEqual({ numQuestions: 7, timeoutSecs: 5 })
  })

  it('rejects bad question counts', () => {
    for (const text of ['0', '21', 'abc', '2.5', `${MAX_QUESTIONS + 1}`]) {
      const error = failureOf(parseQuizzoArgs(text))
      expect(error, text).toBeInstanceOf(InvalidQuizzoArgsError)
      expect(error.message, text).toContain('Invalid number of questions')
    }
  })

  it('rejects bad timeouts', () => {
    const noSuffix = failureOf(parseQuizzoArgs('3 10'))
    expect(noSuffix).toBeInstanceOf(InvalidQuizzoArgsError)
    expect(noSuffix.message).toContain("suffixed with 's'")

    for (const text of ['3 0s', `3 ${MAX_TIMEOUT_SECS + 1}s`]) {
      const error = failureOf(parseQuizzoArgs(text))
      expect(error, text).toBeInstanceOf(InvalidQuizzoArgsError)
      expect(error.message, text).toContain('Invalid timeout')
    }
  })
})

describe('Quiz answer rules', () => {
  let store: QuestionSource

  beforeEach(() => {
    store = createQuestionSource()
  })

  it('credits a late answer with the base point and no bonus', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = Effect.runSync(quiz.startQuiz())
    const late = new Date(q.timestamp.getTime() + 10_001)
    expect(Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, late))).toBe(true)
    expect(quiz.getUserScore('u1')).toMatchObject({ score: 1, speedBonus: 0 })
  })

  it('credits an answer to the question it was given for, even after advancing', () => {
    const quiz = new Quiz(store, 3, 10)
    const q1 = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.nextQuestion())
    expect(Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, new Date(), q1.question.id))).toBe(true)
    expect(q1.responses).toHaveLength(1)
  })

  it('scales the speed bonus by the configured timeout, not the default', () => {
    const quiz = new Quiz(store, 3, 20)
    const q = Effect.runSync(quiz.startQuiz())
    // 15s into a 20s question: 25% of the window remains -> 25% of max bonus.
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, new Date(q.timestamp.getTime() + 15_000)))
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(0.25 * SPEED_BONUS_MAX, 5)
  })

  it('keeps the speed bonus out of the points', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp))
    expect(quiz.getUserScore('u1')!.score).toBe(1)
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(SPEED_BONUS_MAX, 5)
  })

  it('drops the bonus when a user changes a correct answer to a wrong one', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = Effect.runSync(quiz.startQuiz())
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!.id
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, new Date(q.timestamp.getTime() + 1000)))
    Effect.runSync(quiz.submitAnswer('u1', wrong, new Date(q.timestamp.getTime() + 2000)))
    expect(quiz.getUserScore('u1')).toMatchObject({ score: 0, speedBonus: 0, totalAnswered: 1 })
  })

  it('leaves exactly no bonus once every correct answer has been changed', () => {
    const quiz = new Quiz(store, 3, 10)
    const q1 = Effect.runSync(quiz.startQuiz())
    const q2 = Effect.runSync(quiz.nextQuestion())
    const wrong = (q: typeof q1) => q.answers.find((a) => a.id !== q.correctAnswer.id)!.id
    // Bonuses whose float sum, less each of them, is not exactly zero.
    Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, new Date(q1.timestamp.getTime() + 1500), q1.question.id))
    Effect.runSync(quiz.submitAnswer('u1', q2.correctAnswer.id, new Date(q2.timestamp.getTime() + 400), q2.question.id))
    Effect.runSync(quiz.submitAnswer('u1', wrong(q1), new Date(q1.timestamp.getTime() + 3000), q1.question.id))
    Effect.runSync(quiz.submitAnswer('u1', wrong(q2), new Date(q2.timestamp.getTime() + 3000), q2.question.id))
    expect(quiz.getUserScore('u1')).toMatchObject({ score: 0, speedBonus: 0, totalAnswered: 2 })
  })
})

describe('Leaderboard ranking', () => {
  /** Asks one question per round; each participant answers `[correct?, msIntoWindow]`. */
  function play(quiz: Quiz, answers: Record<string, [boolean, number][]>) {
    const rounds = Math.max(...Object.values(answers).map((a) => a.length))

    for (let i = 0; i < rounds; i++) {
      const q = Effect.runSync(i === 0 ? quiz.startQuiz() : quiz.nextQuestion())
      const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!.id

      for (const [userId, picks] of Object.entries(answers)) {
        const pick = picks[i]

        if (!pick) continue
        const [correct, ms] = pick
        Effect.runSync(quiz.submitAnswer(userId, correct ? q.correctAnswer.id : wrong, new Date(q.timestamp.getTime() + ms)))
      }
    }
  }

  it('ranks more points above any amount of speed bonus', () => {
    const quiz = new Quiz(createQuestionSource(), 10, 5)
    play(quiz, {
      // Nine instant correct answers and one miss: nearly the maximum bonus.
      speedy: [...Array(9).fill([true, 0]), [false, 0]],
      // Ten correct answers, each just before the window closes.
      steady: Array(10).fill([true, 4900]),
    })

    const [first, second] = quiz.getLeaderboard()
    expect(first).toMatchObject({ userId: 'steady', score: 10 })
    expect(second).toMatchObject({ userId: 'speedy', score: 9 })
    expect(second.speedBonus).toBeGreaterThan(first.speedBonus + 1)
  })

  it('breaks a tie on points with the speed bonus', () => {
    const quiz = new Quiz(createQuestionSource(), 2, 5)
    play(quiz, {
      slow: [[true, 4000], [true, 4000]],
      fast: [[true, 1000], [true, 1000]],
      wrong: [[false, 0], [false, 0]],
    })

    expect(quiz.getLeaderboard().map((s) => s.userId)).toEqual(['fast', 'slow', 'wrong'])
  })
})
