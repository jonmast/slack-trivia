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

export function renderChannelQuestion(question: Question, countdown: number, current: number, total: number, disabled: boolean = false): (Block | KnownBlock)[] {
   // Block 0: Progress header
   const headerBlock = {
     type: "header",
     text: {
       type: "plain_text",
       text: `Question ${current}/${total}:`,
     },
   };

   // Block 1: Section with question text (and radio buttons if active)
   const questionBlock: any = {
    block_id: question.question.id,
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🧠 *Trivia Question* ${disabled ? "(⏱️ Time's up!)" : `(${countdown.toFixed(0)}s remaining)`}\n\n*${question.question.question.text}*`,
    },
  };
  if (!disabled) {
    questionBlock.accessory = {
      type: "radio_buttons",
      action_id: "radio_sel",
      options: question.answers.map((answer) => ({
        value: answer.id,
        text: {
          type: "plain_text",
          text: answer.text.substring(0, 150),
        },
      })),
    };
  }

  // Block 2: Section with static answer list (only when disabled), or placeholder
  let answersBlock: any;
  if (disabled) {
    answersBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: question.answers.map((answer) => `• ${answer.text}`).join("\n"),
      },
    };
  } else {
    answersBlock = {
      type: "section",
      text: { type: "mrkdwn", text: " " },
    };
  }

  // Block 3: Context (status/info or placeholder)
  const contextBlock = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: disabled ? "⏱️ Time's up! No more answers can be submitted." : " ",
      },
    ],
  };

   return [headerBlock, questionBlock, answersBlock, contextBlock];
}

export function renderChannelResults(question: Question, userScores: UserScore[], current?: number, total?: number): (Block | KnownBlock)[] {
  const sortedScores = userScores.sort((a, b) => b.score - a.score)
  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${Math.round(user.score)} points`,
    )
    .join("\n")

  const headerBlock = (current && total)
    ? {
        type: "section",
        block_id: `progress_${question.question.id}`,
        text: {
          type: "mrkdwn",
          text: `*Answer ${Math.min(current, total)}/${total}:*`,
        },
      }
    : undefined;

  const blocks = [
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
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: " ",
        },
      ],
    },
   ]
  if (headerBlock) {
    return [headerBlock, ...blocks];
  }
  return blocks;
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