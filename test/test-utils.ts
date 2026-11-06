import type {
  AnyMessageBlock,
  AnyModalBlock,
  ContextBlock,
  RadioButtons,
  SectionBlock,
} from 'slack-cloudflare-workers'
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

type SlackBlock = AnyMessageBlock | AnyModalBlock

type BlockOfType<Blocks extends SlackBlock, Type extends Blocks['type']> = Extract<Blocks, { type: Type }>

function isBlockOfType<Blocks extends SlackBlock, Type extends Blocks['type']>(
  block: Blocks,
  type: Type,
): block is BlockOfType<Blocks, Type> {
  return block.type === type
}

/** Every block of the given type, in message order. */
export function findBlocks<Blocks extends SlackBlock, Type extends Blocks['type']>(
  blocks: Blocks[],
  type: Type,
): BlockOfType<Blocks, Type>[] {
  return blocks.filter((block) => isBlockOfType(block, type))
}

/** The first block of the given type; fails loudly when the renderer omits it. */
export function findBlock<Blocks extends SlackBlock, Type extends Blocks['type']>(
  blocks: Blocks[],
  type: Type,
): BlockOfType<Blocks, Type> {
  const [block] = findBlocks(blocks, type)

  if (block === undefined) throw new Error(`No ${type} block in message`)

  return block
}

/** The text of a header or section block; other block types carry no plain text. */
export function blockText(block: SlackBlock): string {
  if (block.type !== 'header' && block.type !== 'section') {
    throw new Error(`A ${block.type} block has no text`)
  }

  const text = block.text

  if (text === undefined) throw new Error(`A ${block.type} block has no text`)

  return text.text
}

/** The section's radio_buttons accessory, narrowed by its discriminant. */
export function radioButtons(section: SectionBlock): RadioButtons {
  const accessory = section.accessory

  if (accessory === undefined || accessory.type !== 'radio_buttons') {
    throw new Error('Section has no radio_buttons accessory')
  }

  return accessory
}

function contextTexts(block: ContextBlock): string[] {
  return block.elements.map((element) => (element.type === 'image' ? element.alt_text : element.text))
}

/** Every text field a message emits, in block order, for whitespace checks. */
export function visibleTexts(blocks: AnyMessageBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'header' || block.type === 'section') {
      return block.text === undefined ? [] : [block.text.text]
    }

    if (block.type === 'context') return contextTexts(block)

    return []
  })
}