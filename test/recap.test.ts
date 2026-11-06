import { describe, it, expect, beforeEach } from 'vitest'
import { Quiz, SPEED_BONUS_MAX, type QuestionSource, type RecapQuestion } from '../src/trivia-core'
import { renderRecapModal, renderFinalSummary } from '../src/slack-ui'
import { createMockQuestions, createQuestionSource } from './test-utils'

describe('Quiz.getRecap', () => {
  let store: QuestionSource
  let quiz: Quiz

  beforeEach(() => {
    store = createQuestionSource(createMockQuestions(3))
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

  it('awards a point and a separate speed bonus for a correct answer', () => {
    const q = quiz.startQuiz()
    const halfway = new Date(q.timestamp.getTime() + 5_000)
    quiz.submitAnswer('u1', q.correctAnswer.id, halfway)

    const [entry] = quiz.getRecap('u1')

    expect(entry.options.find((o) => o.correct)).toMatchObject({ selected: true })
    expect(entry.points).toBe(1)
    expect(entry.speedBonus).toBeCloseTo(SPEED_BONUS_MAX / 2, 5)
  })

  it('awards zero for a wrong answer', () => {
    const q = quiz.startQuiz()
    const wrong = q.answers.find((a) => a.id !== q.correctAnswer.id)!
    quiz.submitAnswer('u1', wrong.id, q.timestamp)

    expect(quiz.getRecap('u1')[0]).toMatchObject({ points: 0, speedBonus: 0 })
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
    expect(entry.points).toBe(1)
    expect(entry.speedBonus).toBeCloseTo(SPEED_BONUS_MAX, 5)
  })

  it('still works after the quiz has ended', () => {
    const q = quiz.startQuiz()
    quiz.submitAnswer('u1', q.correctAnswer.id, q.timestamp)
    quiz.endQuiz()

    expect(quiz.getRecap('u1')[0].answered).toBe(true)
  })

  it('gives a non-participant the full quiz with nothing selected and zero points', () => {
    const q1 = quiz.startQuiz()
    quiz.submitAnswer('u1', q1.correctAnswer.id, q1.timestamp)
    quiz.nextQuestion()
    quiz.nextQuestion()
    quiz.endQuiz()

    const recap = quiz.getRecap('nobody')

    expect(recap).toHaveLength(3)
    for (const entry of recap) {
      expect(entry.answered).toBe(false)
      expect(entry.points).toBe(0)
      expect(entry.speedBonus).toBe(0)
      expect(entry.options).toHaveLength(4)
      expect(entry.options.filter((o) => o.selected)).toHaveLength(0)
      expect(entry.options.filter((o) => o.correct)).toHaveLength(1)
    }
  })
})

describe('renderRecapModal', () => {
  const recap: RecapQuestion[] = [
    {
      text: 'Right one?',
      answered: true,
      points: 1,
      speedBonus: 0.16,
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
      speedBonus: 0,
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
      speedBonus: 0,
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

  it('summarises total points, the speed bonus apart from them, and questions answered', () => {
    const view = renderRecapModal(recap)
    expect(sectionText(view.blocks[0])).toBe('*1 pt* · ⚡ 0.16 speed bonus · 2/3 answered')
  })

  it('marks a selected correct option with ✅ and leaves the rest plain', () => {
    const text = sectionText(renderRecapModal(recap).blocks[2])
    expect(text).toContain('*1. Right one?*')
    expect(text).toContain('_1 pt · ⚡ 0.16_')
    expect(text).toContain('✅ A')
    expect(text).not.toContain('💡')
    expect(text).not.toContain('❌')
  })

  it('marks a selected wrong option with ❌ and the missed correct one with 💡', () => {
    const text = sectionText(renderRecapModal(recap).blocks[3])
    expect(text).toContain('_0 pts_')
    expect(text).not.toContain('⚡')
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

  it('renders a non-participant recap with 💡 only, "(no answer)" on every question, and zero total', () => {
    const untouched = recap.map((entry) => ({
      ...entry,
      answered: false,
      points: 0,
      speedBonus: 0,
      options: entry.options.map((o) => ({ ...o, selected: false })),
    }))

    const view = renderRecapModal(untouched)
    const questionBlocks = view.blocks.slice(2)

    expect(sectionText(view.blocks[0])).toContain('*0 pts*')
    expect(sectionText(view.blocks[0])).toContain('0/3 answered')
    expect(questionBlocks).toHaveLength(3)
    for (const block of questionBlocks) {
      const text = sectionText(block)
      expect(text).toContain('(no answer)')
      expect(text).toContain('💡')
      expect(text).not.toContain('✅')
      expect(text).not.toContain('❌')
    }
  })
})

describe('renderFinalSummary leaderboard', () => {
  const leaderboardText = (blocks: any[]) => blocks[1].text.text as string

  it('ranks by points, lists the speed bonus separately and says it only breaks ties', () => {
    const blocks = renderFinalSummary(
      [
        { userId: 'U-SPEEDY', score: 9, speedBonus: 1.8, totalAnswered: 10 },
        { userId: 'U-TIED-SLOW', score: 10, speedBonus: 0.04, totalAnswered: 10 },
        { userId: 'U-TIED-FAST', score: 10, speedBonus: 0.5, totalAnswered: 10 },
      ],
      10,
      '1234567890.123',
    )

    expect(leaderboardText(blocks).split('\n').slice(1)).toEqual([
      '1. <@U-TIED-FAST>: 10 points · ⚡ 0.50 · 10/10 answered',
      '2. <@U-TIED-SLOW>: 10 points · ⚡ 0.04 · 10/10 answered',
      '3. <@U-SPEEDY>: 9 points · ⚡ 1.80 · 10/10 answered',
    ])
    expect(blocks[2]).toMatchObject({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: expect.stringContaining('only breaks ties') }],
    })
  })

  it('skips the tie-break note when nobody played', () => {
    const blocks = renderFinalSummary([], 3, '1234567890.123')
    expect(leaderboardText(blocks)).toContain('No participants')
    expect(blocks.some((b) => b.type === 'context')).toBe(false)
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
