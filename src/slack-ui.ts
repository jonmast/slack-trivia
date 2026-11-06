import type { AnyMessageBlock, AnyModalBlock, ModalView } from "slack-cloudflare-workers"
import { Question, UserScore, RecapQuestion, RecapOption, compareRank } from "./trivia-core"

export const OPTION_TEXT_MAX = 75

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function speedBonus(bonus: number): string {
  return `⚡ ${bonus.toFixed(2)}`
}

export function optionLabel(text: string): string {
  if (text.length <= OPTION_TEXT_MAX) {
    return text
  }

  return `${text.substring(0, OPTION_TEXT_MAX - 1).trimEnd()}…`
}

/**
 * Channel question message. The timer is an animated pie GIF in a context
 * row: the message is rendered once when the question opens and never edited
 * until time's up (any edit would restart the animation).
 */
export function renderChannelQuestion(
  question: Question,
  timeoutSecs: number,
  current: number,
  total: number,
  countdownGifUrl: string,
): AnyMessageBlock[] {
   // Block 0: Progress header
   const headerBlock = {
     type: "header",
     text: {
       type: "plain_text",
       text: `Question ${current}/${total}:`,
     },
   };

   // Block 1: Section with question text and radio buttons
   const questionBlock: any = {
    block_id: question.question.id,
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🧠 *Trivia Question*\n\n*${question.question.question.text}*`,
    },
    accessory: {
      type: "radio_buttons",
      action_id: "radio_sel",
      options: question.answers.map((answer) => ({
        value: answer.id,
        text: {
          type: "plain_text",
          text: optionLabel(answer.text),
        },
      })),
    },
  };

  // Block 2: countdown pie. An image *element* in a context block renders in a
  // small square with none of the collapsible file chrome an image block gets.
  const countdownBlock = {
    type: "context",
    elements: [
      { type: "image", image_url: countdownGifUrl, alt_text: `${timeoutSecs} second countdown` },
      { type: "mrkdwn", text: `⏱ ${timeoutSecs} seconds` },
    ],
  };

  return [headerBlock, questionBlock, countdownBlock];
}

/** How everyone answered, without naming anyone: per-option counts plus a tally. */
export function renderAnswerBreakdown(question: Question): string {
  const counts = new Map<string, number>()

  for (const r of question.responses) counts.set(r.answerId, (counts.get(r.answerId) ?? 0) + 1)
  const answered = question.responses.length
  const correct = counts.get(question.correctAnswer.id) ?? 0

  const rows = question.answers.map((a) => {
    const isCorrect = a.id === question.correctAnswer.id
    const n = counts.get(a.id) ?? 0

    return `${isCorrect ? "✅" : "◻️"} ${isCorrect ? `*${a.text}*` : a.text} — ${n}`
  })

  const tally =
    answered === 0
      ? "_Nobody answered in time_"
      : `_${correct} of ${answered} answered correctly_`

  return `${rows.join("\n")}\n${tally}`
}

/**
 * Per-question results. Rendered once when time's up; the countdown pie in the
 * context row shows how long until the next question (or the final summary).
 */
export function renderChannelResults(
  question: Question,
  userScores: UserScore[],
  current: number,
  total: number,
  nextSecs: number,
  countdownGifUrl: string,
): AnyMessageBlock[] {
  const sortedScores = userScores.sort(compareRank)

  const leaderboard = sortedScores
    .map(
      (user, index) => `${index + 1}. <@${user.userId}>: ${plural(user.score, "point", "points")}`,
    )
    .join("\n")

  const isLast = current >= total
  const next = isLast ? `🏁 Final results in ${nextSecs} seconds` : `⏭️ Next question in ${nextSecs} seconds`

  return [
    {
      type: "header",
      block_id: `progress_${question.question.id}`,
      text: {
        type: "plain_text",
        text: `Answer ${Math.min(current, total)}/${total}:`,
      },
    },
    {
      block_id: question.question.id,
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${question.question.question.text}*\n\n${renderAnswerBreakdown(question)}`,
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
        { type: "image", image_url: countdownGifUrl, alt_text: `${nextSecs} second countdown` },
        { type: "mrkdwn", text: next },
      ],
    },
  ]
}

export function renderFinalSummary(userScores: UserScore[], totalQuestions: number, messageTs: string): AnyMessageBlock[] {
  const sortedScores = userScores.sort(compareRank)

  const leaderboard = sortedScores
    .map(
      (user, index) =>
        `${index + 1}. <@${user.userId}>: ${plural(user.score, "point", "points")} · ${speedBonus(user.speedBonus)} · ${user.totalAnswered}/${totalQuestions} answered`,
    )
    .join("\n")

  const tieBreakNote: AnyMessageBlock[] = leaderboard
    ? [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Ranked by points. The ⚡ speed bonus only breaks ties." }],
        },
      ]
    : []

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
    ...tieBreakNote,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "recap",
          text: { type: "plain_text", text: "📋 See your recap" },
          value: messageTs,
        },
      ],
    },
  ]
}

function recapMarker(option: RecapOption): string {
  if (option.selected) return option.correct ? "✅" : "❌"

  return option.correct ? "💡" : "•"
}

function recapPoints(entry: RecapQuestion): string {
  if (!entry.answered) return "(no answer)"
  const points = plural(entry.points, "pt", "pts")

  return entry.points > 0 ? `${points} · ${speedBonus(entry.speedBonus)}` : points
}

export function renderRecapModal(recap: RecapQuestion[]): ModalView {
  const answered = recap.filter((entry) => entry.answered).length
  const total = recap.reduce((sum, entry) => sum + entry.points, 0)
  const totalBonus = recap.reduce((sum, entry) => sum + entry.speedBonus, 0)

  return {
    type: "modal",
    title: { type: "plain_text", text: "Your recap" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${plural(total, "pt", "pts")}* · ${speedBonus(totalBonus)} speed bonus · ${answered}/${recap.length} answered`,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "✅ you picked, correct · ❌ you picked, wrong · 💡 correct, not picked · ⚡ speed bonus" },
        ],
      },
      ...recap.map((entry, index): AnyModalBlock => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${index + 1}. ${entry.text}*  _${recapPoints(entry)}_`,
            ...entry.options.map((option) => `${recapMarker(option)} ${option.text}`),
          ].join("\n"),
        },
      })),
    ],
  }
}