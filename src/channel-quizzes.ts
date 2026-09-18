import { SlackQuiz } from "./slack-quiz"

/**
 * One quiz per channel.
 *
 * A finished quiz is deliberately kept until the next `/quizzo` in that
 * channel replaces it: the final summary's Recap button needs it to read
 * from. Do not evict quizzes when they end.
 */
export class ChannelQuizzes {
  private quizzes = new Map<string, SlackQuiz>()

  /** The channel's latest quiz, running or finished. */
  get(channelId: string): SlackQuiz | undefined {
    return this.quizzes.get(channelId)
  }

  /** The channel's quiz only if it is still running. */
  running(channelId: string): SlackQuiz | undefined {
    const quiz = this.quizzes.get(channelId)
    return quiz && !quiz.isFinished() ? quiz : undefined
  }

  replace(channelId: string, quiz: SlackQuiz): void {
    this.quizzes.set(channelId, quiz)
  }

  /** Drop `quiz` from the channel; no-op if another quiz has since replaced it. */
  discard(channelId: string, quiz: SlackQuiz): void {
    if (this.quizzes.get(channelId) === quiz) {
      this.quizzes.delete(channelId)
    }
  }
}
