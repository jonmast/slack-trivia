import { describe, it, expect } from 'vitest'
import { renderChannelQuestion, renderChannelResults } from '../src/slack-ui'
import { createMockTriviaQuestion } from './test-utils'

const GIF_URL = 'https://trivia.test/countdown/30.gif?q=x'

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
const blocks = renderChannelQuestion(mockQuestion, 30, 2, 10, GIF_URL)

       expect(blocks).toHaveLength(3)
      
       // First block should be the header
       expect(blocks[0].type).toBe('header')
       expect((blocks[0] as any).text.text).toContain('Question 2/10:')

       // Block 1 should contain question text and radio buttons
       expect(blocks[1].type).toBe('section')
       expect((blocks[1] as any).text.text).toContain('What is the test question?')
       expect((blocks[1] as any).text.text).toContain('🧠')
       expect((blocks[1] as any).text.text).not.toContain('remaining')

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

    it('should render the countdown pie in a context row (no image block chrome)', () => {
      const blocks = renderChannelQuestion(mockQuestion, 15, 2, 10, GIF_URL)
      expect(blocks[2]).toEqual({
        type: 'context',
        elements: [
          { type: 'image', image_url: GIF_URL, alt_text: '15 second countdown' },
          { type: 'mrkdwn', text: '⏱ 15 seconds' },
        ],
      })
    })
  })

  describe('renderChannelResults', () => {
    const mockLeaderboard = [
      { userId: 'U12345', score: 100, speedBonus: 0, totalAnswered: 2 },
      { userId: 'U67890', score: 50, speedBonus: 0, totalAnswered: 2 },
      { userId: 'U11111', score: 0, speedBonus: 0, totalAnswered: 1 }
    ]

    it('should render results with leaderboard', () => {
      const blocks = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3, 8, GIF_URL)

      expect(blocks).toHaveLength(4)

      // First block should be the progress header
      expect(blocks[0].type).toBe('header')
      expect((blocks[0] as any).text.text).toContain('Answer 2/3:')
      // Second block should show correct answer
expect(blocks[2].type).toBe('section')
      expect((blocks[2] as any).text.text).toContain('🏆 *Current Leaderboard:*')
      
    })

    it('should show the answer breakdown with the correct answer marked', () => {
      const answered = {
        ...mockQuestion,
        responses: [
          { userId: 'U1', answerId: 'id-1', timestamp: new Date() },
          { userId: 'U2', answerId: 'id-1', timestamp: new Date() },
          { userId: 'U3', answerId: 'id-3', timestamp: new Date() },
        ],
      }
      const text = (renderChannelResults(answered, mockLeaderboard, 2, 3, 8, GIF_URL)[1] as any).text.text
      expect(text).toContain('✅ *Correct Answer* — 2')
      expect(text).toContain('◻️ Wrong1 — 0')
      expect(text).toContain('◻️ Wrong2 — 1')
      expect(text).toContain('2 of 3 answered correctly')
    })

    it('should say so when nobody answered', () => {
      const text = (renderChannelResults(mockQuestion, mockLeaderboard, 2, 3, 8, GIF_URL)[1] as any).text.text
      expect(text).toContain('Nobody answered in time')
    })

    it('should count down to the next question, or the final results on the last one', () => {
      const mid = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3, 8, GIF_URL)[3] as any
      expect(mid.type).toBe('context')
      expect(mid.elements[0]).toEqual({ type: 'image', image_url: GIF_URL, alt_text: '8 second countdown' })
      expect(mid.elements[1].text).toBe('⏭️ Next question in 8 seconds')

      const last = renderChannelResults(mockQuestion, mockLeaderboard, 3, 3, 8, GIF_URL)[3] as any
      expect(last.elements[1].text).toBe('🏁 Final results in 8 seconds')
    })

    it('should never emit whitespace-only text blocks (Slack rejects them)', () => {
      const all = [
        ...renderChannelQuestion(mockQuestion, 30, 2, 10, GIF_URL),
        ...renderChannelResults(mockQuestion, mockLeaderboard, 2, 3, 8, GIF_URL),
      ]
      for (const block of all as any[]) {
        if (block.text) expect(block.text.text.trim().length).toBeGreaterThan(0)
        for (const el of block.elements ?? []) {
          if (el.type === 'image') expect(el.alt_text.trim().length).toBeGreaterThan(0)
          else expect(el.text.trim().length).toBeGreaterThan(0)
        }
      }
    })

    it('should format leaderboard positions correctly', () => {
      const blocks = renderChannelResults(mockQuestion, mockLeaderboard, 2, 3, 8, GIF_URL)
      const leaderboardText = (blocks[2] as any).text.text

      // Check that positions are numbered correctly
      expect(leaderboardText).toMatch(/1\. <@U12345>/)
      expect(leaderboardText).toMatch(/2\. <@U67890>/)
      expect(leaderboardText).toMatch(/3\. <@U11111>/)
    })

    it('should show whole points, with the speed bonus only ordering ties', () => {
      const blocks = renderChannelResults(mockQuestion, [
        { userId: 'U-SPEEDY', score: 2, speedBonus: 0.4, totalAnswered: 3 },
        { userId: 'U-SLOW', score: 3, speedBonus: 0.1, totalAnswered: 3 },
        { userId: 'U-FAST', score: 3, speedBonus: 0.3, totalAnswered: 3 },
        { userId: 'U-ONE', score: 1, speedBonus: 0, totalAnswered: 3 },
      ], 3, 3, 8, GIF_URL)

      expect((blocks[2] as any).text.text.split('\n').slice(1)).toEqual([
        '1. <@U-FAST>: 3 points',
        '2. <@U-SLOW>: 3 points',
        '3. <@U-SPEEDY>: 2 points',
        '4. <@U-ONE>: 1 point',
      ])
    })
  })
})