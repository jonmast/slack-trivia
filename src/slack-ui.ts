import { HomeView } from "@slack/web-api"
import { Question, UserScore } from "./trivia-core"

export function renderQuestion(question: Question, countdown: number): HomeView {
  return {
    type: "home",
    blocks: [
      {
        block_id: question.question.id,
        type: "section",
        text: {
          type: "plain_text",
          text: `${question.question.question.text}\n ${countdown.toFixed(0)}`,
        },
        accessory: {
          type: "radio_buttons",
          action_id: "radio_sel",
          options: question.answers.map((answer) => ({
            value: answer.id,
            text: {
              type: "plain_text",
              text: answer.text.substring(0, 150),
            },
          })),
        },
      },
    ],
  }
}

export function renderResults(question: Question, userScores: UserScore[]): HomeView {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${user.score} points`,
    )
    .join("\n")

  return {
    type: "home",
    blocks: [
      {
        block_id: question.question.id,
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${question.question.question.text}*\n\n✅ Correct answer: *${question.correctAnswer.text}*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Leaderboard:*\n${leaderboard || "No scores yet"}`,
        },
      },
    ],
  }
}