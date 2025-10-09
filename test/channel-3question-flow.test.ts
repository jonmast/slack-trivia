import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SlackQuiz } from '../src/slack-quiz'
import { TIMEOUT_SECS } from '../src/trivia-core'

const mockClient = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123' }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
  views: {
    publish: vi.fn().mockResolvedValue({ ok: true, view: { id: 'view123' } }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
}

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

let questionCounter = 0
const mockStore = {
  get: vi.fn().mockImplementation(() => {
    questionCounter++
    return {
      category: 'Test',
      id: `test-${questionCounter}`,
      correctAnswer: 'Correct Answer',
      incorrectAnswers: ['Wrong1', 'Wrong2', 'Wrong3'],
      question: { text: `Question ${questionCounter}?` },
      tags: ['test'],
      type: 'text_choice',
      difficulty: 'easy',
      regions: ['US'],
      isNiche: false
    }
  })
}

describe('Channel Quiz - Full 3 Question Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    questionCounter = 0
  })

  it('should complete full 3-question quiz cycle', async () => {
    const onQuizEnd = vi.fn()
    const channelQuiz = new SlackQuiz(
      mockClient as any,
      mockLogger as any,
      mockStore as any,
      'C123456789',
      onQuizEnd
    )

    console.log('\n=== Starting Channel Quiz ===')
    
    // Start quiz with Q1
    await channelQuiz.startChannelQuiz('U12345')
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1)
    expect((channelQuiz as any).state.type).toBe('question')
    console.log('Q1 started, state:', (channelQuiz as any).state.type)

    // Manually trigger question timeout and transition to results
    // Simulate what updateChannelMessage does
    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 2) * 1000)
    
    // Wait for update cycle to detect timeout and transition to processing
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('After Q1 timeout, state:', (channelQuiz as any).state.type)
    
    // Wait for processing -> results transition (1500ms delay)
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect((channelQuiz as any).state.type).toBe('results')
    console.log('Q1 results showing, state:', (channelQuiz as any).state.type)

    // Set elapsed time to trigger results timeout
    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 10) * 1000)
    
    // Wait for results timeout to trigger advance()
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('After Q1 results timeout, state:', (channelQuiz as any).state.type)
    expect((channelQuiz as any).state.type).toBe('question')
    
    // Verify Q2 was created
    const quiz = (channelQuiz as any).quiz
    expect(quiz.getQuestions().length).toBe(2)
    console.log('Q2 started, total questions:', quiz.getQuestions().length)

    // Repeat for Q2
    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 2) * 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect((channelQuiz as any).state.type).toBe('results')
    console.log('Q2 results showing, state:', (channelQuiz as any).state.type)

    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 10) * 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('After Q2 results timeout, state:', (channelQuiz as any).state.type)
    expect((channelQuiz as any).state.type).toBe('question')
    expect(quiz.getQuestions().length).toBe(3)
    console.log('Q3 started, total questions:', quiz.getQuestions().length)

    // Q3 - last question
    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 2) * 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect((channelQuiz as any).state.type).toBe('results')
    console.log('Q3 results showing, state:', (channelQuiz as any).state.type)

    ;(channelQuiz as any).state.question.timestamp = new Date(Date.now() - (TIMEOUT_SECS + 10) * 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('After Q3 results timeout, state:', (channelQuiz as any).state.type)
    
    // Should now be complete
    expect((channelQuiz as any).state.type).toBe('complete')
    console.log('Quiz complete! Final state:', (channelQuiz as any).state.type)

    // Wait for abort to be called (5s grace period)
    await new Promise(resolve => setTimeout(resolve, 5100))
    
    expect(onQuizEnd).toHaveBeenCalled()
    console.log('=== Quiz Ended ===\n')

    channelQuiz.abort()
  }, 30000) // Increase timeout for this long-running test
})
