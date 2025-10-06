import crypto from 'node:crypto'

export type TriviaQuestion = {
  category: string
  id: string
  correctAnswer: string
  incorrectAnswers: [string, string, string]
  question: {
    text: string
  }
  tags: string[]
  type: "text_choice"
  difficulty: "easy" | "medium" | "hard"
  regions: string[]
  isNiche: boolean
}

export type Answer = {
  id: string
  text: string
}

export type Response = {
  userId: string
  answerId: string
  timestamp: Date
}

export type UserScore = {
  userId: string
  score: number
  totalAnswered: number
}

export type QuizState = {
  users: Set<string>
  userScores: Map<string, UserScore>
  currentQuestion: Question | null
  questions: Question[]
  isActive: boolean
}

export type Question = {
  question: TriviaQuestion
  answers: Answer[]
  correctAnswer: Answer
  responses: Response[]
  timestamp: Date
}

export const TIMEOUT_SECS = 15

export function parseTs(ts: string): Date {
  return new Date(Number(ts) * 1000)
}

export function withId(text: string): Answer {
  return {
    id: crypto.randomUUID(),
    text,
  }
}

export class TriviaStore {
  private cache: TriviaQuestion[] = []

  constructor() {
    this.fetchInitial()
  }

  private async fetchInitial() {
    try {
      const response = await fetch("https://the-trivia-api.com/v2/questions")
      const data = await response.json()
      this.cache = this.cache.concat(data)
    } catch (error) {
      console.error('Failed to fetch initial questions:', error)
    }
  }

  private async fetchMore() {
    try {
      const response = await fetch(
        "https://the-trivia-api.com/v2/questions?limit=10",
      )
      const data = await response.json()
      this.cache = this.cache.concat(data)
    } catch (error) {
      console.error('Failed to fetch more questions:', error)
    }
  }

  get(): TriviaQuestion {
    if (this.cache.length < 3) {
      this.fetchMore()
    }
    const question = this.cache.pop()
    if (!question) {
      throw new Error('No questions available')
    }
    return question
  }

  getCacheSize(): number {
    return this.cache.length
  }

  addToCache(questions: TriviaQuestion[]): void {
    this.cache = this.cache.concat(questions)
  }
}

export function shuffleAnswers(correctAnswer: Answer, incorrectAnswers: Answer[]): Answer[] {
  return [correctAnswer, ...incorrectAnswers].sort(() => Math.random() - 0.5)
}

export function createQuestion(apiQuestion: TriviaQuestion): Question {
  const correctAnswer = withId(apiQuestion.correctAnswer)
  const incorrectAnswers = apiQuestion.incorrectAnswers.map(withId)
  const answers = shuffleAnswers(correctAnswer, incorrectAnswers)

  return {
    question: apiQuestion,
    correctAnswer,
    answers,
    timestamp: new Date(),
    responses: [],
  }
}

export function isCorrectAnswer(question: Question, answerId: string): boolean {
  return question.correctAnswer.id === answerId
}

export function getRemainingTime(question: Question, timeoutSeconds: number = TIMEOUT_SECS): number {
  const elapsed = (Number(new Date()) - Number(question.timestamp)) / 1000
  return Math.max(0, timeoutSeconds - elapsed)
}

export function hasExpired(question: Question, timeoutSeconds: number = TIMEOUT_SECS): boolean {
  return getRemainingTime(question, timeoutSeconds) <= 0
}

export class Quiz {
  private state: QuizState
  private store: TriviaStore

  constructor(store: TriviaStore) {
    this.store = store
    this.state = {
      users: new Set(),
      userScores: new Map(),
      currentQuestion: null,
      questions: [],
      isActive: false
    }
  }

  addUser(userId: string): void {
    this.state.users.add(userId)
    if (!this.state.userScores.has(userId)) {
      this.state.userScores.set(userId, {
        userId,
        score: 0,
        totalAnswered: 0
      })
    }
  }

  removeUser(userId: string): void {
    this.state.users.delete(userId)
  }

  getUsers(): string[] {
    return Array.from(this.state.users)
  }

  startQuiz(): Question {
    this.state.isActive = true
    return this.nextQuestion()
  }

  nextQuestion(): Question {
    const apiQuestion = this.store.get()
    const question = createQuestion(apiQuestion)
    this.state.currentQuestion = question
    this.state.questions.push(question)
    return question
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date): boolean {
    if (!this.state.currentQuestion || !this.state.isActive) {
      throw new Error('No active question')
    }

    if (hasExpired(this.state.currentQuestion)) {
      throw new Error('Question has expired')
    }

    // Check if user already answered
    const existingResponse = this.state.currentQuestion.responses.find(r => r.userId === userId)
    if (existingResponse) {
      throw new Error('User has already answered this question')
    }

    const response: Response = { userId, answerId, timestamp }
    this.state.currentQuestion.responses.push(response)

    // Update score
    const userScore = this.state.userScores.get(userId)
    if (userScore) {
      userScore.totalAnswered++
      if (isCorrectAnswer(this.state.currentQuestion, answerId)) {
        userScore.score++
      }
    }

    return isCorrectAnswer(this.state.currentQuestion, answerId)
  }

  getCurrentQuestion(): Question | null {
    return this.state.currentQuestion
  }

  getQuestions(): Question[] {
    return [...this.state.questions]
  }

  getUserScores(): UserScore[] {
    return Array.from(this.state.userScores.values())
  }

  getUserScore(userId: string): UserScore | undefined {
    return this.state.userScores.get(userId)
  }

  isActive(): boolean {
    return this.state.isActive
  }

  endQuiz(): void {
    this.state.isActive = false
  }

  getLeaderboard(): UserScore[] {
    return this.getUserScores().sort((a, b) => b.score - a.score)
  }
}