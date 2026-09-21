import { vi } from 'vitest'
import type { TriviaQuestion } from '../src/trivia-core'

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