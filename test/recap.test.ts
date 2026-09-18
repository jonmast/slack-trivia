import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Quiz, TriviaStore, SPEED_BONUS_MAX, RecapQuestion } from '../src/trivia-core'
import { renderRecapModal, renderFinalSummary } from '../src/slack-ui'
import { SlackQuiz } from '../src/slack-quiz'
import { ChannelQuizzes } from '../src/channel-quizzes'
import { createMockQuestions, setupTestEnvironment } from './test-utils'

global.fetch = vi.fn()

describe('Quiz.getRecap', () => {
  let store: TriviaStore
  let quiz: Quiz

  beforeEach(async () => {
    setupTestEnvironment(createMockQuestions(3))
    store = new TriviaStore()
    await store.ensure(3)
    quiz = new Quiz(store, 3, 10)
  })

  it('lists every question in order with all four options', () => {
    const q1 = quiz.startQuiz()
    const q2 = quiz.nextQuestion()
    quiz.nextQuestion()

    const recap = quiz.getRecap('u1')

    expect(recap).toHaveLength(3)
    expect(recap[0].text).toBe(q1.question.question.text)
    expect(recap[1].text).toBe(q2.question.question.text)
    expect(recap[0].options.map((o) => o.text)).toEqual(q1.answers.map((a) => a.text))
  })

  it('marks the selected option and the correct option', () => {
    const q = quiz.startQuiz()
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!
    quiz.submitAnswer('u1', wrong.id, q.timestamp)

    const [entry] = quiz.getRecap('u1')

    expect(entry.answered).toBe(true)
    expect(entry.options.find((o) => o.text === wrong.text)).toMatchObject({ selected: true, correct: false })
    expect(entry.options.find((o) => o.text === q.correctAnswer.text)).toMatchObject({ selected: false, correct: true })
    expect(entry.options.filter((o) => !o.selected && !o.correct)).toHaveLength(2)
  })

  it('awards base point plus speed bonus for a correct answer', () => {
    const q = quiz.startQuiz()
    const halfway = new Date(q.timestamp.getTime() + 5_000)
    quiz.submitAnswer('u1', q.correctAnswer.id, halfway)

    const [entry] = quiz.getRecap('u1')

    expect(entry.options.find((o) => o.correct)).toMatchObject({ selected: true })
    expect(entry.points).toBeCloseTo(1 + SPEED_BONUS_MAX / 2, 5)
  })

  it('awards zero for a wrong answer', () => {
    const q = quiz.startQuiz()
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!
    quiz.submitAnswer('u1', wrong.id, q.timestamp)

    expect(quiz.getRecap('u1')[0].points).toBe(0)
  })

  it('reports a skipped question as unanswered with only the correct option marked', () => {
    const q = quiz.startQuiz()
    quiz.nextQuestion()
    quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp, q.question.id)

    const [, skipped] = quiz.getRecap('u1')

    expect(skipped.answered).toBe(false)
    expect(skipped.points).toBe(0)
    expect(skipped.options.filter((o) => o.selected)).toHaveLength(0)
    expect(skipped.options.filter((o) => o.correct)).toHaveLength(1)
  })

  it('reflects a changed answer', () => {
    const q = quiz.startQuiz()
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!
    quiz.submitAnswer('u1', wrong.id, q.timestamp)
    quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp)

    const [entry] = quiz.getRecap('u1')

    expect(entry.options.filter((o) => o.selected)).toHaveLength(1)
    expect(entry.options.find((o) => o.selected)!.correct).toBe(true)
    expect(entry.points).toBeCloseTo(1 + SPEED_BONUS_MAX, 5)
  })

  it('still works after the quiz has ended', () => {
    const q = quiz.startQuiz()
    quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp)
    quiz.endQuiz()

    expect(quiz.getRecap('u1')[0].answered).toBe(true)
  })
})

describe('renderRecapModal', () => {
  const recap: RecapQuestion[] = [
    {
      text: 'Right one?',
      answered: true,
      points: 1.16,
      options: [
        { text: 'A', selected: true, correct: true },
        { text: 'B', selected: false, correct: false },
        { text: 'C', selected: false, correct: false },
        { text: 'D', selected: false, correct: false },
      ],
    },
    {
      text: 'Wrong one?',
      answered: true,
      points: 0,
      options: [
        { text: 'A', selected: false, correct: false },
        { text: 'B', selected: true, correct: false },
        { text: 'C', selected: false, correct: true },
        { text: 'D', selected: false, correct: false },
      ],
    },
    {
      text: 'Skipped one?',
      answered: false,
      points: 0,
      options: [
        { text: 'A', selected: false, correct: false },
        { text: 'B', selected: false, correct: false },
        { text: 'C', selected: false, correct: false },
        { text: 'D', selected: false, correct: true },
      ],
    },
  ]

  const sectionText = (block: any) => block.text.text as string

  it('is a modal with one section per question after the summary and legend', () => {
    const view = renderRecapModal(recap)

    expect(view.type).toBe('modal')
    expect(view.title.text.length).toBeLessThanOrEqual(24)
    expect(view.blocks).toHaveLength(2 + recap.length)
    expect(view.blocks.slice(2).every((b) => b.type === 'section')).toBe(true)
  })

  it('summarises total points and questions answered', () => {
    const view = renderRecapModal(recap)
    expect(sectionText(view.blocks[0])).toContain('1.2 pts')
    expect(sectionText(view.blocks[0])).toContain('2/3 answered')
  })

  it('marks a selected correct option with ✅ and leaves the rest plain', () => {
    const text = sectionText(renderRecapModal(recap).blocks[2])
    expect(text).toContain('*1. Right one?*')
    expect(text).toContain('1.2 pts')
    expect(text).toContain('✅ A')
    expect(text).not.toContain('💡')
    expect(text).not.toContain('❌')
  })

  it('marks a selected wrong option with ❌ and the missed correct one with 💡', () => {
    const text = sectionText(renderRecapModal(recap).blocks[3])
    expect(text).toContain('0.0 pts')
    expect(text).toContain('❌ B')
    expect(text).toContain('💡 C')
    expect(text).not.toContain('✅')
  })

  it('tags a skipped question and marks only the correct option', () => {
    const text = sectionText(renderRecapModal(recap).blocks[4])
    expect(text).toContain('(no answer)')
    expect(text).not.toContain('pts')
    expect(text).toContain('💡 D')
    expect(text).not.toContain('✅')
    expect(text).not.toContain('❌')
  })
})

describe('renderFinalSummary recap button', () => {
  it('includes a recap button carrying the quiz message ts', () => {
    const blocks = renderFinalSummary([], 3, '1234567890.123')
    const actions = blocks.find((b) => b.type === 'actions') as any

    expect(actions).toBeDefined()
    expect(actions.elements[0]).toMatchObject({
      type: 'button',
      action_id: 'recap',
      value: '1234567890.123',
    })
  })
})

describe('ChannelQuizzes retention', () => {
  const mockClient = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  const mockLogger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const mockStore = { get: vi.fn().mockReturnValue(createMockQuestions(1)[0]) }

  const newQuiz = () =>
    new SlackQuiz(mockClient as any, mockLogger as any, mockStore as any, 'C1', undefined, 1, undefined, 'https://trivia.test')

  it('keeps a finished quiz reachable until the next one replaces it', async () => {
    const quizzes = new ChannelQuizzes()
    const first = newQuiz()
    quizzes.replace('C1', first)
    await first.startChannelQuiz('U1')
    first.abort()

    expect(first.isFinished()).toBe(true)
    expect(quizzes.get('C1')).toBe(first)
    expect(quizzes.running('C1')).toBeUndefined()
    expect(first.getMessageTs()).toBe('1234567890.123')
    expect(first.getRecap('U1')).toHaveLength(1)

    const second = newQuiz()
    quizzes.replace('C1', second)
    expect(quizzes.get('C1')).toBe(second)
    second.abort()
  })

  it('reports a running quiz', async () => {
    const quizzes = new ChannelQuizzes()
    const quiz = newQuiz()
    quizzes.replace('C1', quiz)
    await quiz.startChannelQuiz('U1')

    expect(quizzes.running('C1')).toBe(quiz)
    quiz.abort()
  })

  it('discards a quiz only if it is still the channel\'s current one', () => {
    const quizzes = new ChannelQuizzes()
    const first = newQuiz()
    const second = newQuiz()
    quizzes.replace('C1', first)
    quizzes.replace('C1', second)

    quizzes.discard('C1', first)
    expect(quizzes.get('C1')).toBe(second)

    quizzes.discard('C1', second)
    expect(quizzes.get('C1')).toBeUndefined()
    first.abort()
    second.abort()
  })
})
