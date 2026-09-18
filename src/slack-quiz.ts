import { WebClient, HomeView, Block, KnownBlock } from "@slack/web-api"
import { Logger } from "@slack/bolt"
import {
  Quiz,
  TriviaStore,
  Question,
  TIMEOUT_SECS,
  getRemainingTime,
  getElapsedTime,
  QuizCompleteError,
} from "./trivia-core"
import {
  renderQuestion,
  renderResults,
  renderChannelQuestion,
  renderChannelResults,
  renderFinalSummary,
  renderFinalSummaryHome,
} from "./slack-ui"
import { countdownGifUrl } from "./countdown"

/** How long the per-question results screen stays up before the next question. */
export const RESULTS_SECS = 5
/** Home tab only: brief "time's up" beat before revealing the answer. */
const PROCESSING_MS = 1500
const TICK_MS = 100

type State =
  | { type: "initial" }
  | { type: "question"; question: Question }
  | { type: "processing"; question: Question }
  | { type: "results"; question: Question }
  | { type: "complete" }

export class SlackQuiz {
  private quiz: Quiz
  private tick: NodeJS.Timeout
  private cachedRender: string | undefined
  private homeUsers: Set<string> = new Set()
  private messageTs: string | undefined
  private isAdvancing = false
  private finished = false
  private timeoutSecs: number
  private state: State = { type: "initial" }

  constructor(
    private client: WebClient,
    private logger: Logger,
    private store: TriviaStore,
    private channelId?: string,
    private onQuizEnd?: () => void,
    maxQuestions: number = 3,
    timeoutSecs: number = TIMEOUT_SECS,
    /** Public base URL serving /countdown/:secs.gif (required in channel mode). */
    private countdownBaseUrl?: string,
  ) {
    this.quiz = new Quiz(store, maxQuestions, timeoutSecs)
    this.timeoutSecs = timeoutSecs
    // The tick drives all timing. Nothing inside it may throw or leave a
    // rejected promise behind: an unhandled rejection takes the process down.
    this.tick = setInterval(() => {
      const work = this.isChannelMode() ? this.channelTick() : this.updateView()
      Promise.resolve(work).catch((error) => {
        this.logger.error("Quiz tick failed:", error)
      })
    }, TICK_MS)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  isChannelMode(): boolean {
    return !!this.channelId
  }

  /** True once the quiz has ended (completed, failed, or aborted). */
  isFinished(): boolean {
    return this.finished
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

  // ---------------------------------------------------------------------------
  // Home tab mode
  // ---------------------------------------------------------------------------

  async initialize(user: string): Promise<void> {
    this.quiz.addUser(user)
    this.homeUsers.add(user)

    if (this.state.type !== "initial") {
      await this.publishHomeView(user, this.renderHome())
      return
    }

    await this.ensureQuestions()
    const question = this.quiz.startQuiz()
    this.state = { type: "question", question }
    await this.publishHomeView(user, renderQuestion(question, this.timeoutSecs))
  }

  private renderHome(): HomeView {
    switch (this.state.type) {
      case "question":
        return renderQuestion(this.state.question, getRemainingTime(this.state.question, this.timeoutSecs))
      case "processing":
        return renderQuestion(this.state.question, 0, true)
      case "results":
        return renderResults(this.state.question, this.quiz.getLeaderboard())
      case "complete":
        return renderFinalSummaryHome(this.quiz.getLeaderboard(), this.quiz.getMaxQuestions())
      case "initial":
        throw new Error("Cannot render home view before the quiz has started")
    }
  }

  private async publishHomeView(user: string, view: HomeView): Promise<void> {
    const result = await this.client.views.publish({ user_id: user, view })
    if (!result.ok) {
      throw new Error(`views.publish failed: ${result.error}`)
    }
  }

  /** Push a home view to every participant, but only when it actually changed. */
  private pushHomeViewIfChanged(view: HomeView): void {
    const json = JSON.stringify(view)
    if (json === this.cachedRender) return
    this.cachedRender = json
    for (const user of this.homeUsers) {
      this.publishHomeView(user, view).catch((error) => {
        this.logger.error(`Failed to update home view for user ${user}:`, error)
      })
    }
  }

  updateView(): void {
    if (this.state.type === "initial" || this.state.type === "complete") {
      return
    }

    if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, this.timeoutSecs)
      if (remaining <= 0) {
        const question = this.state.question
        this.state = { type: "processing", question }
        setTimeout(() => {
          if (this.state.type === "processing" && this.state.question === question) {
            this.state = { type: "results", question }
          }
        }, PROCESSING_MS)
        return
      }
      this.pushHomeViewIfChanged(renderQuestion(this.state.question, remaining))
      return
    }

    if (this.state.type === "processing") {
      this.pushHomeViewIfChanged(renderQuestion(this.state.question, 0, true))
      return
    }

    // results
    if (this.resultsExpired(this.state.question)) {
      void this.advance()
      return
    }
    this.pushHomeViewIfChanged(renderResults(this.state.question, this.quiz.getLeaderboard()))
  }

  // ---------------------------------------------------------------------------
  // Channel mode
  // ---------------------------------------------------------------------------

  async startChannelQuiz(initiatorUserId: string): Promise<void> {
    if (!this.isChannelMode()) {
      throw new Error("Cannot start channel quiz without channel ID")
    }
    if (!this.countdownBaseUrl) {
      throw new Error("Channel quizzes need COUNTDOWN_BASE_URL so Slack can fetch the countdown timer.")
    }

    await this.ensureQuestions()
    this.quiz.addUser(initiatorUserId)
    const question = this.quiz.startQuiz()

    const result = await this.client.chat.postMessage({
      channel: this.channelId!,
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
      channel: this.channelId!,
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

    if (this.state.type === "question" || this.state.type === "processing") {
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

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

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

      if (this.isChannelMode()) {
        if (!this.messageTs) {
          throw new Error("No message timestamp available for update")
        }
        await this.updateChannelMessage(
          this.renderChannelQuestionBlocks(question),
          this.channelText(question, false),
        )
        this.startQuestionClock(question)
      }

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
      if (this.isChannelMode()) {
        if (this.messageTs) {
          await this.updateChannelMessage(
            renderFinalSummary(leaderboard, totalQuestions),
            "🎉 Trivia quiz completed! Thanks for playing!",
          )
        }
      } else {
        const view = renderFinalSummaryHome(leaderboard, totalQuestions)
        await Promise.all(
          [...this.homeUsers].map((user) =>
            this.publishHomeView(user, view).catch((error) => {
              this.logger.error(`Failed to publish final summary for user ${user}:`, error)
            }),
          ),
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
    if (!this.isChannelMode()) {
      this.homeUsers.add(userId)
    }
    return this.quiz.submitAnswer(userId, answerId, timestamp, questionId)
  }
}
