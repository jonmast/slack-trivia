import { vi, expect } from 'vitest'
import type { HomeView } from '@slack/web-api'
import type { TriviaQuestion, Question, UserScore } from '../src/trivia-core'

export const createMockTriviaQuestion = (overrides: Partial<TriviaQuestion> = {}): TriviaQuestion => ({
  category: 'Test',
  id: 'test-1',
  correctAnswer: 'Correct Answer',
  incorrectAnswers: ['Wrong1', 'Wrong2', 'Wrong3'],
  question: { text: 'What is the test question?' },
  tags: ['test'],
  type: 'text_choice',
  difficulty: 'easy',
  regions: ['US'],
  isNiche: false,
  ...overrides
})

export const createMockQuestions = (count: number = 2): TriviaQuestion[] => 
  Array.from({ length: count }, (_, i) => 
    createMockTriviaQuestion({
      id: `test-${i + 1}`,
      correctAnswer: `Correct Answer ${i + 1}`,
      question: { text: `What is the ${i === 0 ? 'first' : 'second'} test question?` }
    })
  )

export const setupFetchMock = (questions: TriviaQuestion[] = createMockQuestions()) => {
  const mockResponse = {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(questions)
  }
  global.fetch = vi.fn().mockResolvedValue(mockResponse)
  return { mockResponse, questions }
}

export const setupTestEnvironment = () => {
  vi.clearAllMocks()
  return setupFetchMock()
}

export const createExpectedQuestionView = (question: Question, countdown: number): HomeView => ({
  type: 'home',
  blocks: [
    {
      block_id: question.question.id,
      type: 'section',
      text: {
        type: 'plain_text',
        text: `${question.question.question.text}\n ${countdown.toFixed(0)}`,
      },
      accessory: {
        type: 'radio_buttons',
        action_id: 'radio_sel',
        options: question.answers.map((answer) => ({
          value: answer.id,
          text: {
            type: 'plain_text',
            text: answer.text.substring(0, 150),
          },
        })),
      },
    },
  ],
})

export const createExpectedResultsView = (scores: UserScore[]): HomeView => ({
  type: 'home',
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Results:*\n' + scores.map(score => `<@${score.userId}>: ${score.score} points`).join('\n'),
      },
    },
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: 'Next question in 5 seconds...',
      },
    },
  ],
})

export const assertHomeViewStructure = (view: HomeView, expectedType: 'question' | 'results') => {
  expect(view.type).toBe('home')
  expect(view.blocks).toHaveLength(expectedType === 'results' ? 2 : 1)
  expect(view.blocks[0].type).toBe('section')
}