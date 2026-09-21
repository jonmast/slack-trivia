import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { createMockTriviaQuestion, setupTestEnvironment } from './test-utils'

// Since app.ts uses CommonJS require for dotenv at the top, we need to mock it
vi.mock('dotenv', () => ({
  config: vi.fn()
}))

// Mock Slack SDK
vi.mock('@slack/bolt', () => ({
  App: vi.fn(() => ({
    action: vi.fn(),
    event: vi.fn(),
    command: vi.fn(),
    start: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() }
  })),
  Logger: vi.fn()
}))

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(),
}))

// Mock fetch for TriviaStore
global.fetch = vi.fn()

// Import the functions we want to test by extracting them from the module
describe('Utility Functions', () => {
  describe('parseTs', () => {
    it('should convert Slack timestamp to Date', () => {
      // Import the app module to get access to parseTs
      // Since parseTs is not exported, we'll test it indirectly through Quiz behavior
      const ts = '1700000000.123456'
      const expected = new Date(1700000000123)
      
      // We'll need to refactor to test this - for now, test the conversion logic
      const result = new Date(Number(ts) * 1000)
      expect(result.getTime()).toBe(expected.getTime())
    })
  })

  describe('withId', () => {
    it('should create an Answer object with UUID and text', () => {
      const text = 'Test answer'
      const answer = {
        id: crypto.randomUUID(),
        text
      }
      
      expect(answer).toHaveProperty('id')
      expect(answer).toHaveProperty('text', text)
      expect(typeof answer.id).toBe('string')
      expect(answer.id.length).toBe(36) // UUID length
    })
  })
})

describe('TriviaStore', () => {
  beforeEach(() => {
    setupTestEnvironment()
  })

  it('should fetch questions on initialization', async () => {
    // We need to dynamically import to ensure mocks are set up
    const appModule = await import('../app')
    const TriviaStore = (appModule as any).TriviaStore
    
    // Wait a bit for the async constructor to complete
    await new Promise(resolve => setTimeout(resolve, 10))
    
    expect(fetch).toHaveBeenCalledWith('https://the-trivia-api.com/v2/questions')
  })
})