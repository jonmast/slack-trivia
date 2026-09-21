import { describe, it, expect } from 'vitest'
import {
  withId,
  shuffleAnswers,
  createQuestion,
  isCorrectAnswer,
  getRemainingTime,
  hasExpired,
  TIMEOUT_SECS,
  type TriviaQuestion
} from '../src/trivia-core'

describe('Utility Functions', () => {
  describe('withId', () => {
    it('should create Answer object with UUID and text', () => {
      const text = 'Test answer'
      const answer = withId(text)
      
      expect(answer).toHaveProperty('id')
      expect(answer).toHaveProperty('text', text)
      expect(typeof answer.id).toBe('string')
      expect(answer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('should generate unique IDs for different calls', () => {
      const answer1 = withId('Answer 1')
      const answer2 = withId('Answer 2')
      
      expect(answer1.id).not.toBe(answer2.id)
    })
  })

  describe('shuffleAnswers', () => {
    it('should return all answers including correct one', () => {
      const correct = withId('Correct')
      const incorrect = [withId('Wrong1'), withId('Wrong2'), withId('Wrong3')]
      
      const shuffled = shuffleAnswers(correct, incorrect)
      
      expect(shuffled).toHaveLength(4)
      expect(shuffled).toContain(correct)
      incorrect.forEach(answer => {
        expect(shuffled).toContain(answer)
      })
    })
  })
})

describe('Question Logic', () => {
  const mockApiQuestion: TriviaQuestion = {
    category: 'Test',
    id: 'test-1',
    correctAnswer: 'Correct Answer',
    incorrectAnswers: ['Wrong1', 'Wrong2', 'Wrong3'],
    question: { text: 'What is the test question?' },
    tags: ['test'],
    type: 'text_choice',
    difficulty: 'easy',
    regions: ['US'],
    isNiche: false
  }

  describe('createQuestion', () => {
    it('should create a Question with shuffled answers', () => {
      const question = createQuestion(mockApiQuestion)
      
      expect(question.question).toBe(mockApiQuestion)
      expect(question.answers).toHaveLength(4)
      expect(question.correctAnswer.text).toBe(mockApiQuestion.correctAnswer)
      expect(question.responses).toEqual([])
      expect(question.timestamp).toBeInstanceOf(Date)
    })

    it('should include correct answer in answers array', () => {
      const question = createQuestion(mockApiQuestion)
      
      expect(question.answers).toContain(question.correctAnswer)
    })

    it('should include all incorrect answers', () => {
      const question = createQuestion(mockApiQuestion)
      const answerTexts = question.answers.map(a => a.text)
      
      mockApiQuestion.incorrectAnswers.forEach(incorrect => {
        expect(answerTexts).toContain(incorrect)
      })
    })
  })

  describe('isCorrectAnswer', () => {
    it('should return true for correct answer ID', () => {
      const question = createQuestion(mockApiQuestion)
      
      const result = isCorrectAnswer(question, question.correctAnswer.id)
      expect(result).toBe(true)
    })

    it('should return false for incorrect answer ID', () => {
      const question = createQuestion(mockApiQuestion)
      const incorrectAnswer = question.answers.find(a => a.id !== question.correctAnswer.id)!
      
      const result = isCorrectAnswer(question, incorrectAnswer.id)
      expect(result).toBe(false)
    })
  })

  describe('getRemainingTime', () => {
    it('should return full timeout for new question', () => {
      const question = createQuestion(mockApiQuestion)
      
      const remaining = getRemainingTime(question)
      expect(remaining).toBeCloseTo(TIMEOUT_SECS, 0)
    })

    it('should return 0 for expired question', () => {
      const question = createQuestion(mockApiQuestion)
      question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 1) * 1000)
      
      const remaining = getRemainingTime(question)
      expect(remaining).toBe(0)
    })

    it('should use custom timeout', () => {
      const question = createQuestion(mockApiQuestion)
      const customTimeout = 30
      
      const remaining = getRemainingTime(question, customTimeout)
      expect(remaining).toBeCloseTo(customTimeout, 0)
    })
  })

  describe('hasExpired', () => {
    it('should return false for new question', () => {
      const question = createQuestion(mockApiQuestion)
      
      expect(hasExpired(question)).toBe(false)
    })

    it('should return true for old question', () => {
      const question = createQuestion(mockApiQuestion)
      question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 1) * 1000)
      
      expect(hasExpired(question)).toBe(true)
    })
  })
})