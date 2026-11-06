import { describe, it, expect } from 'vitest'
import { Effect, Option, Schema } from 'effect'
import {
  Quiz,
  QuizCompleteError,
  QuizSnapshot,
  SPEED_BONUS_MAX,
  InvalidQuizSnapshotError,
  QuestionsExhaustedError,
  UnsupportedSnapshotVersionError,
  type Question,
  type QuestionSource,
  type TriviaQuestion,
} from '../src/trivia-core'
import { createMockTriviaQuestion, failureOf } from './test-utils'

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
    get: () => Option.fromUndefinedOr(queue.shift()),
  }
}

/**
 * A quiz mid-question: two questions asked, two participants (plus a user who
 * has joined without answering), and one correct answer given fast enough to
 * earn a bonus that a changed answer can take away.
 */
function quizInProgress() {
  const source = questionSource(triviaQuestions(3))
  const quiz = new Quiz(source, 3, TIMEOUT)

  quiz.addUser('lurker')
  const q1 = Effect.runSync(quiz.startQuiz())
  Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, at(q1, 1500)))
  Effect.runSync(quiz.submitAnswer('u2', wrongAnswerId(q1), at(q1, 3000)))
  const q2 = Effect.runSync(quiz.nextQuestion())
  Effect.runSync(quiz.submitAnswer('u1', q2.correctAnswer.id, at(q2, 400)))

  return { quiz, source, q1, q2 }
}

function at(question: Question, msIntoWindow: number): Date {
  return new Date(question.timestamp.getTime() + msIntoWindow)
}

function wrongAnswerId(question: Question): string {
  return question.answers.find((a) => a.id !== question.correctAnswer.id)!.id
}

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(QuizSnapshot))

/** What a durable store does with a snapshot: stringify on write, decode on wake. */
function throughStorage(snapshot: QuizSnapshot): QuizSnapshot {
  return decodeStored(JSON.stringify(snapshot))
}

describe('Quiz snapshot', () => {
  it('is plain JSON that survives a stringify round-trip unchanged', () => {
    const { quiz } = quizInProgress()
    const snapshot = quiz.toSnapshot()

    // Strict equality fails on any Date, Map, Set or class instance, which a
    // JSON round-trip turns into something else.
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
    const rehydrated = Effect.runSync(Quiz.fromSnapshot(throughStorage(quiz.toSnapshot()), source))

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
    const rehydrated = Effect.runSync(Quiz.fromSnapshot(throughStorage(quiz.toSnapshot()), source))

    for (const instance of [quiz, rehydrated]) {
      const q1 = instance.getQuestions()[0]
      const q2 = instance.getCurrentQuestion()!

      // Late: past the answer window, so the base point and no bonus.
      Effect.runSync(instance.submitAnswer('u3', q1.correctAnswer.id, at(q1, 25_000), q1.question.id))
      // Changed: the bonus u1 earned on q2 before the snapshot no longer counts.
      Effect.runSync(instance.submitAnswer('u1', wrongAnswerId(q2), at(q2, 2000)))
      // Fast: answered almost immediately, so nearly the whole bonus.
      Effect.runSync(instance.submitAnswer('u2', q2.correctAnswer.id, at(q2, 100)))
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
    }

    const rehydrated = Effect.runSync(Quiz.fromSnapshot(decodeStored(JSON.stringify(v1)), source))

    for (const userId of ['lurker', 'u1', 'u2']) {
      const expected = quiz.getUserScore(userId)!
      const actual = rehydrated.getUserScore(userId)!
      expect(actual.score).toBe(expected.score)
      expect(actual.speedBonus).toBeCloseTo(expected.speedBonus, 10)
      expect(actual.totalAnswered).toBe(expected.totalAnswered)
    }

    expect(rehydrated.toSnapshot().version).toBe(2)
  })

  it('reads an answer stored without a time as late: its point, no speed bonus', () => {
    const { quiz, source, q1 } = quizInProgress()
    const stored = JSON.parse(JSON.stringify(quiz.toSnapshot()))
    // What JSON.stringify writes for an answer time of NaN.
    stored.questions[0].responses[0].at = null

    const snapshot = decodeStored(JSON.stringify(stored))
    expect(snapshot.questions[0].responses[0].at).toBeGreaterThan(q1.timestamp.getTime() + TIMEOUT * 1000)

    const rehydrated = Effect.runSync(Quiz.fromSnapshot(snapshot, source))
    expect(rehydrated.getRecap('u1')[0]).toMatchObject({ answered: true, points: 1, speedBonus: 0 })
    expect(rehydrated.getUserScore('u1')!.score).toBe(2)
  })

  it('draws its remaining questions from the source it is rebuilt with', () => {
    const { quiz } = quizInProgress()
    const [, , thirdQuestion] = triviaQuestions(3)

    const live = Effect.runSync(
      Quiz.fromSnapshot(throughStorage(quiz.toSnapshot()), questionSource([thirdQuestion])),
    )

    const q3 = Effect.runSync(live.nextQuestion())
    expect(live.getQuestions().map((q) => q.question.id)).toEqual(['q1', 'q2', 'q3'])
    Effect.runSync(live.submitAnswer('u1', q3.correctAnswer.id, at(q3, 1000)))

    const woken = Effect.runSync(Quiz.fromSnapshot(throughStorage(live.toSnapshot()), questionSource([])))
    expect(woken.isComplete()).toBe(true)
    expect(failureOf(woken.nextQuestion())).toBeInstanceOf(QuizCompleteError)
    expect(woken.getProgress()).toEqual({ current: 3, total: 3 })
    expect(woken.getRecap('u1')).toEqual(live.getRecap('u1'))
    expect(woken.getLeaderboard()).toEqual(live.getLeaderboard())

    woken.endQuiz()
    const ended = Effect.runSync(Quiz.fromSnapshot(throughStorage(woken.toSnapshot()), questionSource([])))
    expect(ended.isActive()).toBe(false)
    expect(ended.getLeaderboard()).toEqual(woken.getLeaderboard())
  })

  it('round-trips a quiz that has not started yet', () => {
    const source = questionSource(triviaQuestions(1))
    const quiz = new Quiz(source, 1, TIMEOUT)
    const snapshot = throughStorage(quiz.toSnapshot())

    expect(snapshot.questions).toEqual([])
    expect(snapshot.currentQuestionIndex).toBe(null)

    const rehydrated = Effect.runSync(Quiz.fromSnapshot(snapshot, source))
    expect(rehydrated.isActive()).toBe(false)
    expect(rehydrated.getCurrentQuestion()).toBe(null)

    const q1 = Effect.runSync(rehydrated.startQuiz())
    expect(rehydrated.isActive()).toBe(true)
    expect(Effect.runSync(rehydrated.submitAnswer('u1', q1.correctAnswer.id, at(q1, 1000)))).toBe(true)
  })

  it('shares no mutable state with the snapshot in either direction', () => {
    const { quiz, source } = quizInProgress()
    const snapshot = quiz.toSnapshot()
    const rehydrated = Effect.runSync(Quiz.fromSnapshot(snapshot, source))
    const asWritten = throughStorage(snapshot)

    const q2 = quiz.getCurrentQuestion()!
    Effect.runSync(quiz.submitAnswer('u1', wrongAnswerId(q2), at(q2, 5000)))
    Effect.runSync(quiz.submitAnswer('u4', q2.correctAnswer.id, at(q2, 1000)))
    expect(snapshot).toStrictEqual(asWritten)

    const restoredQ1 = rehydrated.getQuestions()[0]
    Effect.runSync(rehydrated.submitAnswer('u9', restoredQ1.correctAnswer.id, at(restoredQ1, 1000), 'q1'))
    // Changing an answer replaces it in place, so a leaked response would be rewritten after storage.
    Effect.runSync(rehydrated.submitAnswer('u1', wrongAnswerId(restoredQ1), at(restoredQ1, 5000), 'q1'))
    expect(snapshot).toStrictEqual(asWritten)
    expect(quiz.getUserScore('u9')).toBeUndefined()
    expect(rehydrated.getUserScore('u4')).toBeUndefined()
  })

  it('refuses a snapshot it cannot faithfully rebuild', () => {
    const { quiz, source } = quizInProgress()
    const stored = throughStorage(quiz.toSnapshot())

    const future = { ...stored, version: stored.version + 1 }
    const unsupported = failureOf(Quiz.fromSnapshot(future, source))
    expect(unsupported).toBeInstanceOf(UnsupportedSnapshotVersionError)
    expect(unsupported).toMatchObject({ version: stored.version + 1 })
    expect(unsupported.message).toMatch(/Unsupported quiz snapshot version/)

    const danglingCurrent = { ...stored, currentQuestionIndex: 7 }
    const dangling = failureOf(Quiz.fromSnapshot(danglingCurrent, source))
    expect(dangling).toBeInstanceOf(InvalidQuizSnapshotError)
    expect(dangling.message).toMatch(/no question at index 7/)

    const [q1, ...rest] = stored.questions
    const noCorrectAnswer = { ...stored, questions: [{ ...q1, correctAnswerId: 'nowhere' }, ...rest] }
    expect(failureOf(Quiz.fromSnapshot(noCorrectAnswer, source))).toBeInstanceOf(InvalidQuizSnapshotError)
  })

  it('refuses to decode a stored snapshot that does not match the schema', () => {
    const { quiz } = quizInProgress()
    const stored = JSON.parse(JSON.stringify(quiz.toSnapshot()))

    delete stored.questions[0].responses[0].at
    expect(() => decodeStored(JSON.stringify(stored))).toThrow(Schema.SchemaError)
    expect(() => decodeStored('not json')).toThrow(Schema.SchemaError)
  })

  it('fails with a typed error when the question source runs dry', () => {
    const quiz = new Quiz(questionSource(triviaQuestions(1)), 2, TIMEOUT)
    Effect.runSync(quiz.startQuiz())

    expect(failureOf(quiz.nextQuestion())).toBeInstanceOf(QuestionsExhaustedError)
    expect(quiz.getProgress()).toEqual({ current: 1, total: 2 })
  })
})
