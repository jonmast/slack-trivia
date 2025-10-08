import { HomeView, Block, KnownBlock } from "@slack/web-api"
import { Question, UserScore } from "./trivia-core"

export function renderQuestion(question: Question, countdown: number, disabled: boolean = false): HomeView {
  const block: any = {
    block_id: question.question.id,
    type: "section",
    text: {
      type: "plain_text",
      text: `${question.question.question.text}\n ${disabled ? "⏱️ Time's up!" : countdown.toFixed(0)}`,
    },
  }

  if (!disabled) {
    block.accessory = {
      type: "radio_buttons",
      action_id: "radio_sel",
      options: question.answers.map((answer) => ({
        value: answer.id,
        text: {
          type: "plain_text",
          text: answer.text.substring(0, 150),
        },
      })),
    }
  }

  return {
    type: "home",
    blocks: [block],
  }
}

export function renderResults(question: Question, userScores: UserScore[]): HomeView {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${Math.round(user.score)} points`,
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

export function renderChannelQuestion(question: Question, countdown: number, disabled: boolean = false): (Block | KnownBlock)[] {
  const block: any = {
    block_id: question.question.id,
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🧠 *Trivia Question* ${disabled ? "(⏱️ Time's up!)" : `(${countdown.toFixed(0)}s remaining)`}\n\n*${question.question.question.text}*`,
    },
  }

  if (!disabled) {
    block.accessory = {
      type: "radio_buttons",
      action_id: "radio_sel",
      options: question.answers.map((answer) => ({
        value: answer.id,
        text: {
          type: "plain_text",
          text: answer.text.substring(0, 150),
        },
      })),
    }
  }

  return [block]
}

export function renderChannelResults(question: Question, userScores: UserScore[]): (Block | KnownBlock)[] {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${Math.round(user.score)} points`,
    )
    .join("\n")

  return [
    {
      block_id: question.question.id,
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${question.question.question.text}*\n\n✅ *Correct answer:* ${question.correctAnswer.text}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🏆 *Current Leaderboard:*\n${leaderboard || "No scores yet"}`,
      },
    },
  ]
}

export function renderFinalSummary(userScores: UserScore[], totalQuestions: number): (Block | KnownBlock)[] {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${user.score.toFixed(1)} points (${user.totalAnswered}/${totalQuestions} answered)`,
    )
    .join("\n")

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🎉 *Trivia Quiz Complete!*\n\nThanks for playing! Here are the final results:`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🏆 *Final Leaderboard:*\n${leaderboard || "No participants"}`,
      },
    },
  ]
}

export function renderFinalSummaryHome(userScores: UserScore[], totalQuestions: number): HomeView {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${user.score.toFixed(1)} points (${user.totalAnswered}/${totalQuestions} answered)`,
    )
    .join("\n")

  return {
    type: "home",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎉 *Trivia Quiz Complete!*\n\nThanks for playing! Here are the final results:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🏆 *Final Leaderboard:*\n${leaderboard || "No participants"}`,
        },
      },
    ],
  }
}