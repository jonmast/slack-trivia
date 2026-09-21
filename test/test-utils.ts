import type { QuestionSource, TriviaQuestion } from '../src/trivia-core'

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

/** A QuestionSource serving the given questions in order, refilling with fresh ones if exhausted. */
export const createQuestionSource = (questions: TriviaQuestion[] = createMockQuestions()): QuestionSource => {
  const queue = [...questions]
  return {
    get: () => queue.shift() ?? createMockTriviaQuestion(),
  }
}