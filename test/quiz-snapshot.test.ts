import { describe, it, expect } from 'vitest'
import {
  Quiz,
  SPEED_BONUS_MAX,
  type Question,
  type QuestionSource,
  type QuizSnapshot,
  type TriviaQuestion,
} from '../src/trivia-core'
import { createMockTriviaQuestion } from './test-utils'

const TIMEOUT = 10

function triviaQuestions(count: number): TriviaQuestion[] {
  return Array.from({ length: count }, (_, i) =>
    createMockTriviaQuestion({
      id: `q${i + 1}`,
      correctAnswer: `Correct ${i + 1}`,
      incorrectAnswers: [`Wrong ${i + 1}a`, `Wrong ${i + 1}b`, `Wrong ${i + 1}c`],
      question: { text: `Question ${i + 1}?` },
    }),
  )
}

/** Hands out prepared questions in order, so no test depends on the trivia API. */
function questionSource(questions: TriviaQuestion[]): QuestionSource {
  const queue = [...questions]
  return {
    get() {
      const next = queue.shift()
      if (!next) throw new Error('No questions available')
      return next
    },
  }
}

/**
 * A quiz mid-question: two questions asked, two participants (plus a user who
 * has joined without answering), and one correct answer given fast enough to
 * earn a bonus that a changed answer can take away.
 */
function quizInProgress(): { quiz: Quiz; source: QuestionSource; q1: Question; q2: Question } {
  const source = questionSource(triviaQuestions(3))
  const quiz = new Quiz(source, 3, TIMEOUT)

  quiz.addUser('lurker')
  const q1 = quiz.startQuiz()
  quiz.submitAnswer('u1', q1.correctAnswer.id, at(q1, 1500))
  quiz.submitAnswer('u2', wrongAnswerId(q1), at(q1, 3000))
  const q2 = quiz.nextQuestion()
  quiz.submitAnswer('u1', q2.correctAnswer.id, at(q2, 400))

  return { quiz, source, q1, q2 }
}

function at(question: Question, msIntoWindow: number): Date {
  return new Date(question.timestamp.getTime() + msIntoWindow)
}

function wrongAnswerId(question: Question): string {
  return question.answers.find((a) => a.id !== question.correctAnswer.id)!.id
}

/** What a durable store does with a snapshot: stringify on write, parse on wake. */
function throughStorage(snapshot: QuizSnapshot): QuizSnapshot {
  return JSON.parse(JSON.stringify(snapshot))
}

function assertPlainJson(value: unknown, path = 'snapshot'): void {
  if (value === null) return
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainJson(item, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    expect(Object.getPrototypeOf(value), `${path} is not a plain object`).toBe(Object.prototype)
    for (const [key, child] of Object.entries(value)) assertPlainJson(child, `${path}.${key}`)
    return
  }
  expect(['string', 'number', 'boolean'], `${path} is ${typeof value}`).toContain(typeof value)
}

describe('Quiz snapshot', () => {
  it('is plain JSON that survives a stringify round-trip unchanged', () => {
    const { quiz } = quizInProgress()
    const snapshot = quiz.toSnapshot()

    assertPlainJson(snapshot)
    expect(throughStorage(snapshot)).toStrictEqual(snapshot)
  })

  it('carries everything needed to rebuild the quiz', () => {
    const { quiz, q1, q2 } = quizInProgress()
    const snapshot = throughStorage(quiz.toSnapshot())

    expect(snapshot.maxQuestions).toBe(3)
    expect(snapshot.timeoutSecs).toBe(TIMEOUT)
    expect(snapshot.isActive).toBe(true)
    expect(snapshot.currentQuestionIndex).toBe(1)
    expect(snapshot.users).toEqual(['lurker'])

    expect(snapshot.questions.map((q) => q.question.id)).toEqual(['q1', 'q2'])
    expect(snapshot.questions[0].question).toEqual(q1.question)
    expect(snapshot.questions[0].answers).toEqual(q1.answers)
    expect(snapshot.questions[0].correctAnswerId).toBe(q1.correctAnswer.id)
    expect(snapshot.questions[0].startedAt).toBe(q1.timestamp.getTime())
    expect(snapshot.questions[0].responses).toEqual([
      { userId: 'u1', answerId: q1.correctAnswer.id, at: q1.timestamp.getTime() + 1500 },
      { userId: 'u2', answerId: wrongAnswerId(q1), at: q1.timestamp.getTime() + 3000 },
    ])
    expect(snapshot.questions[1].startedAt).toBe(q2.timestamp.getTime())
    expect(snapshot.questions[1].responses).toEqual([
      { userId: 'u1', answerId: q2.correctAnswer.id, at: q2.timestamp.getTime() + 400 },
    ])
  })

  it('rehydrates into an equivalent quiz', () => {
    const { quiz, source, q1 } = quizInProgress()
    const rehydrated = Quiz.fromSnapshot(throughStorage(quiz.toSnapshot()), source)

    expect(rehydrated.isActive()).toBe(true)
    expect(rehydrated.isComplete()).toBe(false)
    expect(rehydrated.getProgress()).toEqual(quiz.getProgress())
    expect(rehydrated.getMaxQuestions()).toBe(quiz.getMaxQuestions())
    expect(rehydrated.getTimeoutSecs()).toBe(quiz.getTimeoutSecs())
    expect(rehydrated.getUsers()).toEqual(quiz.getUsers())
    expect(rehydrated.getLeaderboard()).toEqual(quiz.getLeaderboard())
    expect(rehydrated.getRecap('u1')).toEqual(quiz.getRecap('u1'))
    expect(rehydrated.getRecap('u2')).toEqual(quiz.getRecap('u2'))
    expect(rehydrated.getRecap('lurker')).toEqual(quiz.getRecap('lurker'))

    const current = rehydrated.getCurrentQuestion()!
    expect(current.question.id).toBe('q2')
    expect(current.timestamp).toBeInstanceOf(Date)
    expect(current.timestamp.getTime()).toBe(quiz.getCurrentQuestion()!.timestamp.getTime())
    expect(current.answers).toContain(current.correctAnswer)

    const restoredQ1 = rehydrated.getQuestions()[0]
    expect(restoredQ1.timestamp.getTime()).toBe(q1.timestamp.getTime())
    expect(restoredQ1.responses[0].timestamp).toBeInstanceOf(Date)
    expect(restoredQ1.responses[0].timestamp.getTime()).toBe(q1.responses[0].timestamp.getTime())
  })

  it('scores a late answer, a changed answer and a fast answer exactly as the original does', () => {
    const { quiz, source } = quizInProgress()
    const rehydrated = Quiz.fromSnapshot(throughStorage(quiz.toSnapshot()), source)

    for (const instance of [quiz, rehydrated]) {
      const q1 = instance.getQuestions()[0]
      const q2 = instance.getCurrentQuestion()!

      // Late: past the answer window, so the base point and no bonus.
      instance.submitAnswer('u3', q1.correctAnswer.id, at(q1, 25_000), q1.question.id)
      // Changed: the bonus u1 earned on q2 before the snapshot no longer counts.
      instance.submitAnswer('u1', wrongAnswerId(q2), at(q2, 2000))
      // Fast: answered almost immediately, so nearly the whole bonus.
      instance.submitAnswer('u2', q2.correctAnswer.id, at(q2, 100))
    }

    expect(rehydrated.getUserScore('u1')).toEqual(quiz.getUserScore('u1'))
    expect(rehydrated.getUserScore('u2')).toEqual(quiz.getUserScore('u2'))
    expect(rehydrated.getUserScore('u3')).toEqual(quiz.getUserScore('u3'))
    expect(rehydrated.getLeaderboard()).toEqual(quiz.getLeaderboard())
    expect(rehydrated.getRecap('u1')).toEqual(quiz.getRecap('u1'))
    expect(rehydrated.getRecap('u2')).toEqual(quiz.getRecap('u2'))
    expect(rehydrated.getRecap('u3')).toEqual(quiz.getRecap('u3'))

    for (const instance of [quiz, rehydrated]) {
      const recap = instance.getRecap('u1')
      expect(instance.getUserScore('u3')).toMatchObject({ score: 1, speedBonus: 0 })
      // u1 keeps q1's point and bonus and nothing from q2.
      expect(recap[1]).toMatchObject({ points: 0, speedBonus: 0 })
      expect(instance.getUserScore('u1')!.score).toBe(1)
      expect(instance.getUserScore('u1')!.speedBonus).toBeCloseTo(recap[0].speedBonus, 10)
      expect(instance.getUserScore('u2')!.score).toBe(1)
      expect(instance.getUserScore('u2')!.speedBonus).toBeCloseTo(0.99 * SPEED_BONUS_MAX, 10)
    }
  })

  it('splits the speed bonus out of the points of a version 1 snapshot', () => {
    const { quiz, source } = quizInProgress()
    // Version 1 also stored one combined score per participant.
    const v1 = {
      ...throughStorage(quiz.toSnapshot()),
      version: 1,
      userScores: quiz.getUserScores().map(({ speedBonus, ...rest }) => ({
        ...rest,
        score: rest.score + speedBonus,
      })),
    } as QuizSnapshot

    const rehydrated = Quiz.fromSnapshot(v1, source)

    for (const userId of ['lurker', 'u1', 'u2']) {
      const expected = quiz.getUserScore(userId)!
      const actual = rehydrated.getUserScore(userId)!
      expect(actual.score).toBe(expected.score)
      expect(actual.speedBonus).toBeCloseTo(expected.speedBonus, 10)
      expect(actual.totalAnswered).toBe(expected.totalAnswered)
    }
    expect(rehydrated.toSnapshot().version).toBe(2)
  })

  it('draws its remaining questions from the source it is rebuilt with', () => {
    const { quiz } = quizInProgress()
    const [, , thirdQuestion] = triviaQuestions(3)
    const live = Quiz.fromSnapshot(
      throughStorage(quiz.toSnapshot()),
      questionSource([thirdQuestion]),
    )

    const q3 = live.nextQuestion()
    expect(live.getQuestions().map((q) => q.question.id)).toEqual(['q1', 'q2', 'q3'])
    live.submitAnswer('u1', q3.correctAnswer.id, at(q3, 1000))

    const woken = Quiz.fromSnapshot(throughStorage(live.toSnapshot()), questionSource([]))
    expect(woken.isComplete()).toBe(true)
    expect(woken.getProgress()).toEqual({ current: 3, total: 3 })
    expect(woken.getRecap('u1')).toEqual(live.getRecap('u1'))
    expect(woken.getLeaderboard()).toEqual(live.getLeaderboard())

    woken.endQuiz()
    const ended = Quiz.fromSnapshot(throughStorage(woken.toSnapshot()), questionSource([]))
    expect(ended.isActive()).toBe(false)
    expect(ended.getLeaderboard()).toEqual(woken.getLeaderboard())
  })

  it('round-trips a quiz that has not started yet', () => {
    const source = questionSource(triviaQuestions(1))
    const quiz = new Quiz(source, 1, TIMEOUT)
    const snapshot = throughStorage(quiz.toSnapshot())

    expect(snapshot.questions).toEqual([])
    expect(snapshot.currentQuestionIndex).toBe(null)

    const rehydrated = Quiz.fromSnapshot(snapshot, source)
    expect(rehydrated.isActive()).toBe(false)
    expect(rehydrated.getCurrentQuestion()).toBe(null)

    const q1 = rehydrated.startQuiz()
    expect(rehydrated.isActive()).toBe(true)
    expect(rehydrated.submitAnswer('u1', q1.correctAnswer.id, at(q1, 1000))).toBe(true)
  })

  it('shares no mutable state with the snapshot in either direction', () => {
    const { quiz, source } = quizInProgress()
    const snapshot = quiz.toSnapshot()
    const rehydrated = Quiz.fromSnapshot(snapshot, source)
    const asWritten = throughStorage(snapshot)

    const q2 = quiz.getCurrentQuestion()!
    quiz.submitAnswer('u1', wrongAnswerId(q2), at(q2, 5000))
    quiz.submitAnswer('u4', q2.correctAnswer.id, at(q2, 1000))
    expect(snapshot).toStrictEqual(asWritten)

    const restoredQ1 = rehydrated.getQuestions()[0]
    rehydrated.submitAnswer('u9', restoredQ1.correctAnswer.id, at(restoredQ1, 1000), 'q1')
    // Changing an answer replaces it in place, so a leaked response would be rewritten after storage.
    rehydrated.submitAnswer('u1', wrongAnswerId(restoredQ1), at(restoredQ1, 5000), 'q1')
    expect(snapshot).toStrictEqual(asWritten)
    expect(quiz.getUserScore('u9')).toBeUndefined()
    expect(rehydrated.getUserScore('u4')).toBeUndefined()
  })

  it('refuses a snapshot it cannot faithfully rebuild', () => {
    const { quiz, source } = quizInProgress()

    const future = throughStorage(quiz.toSnapshot())
    future.version = future.version + 1
    expect(() => Quiz.fromSnapshot(future, source)).toThrow(/Unsupported quiz snapshot version/)

    const danglingCurrent = throughStorage(quiz.toSnapshot())
    danglingCurrent.currentQuestionIndex = 7
    expect(() => Quiz.fromSnapshot(danglingCurrent, source)).toThrow(/no question at index 7/)
  })
})
