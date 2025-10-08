import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TriviaStore, Quiz, SPEED_BONUS_MAX, QuizCompleteError, type TriviaQuestion } from '../src/trivia-core'
import { createMockQuestions, setupTestEnvironment } from './test-utils'

// Mock fetch globally
global.fetch = vi.fn()

const mockQuestions = createMockQuestions()

describe('Multiplayer functionality', () => {
  let store: TriviaStore
  let quiz: Quiz

  beforeEach(() => {
    setupTestEnvironment()
    
    store = new TriviaStore()
    quiz = new Quiz(store)
  })

  it('should track multiple users and their scores', () => {
    // Add multiple users
    quiz.addUser('user1')
    quiz.addUser('user2')
    quiz.addUser('user3')

    const users = quiz.getUsers()
    expect(users).toEqual(['user1', 'user2', 'user3'])

    // Start quiz and submit answers
    const question = quiz.startQuiz()
    const correctAnswerId = question.correctAnswer.id
    const wrongAnswerId = question.answers.find(a => a.id !== correctAnswerId)!.id

    // user1 answers correctly
    const result1 = quiz.submitAnswer('user1', correctAnswerId, new Date())
    expect(result1).toBe(true)

    // user2 answers incorrectly
    const result2 = quiz.submitAnswer('user2', wrongAnswerId, new Date())
    expect(result2).toBe(false)

    // user3 answers correctly
    const result3 = quiz.submitAnswer('user3', correctAnswerId, new Date())
    expect(result3).toBe(true)

    // Check final scores
    const scores = quiz.getUserScores()
    expect(scores).toHaveLength(3)
    
    const user1Score = scores.find(s => s.userId === 'user1')
    const user2Score = scores.find(s => s.userId === 'user2')
    const user3Score = scores.find(s => s.userId === 'user3')

    expect(user1Score?.score).toBeGreaterThanOrEqual(1)
    expect(user1Score?.score).toBeLessThanOrEqual(1 + SPEED_BONUS_MAX)
    expect(user2Score?.score).toBe(0)
    expect(user3Score?.score).toBeGreaterThanOrEqual(1)
    expect(user3Score?.score).toBeLessThanOrEqual(1 + SPEED_BONUS_MAX)
  })

  it('should allow changing answer and update score accordingly', () => {
    quiz.addUser('user1')
    const question = quiz.startQuiz()
    const correctAnswerId = question.correctAnswer.id
    const wrongAnswerId = question.answers.find(a => a.id !== correctAnswerId)!.id

    const result1 = quiz.submitAnswer('user1', wrongAnswerId, new Date())
    expect(result1).toBe(false)

    let scores = quiz.getUserScores()
    let userScore = scores.find(s => s.userId === 'user1')
    expect(userScore?.score).toBe(0)
    expect(userScore?.totalAnswered).toBe(1)

    const result2 = quiz.submitAnswer('user1', correctAnswerId, new Date())
    expect(result2).toBe(true)

    scores = quiz.getUserScores()
    userScore = scores.find(s => s.userId === 'user1')
    expect(userScore?.score).toBeGreaterThanOrEqual(1)
    expect(userScore?.score).toBeLessThanOrEqual(1 + SPEED_BONUS_MAX)
    expect(userScore?.totalAnswered).toBe(1)
  })

  it('should generate leaderboard correctly', () => {
    quiz.addUser('alice')
    quiz.addUser('bob')
    quiz.addUser('charlie')

    // First question
    let question = quiz.startQuiz()
    let correctId = question.correctAnswer.id
    let wrongId = question.answers.find(a => a.id !== correctId)!.id

    quiz.submitAnswer('alice', correctId, new Date())   // alice: 1
    quiz.submitAnswer('bob', correctId, new Date())     // bob: 1  
    quiz.submitAnswer('charlie', wrongId, new Date())   // charlie: 0

    // Second question
    question = quiz.nextQuestion()
    correctId = question.correctAnswer.id
    wrongId = question.answers.find(a => a.id !== correctId)!.id

    quiz.submitAnswer('alice', correctId, new Date())   // alice: 2
    quiz.submitAnswer('bob', wrongId, new Date())       // bob: 1
    quiz.submitAnswer('charlie', correctId, new Date()) // charlie: 1

    const scores = quiz.getUserScores()
    const sortedScores = scores.sort((a, b) => b.score - a.score)

    expect(sortedScores[0].userId).toBe('alice')
    expect(sortedScores[0].score).toBeGreaterThanOrEqual(2)
    expect(sortedScores[0].score).toBeLessThan(2 + 2 * SPEED_BONUS_MAX + 0.01)
    expect(sortedScores[1].score).toBeGreaterThanOrEqual(1)
    expect(sortedScores[1].score).toBeLessThanOrEqual(1 + SPEED_BONUS_MAX)
    expect(sortedScores[2].score).toBeGreaterThanOrEqual(1)
    expect(sortedScores[2].score).toBeLessThanOrEqual(1 + SPEED_BONUS_MAX)
  })

  it('should have a configurable maximum number of questions', () => {
    const maxQuestions = 3
    const customQuiz = new Quiz(store, maxQuestions)
    
    expect(customQuiz.getMaxQuestions()).toBe(maxQuestions)
    expect(customQuiz.isComplete()).toBe(false)
    
    const progress = customQuiz.getProgress()
    expect(progress.current).toBe(0)
    expect(progress.total).toBe(maxQuestions)
  })

  it('should end quiz automatically when max questions reached', () => {
    const maxQuestions = 2
    const customQuiz = new Quiz(store, maxQuestions)
    customQuiz.addUser('user1')
    
    // First question
    const question1 = customQuiz.startQuiz()
    expect(customQuiz.isActive()).toBe(true)
    expect(customQuiz.isComplete()).toBe(false)
    
    customQuiz.submitAnswer('user1', question1.correctAnswer.id, new Date())
    
    // Second question - should succeed
    const question2 = customQuiz.nextQuestion()
    expect(question2).toBeDefined()
    
    // Third question attempt - should throw QuizCompleteError
    expect(() => {
      customQuiz.nextQuestion()
    }).toThrow(QuizCompleteError)
    
    const progress = customQuiz.getProgress()
    expect(progress.current).toBe(2)
    expect(progress.total).toBe(2)
  })

  it('should throw error when trying to add questions beyond limit', () => {
    const maxQuestions = 1
    const customQuiz = new Quiz(store, maxQuestions)
    
    customQuiz.startQuiz()
    
    expect(() => {
      customQuiz.nextQuestion()
    }).toThrow(QuizCompleteError)
  })

  it('should award speed bonus for faster correct answers', () => {
    quiz.addUser('fast-user')
    quiz.addUser('slow-user')
    
    const question = quiz.startQuiz()
    const correctAnswerId = question.correctAnswer.id
    
    const baseTime = question.timestamp.getTime()
    
    const fastTimestamp = new Date(baseTime + 1000)
    quiz.submitAnswer('fast-user', correctAnswerId, fastTimestamp)
    
    const slowTimestamp = new Date(baseTime + 4000)
    quiz.submitAnswer('slow-user', correctAnswerId, slowTimestamp)
    
    const scores = quiz.getUserScores()
    const fastUserScore = scores.find(s => s.userId === 'fast-user')
    const slowUserScore = scores.find(s => s.userId === 'slow-user')
    
    expect(fastUserScore?.score).toBeGreaterThan(1)
    expect(slowUserScore?.score).toBeGreaterThan(1)
    
    expect(fastUserScore?.score).toBeGreaterThan(slowUserScore!.score)
    
    expect(fastUserScore?.score).toBeCloseTo(1 + (4/5 * SPEED_BONUS_MAX), 2)
    
    expect(slowUserScore?.score).toBeCloseTo(1 + (1/5 * SPEED_BONUS_MAX), 2)
  })

  it('should not award speed bonus for incorrect answers', () => {
    quiz.addUser('user1')
    
    const question = quiz.startQuiz()
    const wrongAnswerId = question.answers.find(a => a.id !== question.correctAnswer.id)!.id
    
    // Fast wrong answer
    const fastTimestamp = new Date(question.timestamp.getTime() + 100)
    const result = quiz.submitAnswer('user1', wrongAnswerId, fastTimestamp)
    
    expect(result).toBe(false)
    
    const scores = quiz.getUserScores()
    const userScore = scores.find(s => s.userId === 'user1')
    
    // Should still be 0 regardless of speed
    expect(userScore?.score).toBe(0)
  })
})