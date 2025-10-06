import { WebClient, HomeView } from "@slack/web-api"
import { Logger } from "@slack/bolt"
import { Quiz, TriviaStore, Question, TIMEOUT_SECS, getRemainingTime, getElapsedTime } from "./trivia-core"
import { renderQuestion, renderResults } from "./slack-ui"

export class SlackQuiz {
  private quiz: Quiz
  private tick: NodeJS.Timeout
  private cachedRender: string | undefined
  private userViews: Map<string, string> = new Map() // userId -> viewId
  private state:
    | { type: "initial" }
    | {
        type: "question"
        question: Question
      }
    | {
        type: "results"
        question: Question
      }

  constructor(
    private client: WebClient,
    private logger: Logger,
    private store: TriviaStore,
  ) {
    this.quiz = new Quiz(store)
    this.state = { type: "initial" }
    // Listed rate is "100+", with burst
    this.tick = setInterval(() => {
      this.updateView()
    }, 100)
  }

  async initialize(user: string): Promise<void> {
    this.quiz.addUser(user)

    // If quiz already started, just add user to existing quiz
    if (this.state.type !== "initial") {
      await this.addUserToExistingQuiz(user)
      return
    }

    const question = this.quiz.startQuiz()

    const view = await this.client.views.publish({
      user_id: user,
      view: renderQuestion(question, 30),
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
      // TODO: real error handling
      console.error(view.error)
    }
  }

  private async addUserToExistingQuiz(user: string): Promise<void> {
    let view: HomeView

    if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, TIMEOUT_SECS)
      view = renderQuestion(this.state.question, Math.max(0, remaining))
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
    const question = this.quiz.nextQuestion()

    if (this.state.type !== "question" && this.state.type !== "results") {
      throw new Error("Cannot advance from non-question state")
    }

    this.state = {
      type: "question",
      question: question,
    }
  }

  updateView(): void {
    if (this.state.type === "initial") {
      console.log("pending initialization")
    } else if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, TIMEOUT_SECS)
      if (remaining <= 0) {
        this.state = {
          type: "results",
          question: this.state.question,
        }
        return this.updateView()
      }

      const rendered = renderQuestion(this.state.question, remaining)
      const json = JSON.stringify(rendered)

      if (json === this.cachedRender) {
        this.logger.debug("No change in view")
      } else {
        this.cachedRender = json
        this.updateAllUserViews(rendered)
      }
    } else if (this.state.type === "results") {
      const elapsed = getElapsedTime(this.state.question)
      if (elapsed - TIMEOUT_SECS > 5) {
        this.advance()
        return
      } else {
        const leaderboard = this.quiz.getLeaderboard()
        const rendered = renderResults(this.state.question, leaderboard)
        this.updateAllUserViews(rendered)
      }
      this.logger.info("Results")
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

  abort() {
    clearInterval(this.tick)
    this.quiz.endQuiz()
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date) {
    if (this.state.type !== "question") {
      throw new Error("Cannot submit answer from non-question state")
    }

    this.quiz.addUser(userId) // Ensure user is added to quiz
    return this.quiz.submitAnswer(userId, answerId, timestamp)
  }
}