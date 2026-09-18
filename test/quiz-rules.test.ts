import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  Quiz,
  TriviaStore,
  SPEED_BONUS_MAX,
  parseQuizzoArgs,
  MAX_QUESTIONS,
  MAX_TIMEOUT_SECS,
} from '../src/trivia-core'
import { createMockQuestions, setupTestEnvironment } from './test-utils'

global.fetch = vi.fn()

describe('parseQuizzoArgs', () => {
  it('defaults to 3 questions / 5s', () => {
    expect(parseQuizzoArgs('')).toEqual({ ok: true, args: { numQuestions: 3, timeoutSecs: 5 } })
    expect(parseQuizzoArgs('   ')).toEqual({ ok: true, args: { numQuestions: 3, timeoutSecs: 5 } })
  })

  it('parses question count and timeout', () => {
    expect(parseQuizzoArgs('5 10s')).toEqual({ ok: true, args: { numQuestions: 5, timeoutSecs: 10 } })
    expect(parseQuizzoArgs(' 7 ')).toEqual({ ok: true, args: { numQuestions: 7, timeoutSecs: 5 } })
  })

  it('rejects bad question counts', () => {
    for (const text of ['0', '21', 'abc', '2.5', `${MAX_QUESTIONS + 1}`]) {
      const r = parseQuizzoArgs(text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.error).toContain('Invalid number of questions')
    }
  })

  it('rejects bad timeouts', () => {
    const noSuffix = parseQuizzoArgs('3 10')
    expect(noSuffix.ok).toBe(false)
    if (!noSuffix.ok) expect(noSuffix.error).toContain("suffixed with 's'")

    for (const text of ['3 0s', `3 ${MAX_TIMEOUT_SECS + 1}s`]) {
      const r = parseQuizzoArgs(text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.error).toContain('Invalid timeout')
    }
  })
})

describe('Quiz answer rules', () => {
  let store: TriviaStore

  beforeEach(async () => {
    setupTestEnvironment()
    store = new TriviaStore()
    await store.ensure(2)
  })

  it('credits a late answer with the base point and no bonus', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = quiz.startQuiz()
    const late = new Date(q.timestamp.getTime() + 10_001)
    expect(quiz.submitAnswer('u1', q.correctAnswer.id, late)).toBe(true)
    expect(quiz.getUserScore('u1')!.score).toBe(1)
  })

  it('credits an answer to the question it was given for, even after advancing', () => {
    const quiz = new Quiz(store, 3, 10)
    const q1 = quiz.startQuiz()
    quiz.nextQuestion()
    expect(quiz.submitAnswer('u1', q1.correctAnswer.id, new Date(), q1.question.id)).toBe(true)
    expect(q1.responses).toHaveLength(1)
  })

  it('scales the speed bonus by the configured timeout, not the default', () => {
    const quiz = new Quiz(store, 3, 20)
    const q = quiz.startQuiz()
    // 15s into a 20s question: 25% of the window remains -> 25% of max bonus.
    quiz.submitAnswer('u1', q.correctAnswer.id, new Date(q.timestamp.getTime() + 15_000))
    expect(quiz.getUserScore('u1')!.score).toBeCloseTo(1 + 0.25 * SPEED_BONUS_MAX, 5)
  })

  it('refunds the bonus correctly when a user changes a correct answer to a wrong one', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = quiz.startQuiz()
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!.id
    quiz.submitAnswer('u1', q.correctAnswer.id, new Date(q.timestamp.getTime() + 1000))
    quiz.submitAnswer('u1', wrong, new Date(q.timestamp.getTime() + 2000))
    expect(quiz.getUserScore('u1')!.score).toBeCloseTo(0, 10)
    expect(quiz.getUserScore('u1')!.totalAnswered).toBe(1)
  })
})

describe('TriviaStore.ensure', () => {
  it('fetches until enough questions are cached', async () => {
    setupTestEnvironment()
    const store = new TriviaStore()
    const ok = await store.ensure(2)
    expect(ok).toBe(true)
    expect(store.getCacheSize()).toBeGreaterThanOrEqual(2)
  })

  it('reports failure when the API cannot supply questions', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: vi.fn() })
    const store = new TriviaStore()
    expect(await store.ensure(5)).toBe(false)
  })

  it('shares a single in-flight fetch between concurrent callers', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => createMockQuestions(10) })
    const store = new TriviaStore() // constructor: fetch call #1
    await Promise.all([store.ensure(5), store.ensure(5), store.ensure(5)])
    // All three ensure() calls share one fetch: #2. No third call.
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.getCacheSize()).toBeGreaterThanOrEqual(5)
  })
})
