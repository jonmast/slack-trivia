import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import {
  withId,
  shuffleAnswers,
  createQuestion,
  isCorrectAnswer,
  getRemainingTime,
  hasExpired,
  TriviaQuestion
} from '../src/trivia-core'
import { TIMEOUT_SECS } from '../src/timing'

describe('Utility Functions', () => {
  describe('withId', () => {
    it('should create Answer object with UUID and text', () => {
      const text = 'Test answer'
      const answer = withId(text)
      
      expect(answer).toHaveProperty('id')
      expect(answer).toHaveProperty('text', text)
      expect(answer.id).toEqual(expect.any(String))
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
    id: 'test-1',
    correctAnswer: 'Correct Answer',
    incorrectAnswers: ['Wrong1', 'Wrong2', 'Wrong3'],
    question: { text: 'What is the test question?' }
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

describe('TriviaQuestion', () => {
  const decode = Schema.decodeUnknownSync(TriviaQuestion)

  const payload = {
    category: 'science',
    id: '622a1c357cc59eab6f94fd8e',
    correctAnswer: 'Mercury',
    incorrectAnswers: ['Venus', 'Mars', 'Jupiter'],
    question: { text: 'Which planet is closest to the Sun?' },
    tags: ['space'],
    type: 'text_choice',
    difficulty: 'easy',
    regions: [],
    isNiche: false,
  }

  it('decodes a question as The Trivia API sends it, keeping what the app reads', () => {
    expect(decode(payload)).toEqual({
      id: '622a1c357cc59eab6f94fd8e',
      category: 'science',
      correctAnswer: 'Mercury',
      incorrectAnswers: ['Venus', 'Mars', 'Jupiter'],
      question: { text: 'Which planet is closest to the Sun?' },
    })
  })

  it('tolerates changes to fields the app never reads', () => {
    const changed = {
      ...payload,
      tags: null,
      type: 'image_choice',
      difficulty: 'impossible',
      isNiche: 'sometimes',
    }

    expect(decode(changed)).toEqual(decode(payload))
  })

  it('drops a category it cannot read, since only screening uses it', () => {
    const { category: _, ...expected } = decode(payload)

    expect(decode({ ...payload, category: undefined })).toStrictEqual(expected)
    expect(decode({ ...payload, category: 42 })).toStrictEqual(expected)
    expect(decode({ ...payload, category: 'science' })).toEqual({ ...expected, category: 'science' })
  })

  it('rejects a payload it could not ask', () => {
    expect(() => decode({ ...payload, incorrectAnswers: ['Venus', 'Mars'] })).toThrow(Schema.SchemaError)
    expect(() => decode({ ...payload, question: 'Which planet?' })).toThrow(Schema.SchemaError)
    expect(() => decode({ ...payload, correctAnswer: undefined })).toThrow(Schema.SchemaError)
  })
})
