import { WebClient, Block, KnownBlock } from "@slack/web-api"
import { Logger } from "@slack/bolt"
import {
  Quiz,
  TriviaStore,
  Question,
  RecapQuestion,
  TIMEOUT_SECS,
  getRemainingTime,
  getElapsedTime,
  QuizCompleteError,
} from "./trivia-core"
import {
  renderChannelQuestion,
  renderChannelResults,
  renderFinalSummary,
} from "./slack-ui"
import { countdownGifUrl } from "./countdown"

/** How long the per-question results screen stays up before the next question. */
export const RESULTS_SECS = 5
const TICK_MS = 100

type State =
  | { type: "initial" }
  | { type: "question"; question: Question }
  | { type: "results"; question: Question }
  | { type: "complete" }

export class SlackQuiz {
  private quiz: Quiz
  private tick: NodeJS.Timeout
  private cachedRender: string | undefined
  private messageTs: string | undefined
  private isAdvancing = false
  private finished = false
  private timeoutSecs: number
  private state: State = { type: "initial" }

  constructor(
    private client: WebClient,
    private logger: Logger,
    private store: TriviaStore,
    private channelId: string,
    private onQuizEnd?: () => void,
    maxQuestions: number = 3,
    timeoutSecs: number = TIMEOUT_SECS,
    /** Public base URL serving /countdown/:secs.gif. */
    private countdownBaseUrl?: string,
  ) {
    this.quiz = new Quiz(store, maxQuestions, timeoutSecs)
    this.timeoutSecs = timeoutSecs
    // The tick drives all timing. Nothing inside it may throw or leave a
    // rejected promise behind: an unhandled rejection takes the process down.
    this.tick = setInterval(() => {
      this.channelTick().catch((error) => {
        this.logger.error("Quiz tick failed:", error)
      })
    }, TICK_MS)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** True once the quiz has ended (completed, failed, or aborted). */
  isFinished(): boolean {
    return this.finished
  }

  /** The channel message hosting this quiz, once posted. */
  getMessageTs(): string | undefined {
    return this.messageTs
  }

  getRecap(userId: string): RecapQuestion[] {
    return this.quiz.getRecap(userId)
  }

  abort() {
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    clearInterval(this.tick)
    this.quiz.endQuiz()
    this.state = { type: "complete" }
    this.onQuizEnd?.()
  }

  private async ensureQuestions(): Promise<void> {
    // Test doubles may not implement ensure(); production store does.
    if (typeof this.store.ensure !== "function") return
    const ok = await this.store.ensure(this.quiz.getMaxQuestions())
    if (!ok) {
      throw new Error("Could not load enough trivia questions. Please try again shortly.")
    }
  }

  async startChannelQuiz(initiatorUserId: string): Promise<void> {
    if (!this.countdownBaseUrl) {
      throw new Error("Channel quizzes need a public base URL for the countdown GIFs; run the Worker deployment.")
    }

    await this.ensureQuestions()
    this.quiz.addUser(initiatorUserId)
    const question = this.quiz.startQuiz()

    const result = await this.client.chat.postMessage({
      channel: this.channelId,
      blocks: this.renderChannelQuestionBlocks(question),
      text: this.channelText(question, false),
    })

    if (result.ok && result.ts) {
      this.messageTs = result.ts
      this.startQuestionClock(question)
      this.state = { type: "question", question }
    } else {
      throw new Error("Failed to post channel question")
    }
  }

  /**
   * Start the answer window now that the message is actually in the channel.
   * `createQuestion` stamps the question before the post round-trip, which
   * silently shortens the window by API latency and desyncs it from the pie.
   */
  private startQuestionClock(question: Question): void {
    question.timestamp = new Date()
  }

  private renderChannelQuestionBlocks(question: Question) {
    const { current, total } = this.quiz.getProgress()
    const gifUrl = countdownGifUrl(this.countdownBaseUrl!, this.timeoutSecs, question.question.id)
    return renderChannelQuestion(question, this.timeoutSecs, Math.min(current, total), total, gifUrl)
  }

  private renderChannelResultsBlocks(question: Question) {
    const { current, total } = this.quiz.getProgress()
    const gifUrl = countdownGifUrl(this.countdownBaseUrl!, RESULTS_SECS, `${question.question.id}-results`)
    return renderChannelResults(
      question,
      this.quiz.getLeaderboard(),
      Math.min(current, total),
      total,
      RESULTS_SECS,
      gifUrl,
    )
  }

  /** Notification / accessibility fallback for the current channel frame. */
  private channelText(question: Question, results: boolean): string {
    return results
      ? `Answer: ${question.correctAnswer.text} — ${question.question.question.text}`
      : `Trivia Question: ${question.question.question.text}`
  }

  private async updateChannelMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
    await this.client.chat.update({
      channel: this.channelId,
      ts: this.messageTs!,
      blocks,
      text,
    })
  }

  /** Update the channel message, but only when the rendered blocks changed. */
  private async updateChannelIfChanged(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
    const json = JSON.stringify(blocks)
    if (json === this.cachedRender) return
    this.cachedRender = json
    try {
      await this.updateChannelMessage(blocks, text)
    } catch (error) {
      this.logger.error("Failed to update channel message:", error)
    }
  }

  private async channelTick(): Promise<void> {
    if (!this.messageTs || this.state.type === "initial" || this.state.type === "complete") {
      return
    }

    const question = this.state.question

    if (this.state.type === "question") {
      // The client animates the countdown GIF; editing the message would
      // restart it, so the question frame is left alone until time's up.
      if (getRemainingTime(question, this.timeoutSecs) > 0) return
      this.state = { type: "results", question }
      await this.updateChannelIfChanged(this.renderChannelResultsBlocks(question), this.channelText(question, true))
      return
    }

    // results
    if (this.resultsExpired(question)) {
      await this.advance()
      return
    }
    await this.updateChannelIfChanged(this.renderChannelResultsBlocks(question), this.channelText(question, true))
  }

  private resultsExpired(question: Question): boolean {
    return getElapsedTime(question) - this.timeoutSecs > RESULTS_SECS
  }

  /** Move to the next question, or finish the quiz when none remain. */
  async advance(): Promise<void> {
    if (this.isAdvancing || this.finished) return
    if (this.state.type !== "question" && this.state.type !== "results") {
      throw new Error("Cannot advance from non-question state")
    }

    this.isAdvancing = true
    try {
      let question: Question
      try {
        question = this.quiz.nextQuestion()
      } catch (error) {
        if (error instanceof QuizCompleteError) {
          await this.complete()
          return
        }
        throw error
      }

      if (!this.messageTs) {
        throw new Error("No message timestamp available for update")
      }
      await this.updateChannelMessage(
        this.renderChannelQuestionBlocks(question),
        this.channelText(question, false),
      )
      this.startQuestionClock(question)

      this.state = { type: "question", question }
    } catch (error) {
      // Anything else (API failure, question store ran dry) ends the quiz
      // instead of leaving the channel stuck in a half-state.
      this.logger.error("Quiz failed to advance; ending quiz:", error)
      await this.complete()
    } finally {
      this.isAdvancing = false
    }
  }

  private async complete(): Promise<void> {
    this.state = { type: "complete" }
    this.logger.info("Quiz completed, showing final summary")

    const leaderboard = this.quiz.getLeaderboard()
    const totalQuestions = this.quiz.getMaxQuestions()

    try {
      if (this.messageTs) {
        await this.updateChannelMessage(
          renderFinalSummary(leaderboard, totalQuestions, this.messageTs),
          "🎉 Trivia quiz completed! Thanks for playing!",
        )
      }
    } catch (error) {
      this.logger.error("Failed to render final summary:", error)
    } finally {
      this.finish()
    }
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date, questionId?: string): boolean {
    if (this.state.type === "initial" || this.state.type === "complete") {
      throw new Error("No active quiz")
    }
    this.quiz.addUser(userId)
    return this.quiz.submitAnswer(userId, answerId, timestamp, questionId)
  }
}
