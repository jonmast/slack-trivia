import { describe, it, expect } from 'vitest'
import { optionLabel, OPTION_TEXT_MAX, renderChannelQuestion } from '../src/slack-ui'
import type { Question } from '../src/trivia-core'
import { createMockTriviaQuestion } from './test-utils'

describe('optionLabel', () => {
  it('returns short text unchanged', () => {
    expect(optionLabel('Short answer')).toBe('Short answer')
  })

  it('returns text of exactly 75 characters unchanged', () => {
    const text = 'a'.repeat(OPTION_TEXT_MAX)
    expect(optionLabel(text)).toBe(text)
    expect(optionLabel(text).length).toBe(OPTION_TEXT_MAX)
  })

  it('truncates text longer than 75 characters to <= 75 ending in …', () => {
    const result = optionLabel('a'.repeat(80))
    expect(result.length).toBeLessThanOrEqual(OPTION_TEXT_MAX)
    expect(result.endsWith('…')).toBe(true)
    expect(result).toBe('a'.repeat(OPTION_TEXT_MAX - 1) + '…')
  })

  it('trims trailing whitespace before appending …', () => {
    const result = optionLabel('b'.repeat(73) + '   ')
    expect(result.length).toBeLessThanOrEqual(OPTION_TEXT_MAX)
    expect(result.endsWith('…')).toBe(true)
    expect(result).toBe('b'.repeat(73) + '…')
  })
})

describe('renderChannelQuestion', () => {
  it('produces option texts all <= 75 chars for a long answer', () => {
    const longText = 'x'.repeat(200)

    const question: Question = {
      question: createMockTriviaQuestion({ id: 'q1' }),
      answers: [
        { id: 'a1', text: longText },
        { id: 'a2', text: 'short' },
      ],
      correctAnswer: { id: 'a1', text: longText },
      responses: [],
      timestamp: new Date(),
    }

    const blocks = renderChannelQuestion(question, 10, 1, 2, 'https://trivia.test/countdown/10.gif')
    const options = (blocks[1] as any).accessory.options
    expect(options).toHaveLength(2)

    for (const option of options) {
      expect(option.text.text.length).toBeLessThanOrEqual(OPTION_TEXT_MAX)
    }
  })
})