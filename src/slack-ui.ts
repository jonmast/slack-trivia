import { Option } from "effect"
import type { AnyMessageBlock, AnyModalBlock, ModalView } from "slack-cloudflare-workers"
import { Question, UserScore, RecapQuestion, RecapOption, AwardedAnswer, Awards, compareRank } from "./trivia-core"

export const OPTION_TEXT_MAX = 75

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A speed bonus share, 0 to 1, as a whole percentage. */
function speedBonus(share: number): string {
  return `⚡ ${Math.round(share * 100)}%`
}

export function optionLabel(text: string): string {
  if (text.length <= OPTION_TEXT_MAX) {
    return text
  }

  return `${text.substring(0, OPTION_TEXT_MAX - 1).trimEnd()}…`
}

/**
 * The ready screen a channel quiz opens on, so participants can gather before
 * the first question. Its countdown pie runs out when that question appears.
 */
export function renderChannelReady(
  totalQuestions: number,
  timeoutSecs: number,
  readySecs: number,
  countdownGifUrl: string,
  note?: string,
): AnyMessageBlock[] {
  const noteBlock: AnyMessageBlock[] = note
    ? [{ type: "context", elements: [{ type: "mrkdwn", text: note }] }]
    : []

  return [
    readyHeader(),
    readySummary(totalQuestions, timeoutSecs),
    ...noteBlock,
    {
      type: "context",
      elements: [
        { type: "image", image_url: countdownGifUrl, alt_text: `${readySecs} second countdown` },
        { type: "mrkdwn", text: `⏭️ First question in ${readySecs} seconds` },
      ],
    },
  ]
}

/**
 * The extended ready screen: the countdown has run out before screening
 * cleared enough questions, so there is no countdown to show.
 */
export function renderChannelExtended(totalQuestions: number, timeoutSecs: number): AnyMessageBlock[] {
  return [
    readyHeader(),
    readySummary(totalQuestions, timeoutSecs),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "🔎 Finding good questions is taking longer than expected…" }],
    },
  ]
}

/** What replaces the ready screen when screening cleared no questions at all. */
export function renderChannelCancelled(): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "😞 *Sorry, no quiz this time.*\n\nWe couldn't find any good questions. Please try `/quizzo` again in a little while.",
      },
    },
  ]
}

function readyHeader(): AnyMessageBlock {
  return { type: "header", text: { type: "plain_text", text: "Get ready!" } }
}

function readySummary(totalQuestions: number, timeoutSecs: number): AnyMessageBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🧠 *Trivia time!*\n\n${plural(totalQuestions, "question", "questions")}, ${plural(timeoutSecs, "second", "seconds")} each. Answer fast for a speed bonus.`,
    },
  }
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

type AnswerLine = (who: string, pick: string, secs: string) => string

const FASTEST_WRONG_LINES: ReadonlyArray<AnswerLine> = [
  (who, pick, secs) => `${who} picked *${pick}* in ${secs}. Confidently incorrect.`,
  (who, pick, secs) => `${who} locked in *${pick}* after ${secs}. Bold. Wrong, but bold.`,
  (who, pick, secs) => `${who} needed just ${secs} to pick *${pick}*. Thinking would've taken longer.`,
  (who, pick, secs) => `${who} hit *${pick}* in ${secs}. Reading the question is for cowards.`,
]

const SLOWEST_RIGHT_LINES: ReadonlyArray<AnswerLine> = [
  (who, pick, secs) => `${who} took ${secs} to land on *${pick}*. Correct, eventually.`,
  (who, pick, secs) => `${who} got *${pick}* right after ${secs}. Worth the wait? Debatable.`,
  (who, pick, secs) => `${who} needed ${secs} for *${pick}*. Phoned a friend, presumably.`,
  (who, pick, secs) => `${who} arrived at *${pick}* after ${secs}. Slow and steady, mostly slow.`,
]

const HERD_LINES: ReadonlyArray<(count: number, pick: string) => string> = [
  (count, pick) => `${count} of you picked *${pick}*. Groupthink at its finest.`,
  (count, pick) => `${count} of you agreed on *${pick}*. Wrong together, which is nice.`,
  (count, pick) => `${count} of you went with *${pick}*. Confidence in numbers, not in facts.`,
  (count, pick) => `${count} of you chose *${pick}*. Somebody started a rumour.`,
]

/** One line per quiz, chosen from its message ts so a re-render never changes it. */
function pickLine<Line>(lines: ReadonlyArray<Line>, messageTs: string): Line {
  const seed = [...messageTs].reduce((sum, char) => sum + char.charCodeAt(0), 0)

  return lines[seed % lines.length]
}

function answerAward(
  title: string,
  lines: ReadonlyArray<AnswerLine>,
  award: Option.Option<AwardedAnswer>,
  messageTs: string,
): Option.Option<string> {
  return Option.map(award, ({ userId, pick, secs }) => {
    const line = pickLine(lines, messageTs)
    // Slack's mrkdwn reads a bare `<` as the start of a link.
    const took = secs < 0.1 ? "&lt;0.1s" : `${secs.toFixed(1)}s`

    return `${title}\n${line(`<@${userId}>`, pick, took)}`
  })
}

function renderAwards(awards: Awards, messageTs: string): AnyMessageBlock[] {
  const herd = Option.map(
    awards.herd,
    ({ count, pick }) => `🐑 *Herd Mentality*\n${pickLine(HERD_LINES, messageTs)(count, pick)}`,
  )

  return [
    answerAward("🏅 *Fastest Wrong Answer*", FASTEST_WRONG_LINES, awards.fastestWrong, messageTs),
    answerAward("🐢 *Slowest Right Answer*", SLOWEST_RIGHT_LINES, awards.slowestRight, messageTs),
    herd,
  ].flatMap((award) =>
    Option.match(award, {
      onNone: (): AnyMessageBlock[] => [],
      onSome: (text): AnyMessageBlock[] => [{ type: "section", text: { type: "mrkdwn", text } }],
    }),
  )
}

export function renderFinalSummary(
  userScores: UserScore[],
  totalQuestions: number,
  messageTs: string,
  awards: Awards,
): AnyMessageBlock[] {
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
    ...renderAwards(awards, messageTs),
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

  // Every question counts towards the quiz's bonus, answered or not.
  const totalBonus =
    recap.length > 0 ? recap.reduce((sum, entry) => sum + entry.speedBonus, 0) / recap.length : 0

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
            `_ID: \`${entry.id}\`_`,
          ].join("\n"),
        },
      })),
    ],
  }
}