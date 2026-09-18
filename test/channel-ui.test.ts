import { describe, it, expect } from 'vitest'
import { renderChannelQuestion, renderChannelResults } from '../src/slack-ui'
import { createMockTriviaQuestion } from './test-utils'

describe('Channel UI Components', () => {
  const mockQuestion = {
    question: createMockTriviaQuestion(),
    answers: [
      { id: 'id-1', text: 'Correct Answer' },
      { id: 'id-2', text: 'Wrong1' },
      { id: 'id-3', text: 'Wrong2' },
      { id: 'id-4', text: 'Wrong3' }
    ],
    correctAnswer: { id: 'id-1', text: 'Correct Answer' },
    responses: [],
    timestamp: new Date()
  }

  describe('renderChannelQuestion', () => {
    it('should render channel question with radio buttons', () => {
const blocks = renderChannelQuestion(mockQuestion, 30, 2, 10)

       expect(blocks).toHaveLength(2)
      
       // First block should be the header
       expect(blocks[0].type).toBe('header')
       expect((blocks[0] as any).text.text).toContain('Question 2/10:')

       // Block 1 should contain question text and radio buttons
       expect(blocks[1].type).toBe('section')
       expect((blocks[1] as any).text.text).toContain('What is the test question?')
       expect((blocks[1] as any).text.text).toContain('🧠')
       expect((blocks[1] as any).text.text).toContain('30s remaining')

       // Check accessory radio buttons
       const accessory = (blocks[1] as any).accessory
       expect(accessory.type).toBe('radio_buttons')
       expect(accessory.action_id).toBe('radio_sel')
       expect(accessory.options).toHaveLength(4)
      
       // Check that radio options have correct structure
       accessory.options.forEach((option: any, index: number) => {
         expect(option.value).toBe(mockQuestion.answers[index].id)
         expect(option.text.text).toBe(mockQuestion.answers[index].text)
       })
    })

    it('should show correct countdown in question text', () => {
      const blocks = renderChannelQuestion(mockQuestion, 15, 2, 10)
      expect((blocks[1] as any).text.text).toContain('15s remaining')
    })

    it('should handle zero countdown', () => {
      const blocks = renderChannelQuestion(mockQuestion, 0, 2, 10)
      expect((blocks[1] as any).text.text).toContain('0s remaining')
    })
  })

  describe('renderChannelResults', () => {
    const mockLeaderboard = [
      { userId: 'U12345', score: 100, totalAnswered: 2 },
      { userId: 'U67890', score: 50, totalAnswered: 2 },
      { userId: 'U11111', score: 0, totalAnswered: 1 }
    ]

    it('should render results with leaderboard', () => {
      const blocks = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3)

      expect(blocks).toHaveLength(3)

      // First block should be the progress header
      expect(blocks[0].type).toBe('header')
      expect((blocks[0] as any).text.text).toContain('Answer 2/3:')
      // Second block should show correct answer
expect(blocks[2].type).toBe('section')
      expect((blocks[2] as any).text.text).toContain('🏆 *Current Leaderboard:*')
      
    })

    it('should show correct answer in results', () => {
      const blocks = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3)
      
      expect((blocks[1] as any).text.text).toContain('Correct Answer')
    })

    it('should never emit whitespace-only text blocks (Slack rejects them)', () => {
      const all = [
        ...renderChannelQuestion(mockQuestion, 30, 2, 10),
        ...renderChannelResults(mockQuestion, mockLeaderboard, 2, 3),
      ]
      for (const block of all as any[]) {
        if (block.text) expect(block.text.text.trim().length).toBeGreaterThan(0)
        for (const el of block.elements ?? []) expect(el.text.trim().length).toBeGreaterThan(0)
      }
    })

    it('should format leaderboard positions correctly', () => {
      const blocks = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3)
      const leaderboardText = (blocks[2] as any).text.text

      // Check that positions are numbered correctly
      expect(leaderboardText).toMatch(/1\. <@U12345>/)
      expect(leaderboardText).toMatch(/2\. <@U67890>/)
      expect(leaderboardText).toMatch(/3\. <@U11111>/)
    })
  })
})