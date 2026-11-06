import { describe, it, expect } from 'vitest'
import { Effect, Option, Schema } from 'effect'
import { Quiz, SPEED_BONUS_MAX } from '../../src/trivia-core'
import { QuizRecord } from '../../worker/quiz-store'

/**
 * Rows written by the channel object before Effect, exactly as master stored
 * them. Live quizzes and old Recap buttons depend on them still decoding.
 */

const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(QuizRecord))

const noQuestions = { get: () => Option.none() }

/** A full Trivia API question, every field master kept. */
function apiQuestion(n: number) {
  return {
    category: 'science',
    id: `622a1c357cc59eab6f94f${n}`,
    correctAnswer: `Correct ${n}`,
    incorrectAnswers: [`Wrong ${n}a`, `Wrong ${n}b`, `Wrong ${n}c`],
    question: { text: `Question ${n}?` },
    tags: ['science', 'physics'],
    type: 'text_choice',
    difficulty: 'medium',
    regions: [],
    isNiche: false,
  }
}

function answers(n: number) {
  return [
    { id: `a${n}-1`, text: `Wrong ${n}a` },
    { id: `a${n}-2`, text: `Correct ${n}` },
    { id: `a${n}-3`, text: `Wrong ${n}b` },
    { id: `a${n}-4`, text: `Wrong ${n}c` },
  ]
}

const STARTED_AT = 1_762_400_000_000

/** Mid-quiz, on question 1 of 3: one answer with Slack's fractional click time, one whose time was NaN. */
const RUNNING_ROW = JSON.stringify({
  version: 2,
  maxQuestions: 3,
  timeoutSecs: 10,
  isActive: true,
  currentQuestionIndex: 0,
  questions: [
    {
      question: apiQuestion(1),
      answers: answers(1),
      correctAnswerId: 'a1-2',
      startedAt: STARTED_AT,
      responses: [
        { userId: 'U-FAST', answerId: 'a1-2', at: STARTED_AT + 2500.123 },
        { userId: 'U-NAN', answerId: 'a1-2', at: null },
      ],
    },
  ],
  users: [],
  phase: 'question',
  deadline: STARTED_AT + 10_000,
  pending: [apiQuestion(2), apiQuestion(3)],
  origin: 'https://slack-trivia.example.workers.dev',
})

/** A finished quiz from before the speed bonus was kept apart from points. */
const FINISHED_V1_ROW = JSON.stringify({
  version: 1,
  maxQuestions: 1,
  timeoutSecs: 5,
  isActive: false,
  currentQuestionIndex: 0,
  questions: [
    {
      question: apiQuestion(1),
      answers: answers(1),
      correctAnswerId: 'a1-2',
      startedAt: STARTED_AT,
      responses: [{ userId: 'U-OLD', answerId: 'a1-2', at: STARTED_AT + 1000 }],
    },
  ],
  users: [],
  userScores: [{ userId: 'U-OLD', score: 1.16, totalAnswered: 1 }],
  phase: 'complete',
  deadline: STARTED_AT + 5000,
  pending: [],
  origin: 'https://slack-trivia.example.workers.dev',
})

describe('QuizRecord rows stored before Effect', () => {
  it('decodes a running row and carries on from it', () => {
    const record = decodeRow(RUNNING_ROW)

    expect(record.phase).toBe('question')
    expect(record.pending.map((question) => question.id)).toEqual([
      '622a1c357cc59eab6f94f2',
      '622a1c357cc59eab6f94f3',
    ])
    // Fields the app never reads are dropped from the pending questions.
    expect(record.pending[0]).toEqual({
      id: '622a1c357cc59eab6f94f2',
      correctAnswer: 'Correct 2',
      incorrectAnswers: ['Wrong 2a', 'Wrong 2b', 'Wrong 2c'],
      question: { text: 'Question 2?' },
    })

    const quiz = Effect.runSync(Quiz.fromSnapshot(record, noQuestions))
    expect(quiz.getUserScore('U-FAST')!.score).toBe(1)
    expect(quiz.getUserScore('U-FAST')!.speedBonus).toBeCloseTo(0.75 * SPEED_BONUS_MAX, 5)
    // The answer whose time was lost keeps its point but earns no bonus.
    expect(quiz.getUserScore('U-NAN')).toMatchObject({ score: 1, speedBonus: 0 })
  })

  it('decodes a finished version 1 row, recomputing its scores', () => {
    const record = decodeRow(FINISHED_V1_ROW)

    expect(record).not.toHaveProperty('userScores')

    const quiz = Effect.runSync(Quiz.fromSnapshot(record, noQuestions))
    expect(quiz.isActive()).toBe(false)
    expect(quiz.getUserScore('U-OLD')!.score).toBe(1)
    expect(quiz.getUserScore('U-OLD')!.speedBonus).toBeCloseTo(0.8 * SPEED_BONUS_MAX, 5)
    expect(quiz.getRecap('U-OLD')).toHaveLength(1)
  })
})
