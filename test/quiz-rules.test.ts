import { describe, it, expect, beforeEach } from 'vitest'
import { Effect, Option } from 'effect'
import {
  Quiz,
  parseQuizzoArgs,
  InvalidQuizzoArgsError,
  QuestionNotFoundError,
  QuestionsExhaustedError,
  MAX_QUESTIONS,
  FASTEST_WRONG_MAX_SECS,
  HERD_MIN,
  type Question,
  type QuestionSource,
} from '../src/trivia-core'
import { MAX_TIMEOUT_SECS } from '../src/timing'
import { NO_AWARDS, createMockQuestions, createQuestionSource, failureOf } from './test-utils'

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
    // 15s into a 20s question: 25% of the window remains, so 25% of the bonus.
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, new Date(q.timestamp.getTime() + 15_000)))
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(0.25, 5)
  })

  it('keeps the speed bonus out of the points', () => {
    const quiz = new Quiz(store, 3, 10)
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp))
    expect(quiz.getUserScore('u1')!.score).toBe(1)
    // An instant answer earns the whole bonus, and only one question was asked
    // of the three configured.
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(1, 5)
  })

  it('averages the quiz bonus over every question asked, not just those answered', () => {
    const quiz = new Quiz(store, 2, 10)
    const q1 = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.nextQuestion())
    Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, q1.timestamp, q1.question.id))

    // One instant correct answer out of two asked: half the maximum, with the
    // unanswered question counting as zero rather than being skipped.
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(0.5, 5)
  })

  it('counts a wrong answer as zero in the quiz mean', () => {
    const quiz = new Quiz(store, 2, 10)
    const q1 = Effect.runSync(quiz.startQuiz())
    const q2 = Effect.runSync(quiz.nextQuestion())
    const wrong = (q: typeof q1) => q.answers.find((a) => a.id !== q.correctAnswer.id)!.id
    Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, q1.timestamp, q1.question.id))
    Effect.runSync(quiz.submitAnswer('u1', wrong(q2), q2.timestamp, q2.question.id))

    expect(quiz.getUserScore('u1')).toMatchObject({ score: 1, totalAnswered: 2 })
    expect(quiz.getUserScore('u1')!.speedBonus).toBeCloseTo(0.5, 5)
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
    // Both questions answered correctly, then each changed: neither the point
    // nor any part of the bonus it earned may linger in the quiz mean.
    Effect.runSync(quiz.submitAnswer('u1', q1.correctAnswer.id, new Date(q1.timestamp.getTime() + 1500), q1.question.id))
    Effect.runSync(quiz.submitAnswer('u1', q2.correctAnswer.id, new Date(q2.timestamp.getTime() + 400), q2.question.id))
    Effect.runSync(quiz.submitAnswer('u1', wrong(q1), new Date(q1.timestamp.getTime() + 3000), q1.question.id))
    Effect.runSync(quiz.submitAnswer('u1', wrong(q2), new Date(q2.timestamp.getTime() + 3000), q2.question.id))
    expect(quiz.getUserScore('u1')).toMatchObject({ score: 0, speedBonus: 0, totalAnswered: 2 })
  })

  it('fails with a typed error when there is no question to answer', () => {
    const quiz = new Quiz({ get: () => Option.none() }, 3, 10)
    // Started, but the source was dry: active with no current question.
    expect(failureOf(quiz.startQuiz())).toBeInstanceOf(QuestionsExhaustedError)

    const current = failureOf(quiz.submitAnswer('u1', 'a1', new Date()))
    expect(current).toBeInstanceOf(QuestionNotFoundError)
    expect(current).toMatchObject({ questionId: undefined })

    const named = failureOf(quiz.submitAnswer('u1', 'a1', new Date(), 'nowhere'))
    expect(named).toBeInstanceOf(QuestionNotFoundError)
    expect(named).toMatchObject({ questionId: 'nowhere' })
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
    // Nearly every answer instant still cannot make up a point: the bonus is a
    // share of the quiz, so a point is always worth more.
    expect(second.speedBonus).toBeCloseTo(0.9, 5)
    expect(first.speedBonus).toBeCloseTo(0.02, 5)
    expect(second.speedBonus).toBeGreaterThan(first.speedBonus)
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

describe('Quiz.getAwards', () => {
  let quiz: Quiz

  beforeEach(() => {
    quiz = new Quiz(createQuestionSource(createMockQuestions(2)), 2, 10)
  })

  const after = (q: Question, ms: number) => new Date(q.timestamp.getTime() + ms)
  const wrongAnswers = (q: Question) => q.answers.filter((a) => a.id !== q.correctAnswer.id)

  const answerAll = (q: Question, userIds: string[], answerId: string) => {
    for (const userId of userIds) {
      Effect.runSync(quiz.submitAnswer(userId, answerId, after(q, 1_000), q.question.id))
    }
  }

  it('gives nothing when nobody answered', () => {
    Effect.runSync(quiz.startQuiz())

    expect(quiz.getAwards()).toEqual(NO_AWARDS)
  })

  it('picks the quickest wrong and slowest right answers across every question', () => {
    const q1 = Effect.runSync(quiz.startQuiz())
    const [wrong1] = wrongAnswers(q1)
    Effect.runSync(quiz.submitAnswer('u1', wrong1.id, after(q1, 1_500)))
    Effect.runSync(quiz.submitAnswer('u2', q1.correctAnswer.id, after(q1, 100)))
    Effect.runSync(quiz.submitAnswer('u5', q1.correctAnswer.id, after(q1, 6_000)))

    const q2 = Effect.runSync(quiz.nextQuestion())
    const [wrong2] = wrongAnswers(q2)
    Effect.runSync(quiz.submitAnswer('u3', wrong2.id, after(q2, 400), q2.question.id))
    Effect.runSync(quiz.submitAnswer('u4', q2.correctAnswer.id, after(q2, 14_200), q2.question.id))

    const awards = quiz.getAwards()

    expect(awards.fastestWrong).toEqual(Option.some({ userId: 'u3', pick: wrong2.text, secs: 0.4 }))
    expect(awards.slowestRight).toEqual(
      Option.some({ userId: 'u4', pick: q2.correctAnswer.text, secs: 14.2 }),
    )
  })

  it('skips fastest wrong answer when no wrong answer was quick', () => {
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', wrongAnswers(q)[0].id, after(q, FASTEST_WRONG_MAX_SECS * 1000)))

    expect(Option.isNone(quiz.getAwards().fastestWrong)).toBe(true)
  })

  it('skips slowest right answer when every right answer came in the first half of the window', () => {
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, after(q, 4_900)))

    expect(Option.isNone(quiz.getAwards().slowestRight)).toBe(true)
  })

  it('counts a late right answer as the slowest', () => {
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', q.correctAnswer.id, after(q, 5_000)))
    Effect.runSync(quiz.submitAnswer('u2', q.correctAnswer.id, after(q, 25_000)))

    expect(Option.getOrThrow(quiz.getAwards().slowestRight)).toMatchObject({ userId: 'u2', secs: 25 })
  })

  it('counts an answer stamped before the question appeared as instant', () => {
    const q = Effect.runSync(quiz.startQuiz())
    Effect.runSync(quiz.submitAnswer('u1', wrongAnswers(q)[0].id, after(q, -50)))

    expect(Option.getOrThrow(quiz.getAwards().fastestWrong).secs).toBe(0)
  })

  it('finds the wrong option most participants picked together on one question', () => {
    const q1 = Effect.runSync(quiz.startQuiz())
    answerAll(q1, ['u1', 'u2', 'u3'], wrongAnswers(q1)[0].id)

    const q2 = Effect.runSync(quiz.nextQuestion())
    const [herded] = wrongAnswers(q2)
    answerAll(q2, ['u1', 'u2', 'u3', 'u4'], herded.id)

    expect(quiz.getAwards().herd).toEqual(Option.some({ pick: herded.text, count: 4 }))
  })

  it(`needs at least ${HERD_MIN} participants on the same wrong option for a herd`, () => {
    const q = Effect.runSync(quiz.startQuiz())
    const [a, b] = wrongAnswers(q)
    answerAll(q, ['u1', 'u2'], a.id)
    answerAll(q, ['u3', 'u4'], b.id)
    answerAll(q, ['u5', 'u6', 'u7'], q.correctAnswer.id)

    expect(Option.isNone(quiz.getAwards().herd)).toBe(true)
  })
})
