import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { Quiz, QuizCompleteError, type QuestionSource } from '../src/trivia-core'
import { createQuestionSource, failureOf } from './test-utils'

describe('Multiplayer functionality', () => {
  let store: QuestionSource
  let quiz: Quiz

  beforeEach(() => {
    store = createQuestionSource()
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
    const question = Effect.runSync(quiz.startQuiz())
    const correctAnswerId = question.correctAnswer.id
    const wrongAnswerId = question.answers.find(a => a.id !== correctAnswerId)!.id

    // user1 answers correctly
    const result1 = Effect.runSync(quiz.submitAnswer('user1', correctAnswerId, new Date()))
    expect(result1).toBe(true)

    // user2 answers incorrectly
    const result2 = Effect.runSync(quiz.submitAnswer('user2', wrongAnswerId, new Date()))
    expect(result2).toBe(false)

    // user3 answers correctly
    const result3 = Effect.runSync(quiz.submitAnswer('user3', correctAnswerId, new Date()))
    expect(result3).toBe(true)

    // Check final scores
    const scores = quiz.getUserScores()
    expect(scores).toHaveLength(3)
    
    const user1Score = scores.find(s => s.userId === 'user1')
    const user2Score = scores.find(s => s.userId === 'user2')
    const user3Score = scores.find(s => s.userId === 'user3')

    expect(user1Score?.score).toBe(1)
    expect(user1Score?.speedBonus).toBeGreaterThan(0.9)
    expect(user1Score?.speedBonus).toBeLessThanOrEqual(1)
    expect(user2Score?.score).toBe(0)
    expect(user2Score?.speedBonus).toBe(0)
    expect(user3Score?.score).toBe(1)
    expect(user3Score?.speedBonus).toBeGreaterThan(0.9)
    expect(user3Score?.speedBonus).toBeLessThanOrEqual(1)
  })

  it('should allow changing answer and update score accordingly', () => {
    quiz.addUser('user1')
    const question = Effect.runSync(quiz.startQuiz())
    const correctAnswerId = question.correctAnswer.id
    const wrongAnswerId = question.answers.find(a => a.id !== correctAnswerId)!.id

    const result1 = Effect.runSync(quiz.submitAnswer('user1', wrongAnswerId, new Date()))
    expect(result1).toBe(false)

    let scores = quiz.getUserScores()
    let userScore = scores.find(s => s.userId === 'user1')
    expect(userScore?.score).toBe(0)
    expect(userScore?.totalAnswered).toBe(1)

    const result2 = Effect.runSync(quiz.submitAnswer('user1', correctAnswerId, new Date()))
    expect(result2).toBe(true)

    scores = quiz.getUserScores()
    userScore = scores.find(s => s.userId === 'user1')
    expect(userScore?.score).toBe(1)
    expect(userScore?.speedBonus).toBeGreaterThan(0.9)
    expect(userScore?.speedBonus).toBeLessThanOrEqual(1)
    expect(userScore?.totalAnswered).toBe(1)
  })

  it('should generate leaderboard correctly', () => {
    quiz.addUser('alice')
    quiz.addUser('bob')
    quiz.addUser('charlie')

    // First question
    let question = Effect.runSync(quiz.startQuiz())
    let correctId = question.correctAnswer.id
    let wrongId = question.answers.find(a => a.id !== correctId)!.id

    Effect.runSync(quiz.submitAnswer('alice', correctId, new Date()))   // alice: 1
    Effect.runSync(quiz.submitAnswer('bob', correctId, new Date()))     // bob: 1
    Effect.runSync(quiz.submitAnswer('charlie', wrongId, new Date()))   // charlie: 0

    // Second question
    question = Effect.runSync(quiz.nextQuestion())
    correctId = question.correctAnswer.id
    wrongId = question.answers.find(a => a.id !== correctId)!.id

    Effect.runSync(quiz.submitAnswer('alice', correctId, new Date()))   // alice: 2
    Effect.runSync(quiz.submitAnswer('bob', wrongId, new Date()))       // bob: 1
    Effect.runSync(quiz.submitAnswer('charlie', correctId, new Date())) // charlie: 1

    const leaderboard = quiz.getLeaderboard()

    expect(leaderboard[0].userId).toBe('alice')
    expect(leaderboard.map((s) => s.score)).toEqual([2, 1, 1])
    expect(leaderboard[0].speedBonus).toBeLessThanOrEqual(1)
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
    const question1 = Effect.runSync(customQuiz.startQuiz())
    expect(customQuiz.isActive()).toBe(true)
    expect(customQuiz.isComplete()).toBe(false)
    
    Effect.runSync(customQuiz.submitAnswer('user1', question1.correctAnswer.id, new Date()))
    
    // Second question - should succeed
    const question2 = Effect.runSync(customQuiz.nextQuestion())
    expect(question2).toBeDefined()
    
    // Third question attempt - should fail with QuizCompleteError
    expect(failureOf(customQuiz.nextQuestion())).toBeInstanceOf(QuizCompleteError)
    
    const progress = customQuiz.getProgress()
    expect(progress.current).toBe(2)
    expect(progress.total).toBe(2)
  })

  it('should fail when trying to add questions beyond limit', () => {
    const maxQuestions = 1
    const customQuiz = new Quiz(store, maxQuestions)
    
    Effect.runSync(customQuiz.startQuiz())
    
    expect(failureOf(customQuiz.nextQuestion())).toBeInstanceOf(QuizCompleteError)
  })

  it('should award speed bonus for faster correct answers', () => {
    quiz.addUser('fast-user')
    quiz.addUser('slow-user')
    
    const question = Effect.runSync(quiz.startQuiz())
    const correctAnswerId = question.correctAnswer.id
    
    const baseTime = question.timestamp.getTime()
    
    const fastTimestamp = new Date(baseTime + 1000)
    Effect.runSync(quiz.submitAnswer('fast-user', correctAnswerId, fastTimestamp))
    
    const slowTimestamp = new Date(baseTime + 4000)
    Effect.runSync(quiz.submitAnswer('slow-user', correctAnswerId, slowTimestamp))
    
    const scores = quiz.getUserScores()
    const fastUserScore = scores.find(s => s.userId === 'fast-user')
    const slowUserScore = scores.find(s => s.userId === 'slow-user')
    
    expect(fastUserScore?.score).toBe(1)
    expect(slowUserScore?.score).toBe(1)
    
    expect(fastUserScore?.speedBonus).toBeGreaterThan(slowUserScore!.speedBonus)
    
    expect(fastUserScore?.speedBonus).toBeCloseTo(4/5, 2)
    
    expect(slowUserScore?.speedBonus).toBeCloseTo(1/5, 2)
  })

  it('should not award speed bonus for incorrect answers', () => {
    quiz.addUser('user1')
    
    const question = Effect.runSync(quiz.startQuiz())
    const wrongAnswerId = question.answers.find(a => a.id !== question.correctAnswer.id)!.id
    
    // Fast wrong answer
    const fastTimestamp = new Date(question.timestamp.getTime() + 100)
    const result = Effect.runSync(quiz.submitAnswer('user1', wrongAnswerId, fastTimestamp))
    
    expect(result).toBe(false)
    
    const scores = quiz.getUserScores()
    const userScore = scores.find(s => s.userId === 'user1')
    
    // Should still be 0 regardless of speed
    expect(userScore?.score).toBe(0)
    expect(userScore?.speedBonus).toBe(0)
  })
})