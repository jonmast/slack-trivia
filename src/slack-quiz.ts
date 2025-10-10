import { WebClient, HomeView } from "@slack/web-api"
import { Logger } from "@slack/bolt"
import { Quiz, TriviaStore, Question, TIMEOUT_SECS, getRemainingTime, getElapsedTime, QuizCompleteError } from "./trivia-core"
import { renderQuestion, renderResults, renderChannelQuestion, renderChannelResults, renderFinalSummary, renderFinalSummaryHome } from "./slack-ui"

export class SlackQuiz {
  private quiz: Quiz
  private tick: NodeJS.Timeout
  private cachedRender: string | undefined
  private userViews: Map<string, string> = new Map() // userId -> viewId
  private messageTs: string | undefined // For channel message updates
  private userAnswers: Map<string, string> = new Map() // userId -> answerId for current question
  private isAdvancing: boolean = false
  private timeoutSecs: number
  private state:
    | { type: "initial" }
    | {
        type: "question"
        question: Question
      }
    | {
        type: "processing"
        question: Question
      }
    | {
        type: "results"
        question: Question
      }
    | { type: "complete" }

  constructor(
    private client: WebClient,
    private logger: Logger,
    private store: TriviaStore,
    private channelId?: string,
    private onQuizEnd?: () => void,
    maxQuestions: number = 3,
    timeoutSecs: number = TIMEOUT_SECS,
  ) {
    this.quiz = new Quiz(store, maxQuestions)
    this.timeoutSecs = timeoutSecs
    this.state = { type: "initial" }
    this.tick = setInterval(() => {
      this.isChannelMode() ? this.updateChannelMessage() : this.updateView()
    }, 100)
  }

  async initialize(user: string): Promise<void> {
    this.quiz.addUser(user)

    if (this.state.type !== "initial") {
      await this.addUserToExistingQuiz(user)
      return
    }

    const question = this.quiz.startQuiz()

    const view = await this.client.views.publish({
      user_id: user,
      view: renderQuestion(question, this.timeoutSecs),
    })

    if (view.ok) {
      if (!view.view?.id) {
        throw new Error("No view returned")
      }

      this.userViews.set(user, view.view.id)
      this.state = {
        type: "question",
        question,
      }
    } else {
      console.error(view.error)
    }
  }

  private async addUserToExistingQuiz(user: string): Promise<void> {
    let view: HomeView

    if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, this.timeoutSecs)
      view = renderQuestion(this.state.question, Math.max(0, remaining))
    } else if (this.state.type === "processing") {
      view = renderQuestion(this.state.question, 0, true)
    } else if (this.state.type === "results") {
      const userScores = this.quiz.getUserScores()
      view = renderResults(this.state.question, userScores)
    } else {
      throw new Error("Cannot add user to quiz in initial state")
    }

    const result = await this.client.views.publish({
      user_id: user,
      view,
    })

    if (result.ok && result.view?.id) {
      this.userViews.set(user, result.view.id)
    }
  }

  async advance() {
    if (this.isAdvancing) {
      console.log('[SlackQuiz] advance() already in progress, skipping')
      return
    }
    
    this.isAdvancing = true
    console.log('[SlackQuiz] advance() called from state:', this.state.type)
    try {
      const question = this.quiz.nextQuestion()
      console.log('[SlackQuiz] nextQuestion() succeeded, transitioning to new question')

      if (this.state.type !== "question" && this.state.type !== "results") {
        throw new Error("Cannot advance from non-question state")
      }

      if (this.isChannelMode()) {
        if (!this.messageTs) {
          throw new Error("No message timestamp available for update")
        }

try {
           const progress = this.quiz.getProgress();
const blocks = renderChannelQuestion(question, this.timeoutSecs, Math.min(progress.current, progress.total), progress.total);
           await this.client.chat.update({
             channel: this.channelId!,
             ts: this.messageTs,
             blocks,
             text: `Trivia Question: ${question.question.question.text}`,
           })
          this.userAnswers.clear()
        } catch (error) {
          throw new Error("Failed to update channel question")
        }
      }

      this.state = {
        type: "question",
        question: question,
      }
    } catch (error) {
      if (error instanceof QuizCompleteError) {
        console.log('[SlackQuiz] Quiz complete, transitioning to complete state')
        this.logger.info("Quiz completed, showing final summary")
        
        this.state = { type: "complete" }
        
        setTimeout(() => {
          console.log('[SlackQuiz] Grace period expired, calling abort() to end quiz')
          this.abort()
        }, 5000)
        
        if (this.isChannelMode() && this.channelId && this.messageTs) {
          const leaderboard = this.quiz.getLeaderboard()
          const totalQuestions = this.quiz.getMaxQuestions()
          
          await this.client.chat.update({
            channel: this.channelId,
            ts: this.messageTs,
            blocks: renderFinalSummary(leaderboard, totalQuestions),
            text: "🎉 Trivia quiz completed! Thanks for playing!",
          })
          
          if (this.onQuizEnd) {
            this.onQuizEnd()
          }
        } else {
          const leaderboard = this.quiz.getLeaderboard()
          const totalQuestions = this.quiz.getMaxQuestions()
          
          for (const [userId, viewId] of this.userViews.entries()) {
            try {
              await this.client.views.update({
                view_id: viewId,
                view: renderFinalSummaryHome(leaderboard, totalQuestions),
              })
            } catch (err) {
              this.logger.error(`Failed to update view for user ${userId}:`, err)
            }
          }
          
          if (this.onQuizEnd) {
            this.onQuizEnd()
          }
        }
        return
      }
      throw error
    } finally {
      this.isAdvancing = false
    }
  }

  updateView(): void {
    if (this.state.type === "initial") {
      console.log("pending initialization")
    } else if (this.state.type === "complete") {
      console.log('[SlackQuiz] Quiz complete, not calling advance()')
    } else if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, this.timeoutSecs)
      if (remaining <= 0) {
        console.log('[SlackQuiz] Question timeout - transitioning to processing state')
        this.state = {
          type: "processing",
          question: this.state.question,
        }
        setTimeout(() => {
          if (this.state.type === "processing") {
            console.log('[SlackQuiz] Processing complete - transitioning to results state')
            this.state = {
              type: "results",
              question: this.state.question,
            }
          }
        }, 1500)
        return
      }

      const rendered = renderQuestion(this.state.question, remaining)
      const json = JSON.stringify(rendered)

      if (json === this.cachedRender) {
        this.logger.debug("No change in view")
      } else {
        this.cachedRender = json
        this.updateAllUserViews(rendered)
      }
    } else if (this.state.type === "processing") {
      const rendered = renderQuestion(this.state.question, 0, true)
      this.updateAllUserViews(rendered)
    } else if (this.state.type === "results") {
      const elapsed = getElapsedTime(this.state.question)
      if (elapsed - this.timeoutSecs > 8) {
        console.log('[SlackQuiz] Results timeout (8s) - calling advance()')
        this.advance()
        return
      } else {
        const leaderboard = this.quiz.getLeaderboard()
        const rendered = renderResults(this.state.question, leaderboard)
        this.updateAllUserViews(rendered)
      }
    } else {
      throw new Error("Invalid state")
    }
  }

  private updateAllUserViews(view: HomeView): void {
    for (const [userId, viewId] of this.userViews) {
      this.client.views
        .update({
          view,
          view_id: viewId,
        })
        .catch((error) => {
          this.logger.error(`Failed to update view for user ${userId}:`, error)
        })
    }
  }

  isChannelMode(): boolean {
    return !!this.channelId
  }

  async startChannelQuiz(initiatorUserId: string): Promise<void> {
    if (!this.isChannelMode()) {
      throw new Error("Cannot start channel quiz without channel ID")
    }

    this.quiz.addUser(initiatorUserId)
    const question = this.quiz.startQuiz()

const progress = this.quiz.getProgress();
const blocks = renderChannelQuestion(question, this.timeoutSecs, Math.min(progress.current, progress.total), progress.total);
const result = await this.client.chat.postMessage({
       channel: this.channelId!,
       blocks,
       text: `Trivia Question: ${question.question.question.text}`,
     })

    if (result.ok && result.ts) {
      this.messageTs = result.ts
      this.state = {
        type: "question",
        question,
      }
    } else {
      throw new Error("Failed to post channel question")
    }
  }

  private async updateChannelMessage(): Promise<void> {
    if (!this.isChannelMode() || !this.messageTs) {
      return
    }

    if (this.state.type === "initial") {
      this.logger.debug("Channel quiz pending initialization")
    } else if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, this.timeoutSecs)
      if (remaining <= 0) {
        this.state = {
          type: "processing",
          question: this.state.question,
        }
        this.userAnswers.clear()
        setTimeout(() => {
          if (this.state.type === "processing") {
            this.state = {
              type: "results",
              question: this.state.question,
            }
          }
        }, 1500)
        return
      }

      const progress = this.quiz.getProgress();
const rendered = renderChannelQuestion(this.state.question, remaining, Math.min(progress.current, progress.total), progress.total)
      const json = JSON.stringify(rendered)

      if (json === this.cachedRender) {
        this.logger.debug("No change in channel message")
      } else {
        this.cachedRender = json
        try {
          await this.client.chat.update({
            channel: this.channelId!,
            ts: this.messageTs,
            blocks: rendered,
            text: `Trivia Question: ${this.state.question.question.question.text}`,
          })
        } catch (error) {
          this.logger.error("Failed to update channel message:", error)
        }
      }
    } else if (this.state.type === "processing") {
      const progress = this.quiz.getProgress();
const rendered = renderChannelQuestion(this.state.question, 0, Math.min(progress.current, progress.total), progress.total, true)
      const json = JSON.stringify(rendered)
      
      if (json === this.cachedRender) {
        this.logger.debug("No change in channel message")
      } else {
        this.cachedRender = json
        try {
          await this.client.chat.update({
            channel: this.channelId!,
            ts: this.messageTs,
            blocks: rendered,
            text: `Trivia Question: ${this.state.question.question.question.text}`,
          })
        } catch (error) {
          this.logger.error("Failed to update channel message:", error)
        }
      }
    } else if (this.state.type === "results") {
      const elapsed = getElapsedTime(this.state.question)
      const resultsDuration = elapsed - this.timeoutSecs
      console.log('[SlackQuiz] Results state - elapsed:', elapsed.toFixed(1), 's, resultsDuration:', resultsDuration.toFixed(1), 's (threshold: 8s)')
      if (resultsDuration > 8) {
        console.log('[SlackQuiz] Channel results timeout (8s) - calling advance()')
        this.advance()
        return
      } else {
        const leaderboard = this.quiz.getLeaderboard()
        const progress = this.quiz.getProgress();
        const rendered = renderChannelResults(this.state.question, leaderboard, Math.min(progress.current, progress.total), progress.total)
        const json = JSON.stringify(rendered)
        
        if (json === this.cachedRender) {
          this.logger.debug("No change in channel message")
        } else {
          this.cachedRender = json
try {
  await this.client.chat.update({
    channel: this.channelId!,
    ts: this.messageTs,
    blocks: rendered,
    text: `Trivia Question: ${this.state.question.question.question.text}`,
  })
           } catch (error) {
            this.logger.error("Failed to update channel results:", error)
          }
        }
      }
    }
  }

  abort() {
    console.log('[SlackQuiz] abort() called - ending quiz and clearing interval')
    clearInterval(this.tick)
    this.quiz.endQuiz()
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date, questionId?: string) {
    this.quiz.addUser(userId)
    
    if (this.isChannelMode()) {
      this.userAnswers.set(userId, answerId)
    }
    
    return this.quiz.submitAnswer(userId, answerId, timestamp, questionId)
  }
}