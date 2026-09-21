import { DurableObject } from "cloudflare:workers";
import {
  Quiz,
  parseQuizzoArgs,
  type QuestionSource,
  type TriviaQuestion,
} from "../src/trivia-core";
import { renderChannelQuestion } from "../src/slack-ui";
import { countdownGifUrl } from "../src/countdown";
import type { Env } from "./env";

const TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions";

export type StartQuizResult = {
  ok: boolean;
  text: string;
  /** Present only on success so the Worker knows the message was posted. */
  messageTs?: string;
};

/**
 * One Durable Object per Slack channel, addressed by `idFromName(channelId)`.
 * It owns everything that channel's quizzes need; for now it parses
 * `/quizzo` arguments, fetches questions, posts the first question, and stores
 * the running quiz snapshot.
 */
export class ChannelObject extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No request is served until the schema exists.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const { version } = this.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM migrations",
      )
      .one();

    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE channel (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          channel_id TEXT NOT NULL
        );
        INSERT INTO migrations (id) VALUES (1);
      `);
    }

    if (version < 2) {
      this.sql.exec(`
        CREATE TABLE quizzes (
          message_ts TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status = 'running' OR status = 'finished'),
          state TEXT NOT NULL
        );
        INSERT INTO migrations (id) VALUES (2);
      `);
    }
  }

  /**
   * Start a channel quiz. Parses `/quizzo` arguments, fetches the requested
   * number of questions from The Trivia API in a single request, posts the
   * first question via `chat.postMessage`, and stores the running quiz in
   * SQLite before returning.
   */
  async startQuiz(
    channelId: string,
    text: string,
    origin: string,
    botToken: string,
  ): Promise<StartQuizResult> {
    this.rememberChannel(channelId);

    // 1. Parse arguments.
    const parsed = parseQuizzoArgs(text);
    if (!parsed.ok) {
      return { ok: false, text: parsed.error };
    }
    const { numQuestions, timeoutSecs } = parsed.args;

    // 2. Reject if a quiz is already running in this channel.
    if (this.hasRunningQuiz()) {
      return {
        ok: false,
        text: "A quiz is already running in this channel. Wait for it to finish before starting another.",
      };
    }

    // 3. Fetch exactly the requested number of questions in one API request.
    let triviaQuestions: TriviaQuestion[];
    try {
      const url = `${TRIVIA_API_URL}?limit=${numQuestions}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      triviaQuestions = Array.isArray(data) ? data : [];
    } catch {
      return {
        ok: false,
        text: "Could not load enough trivia questions. Please try again shortly.",
      };
    }

    if (triviaQuestions.length < numQuestions) {
      return {
        ok: false,
        text: "Could not load enough trivia questions. Please try again shortly.",
      };
    }

    // 4. Build a QuestionSource that hands out the fetched questions in order.
    const queue = [...triviaQuestions];
    const questionSource: QuestionSource = {
      get(): TriviaQuestion {
        const next = queue.shift();
        if (!next) throw new Error("No questions available");
        return next;
      },
    };

    // 5. Create the quiz and post question 1.
    const quiz = new Quiz(questionSource, numQuestions, timeoutSecs);
    const question = quiz.startQuiz();

    // Render blocks using the existing channel question renderer.
    const gifUrl = countdownGifUrl(origin, timeoutSecs, question.question.id);
    const blocks = renderChannelQuestion(
      question,
      timeoutSecs,
      1,
      numQuestions,
      gifUrl,
    );

    let postResult: { ok: boolean; ts?: string };
    try {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: channelId,
          blocks,
          // Fallback text for notifications / accessibility.
          text: `Question 1/${numQuestions}: ${question.question.question.text}`,
        }),
      });
      postResult = await response.json<{ ok: boolean; ts?: string }>();
    } catch {
      return {
        ok: false,
        text: "Failed to post the first question. Please try again.",
      };
    }

    if (!postResult.ok || !postResult.ts) {
      return {
        ok: false,
        text: "Failed to post the first question. Please try again.",
      };
    }

    const messageTs = postResult.ts;

    // 6. Compute the deadline: the clock starts now, after the post round-trip.
    const deadline = Date.now() + timeoutSecs * 1000;

    // 7. Store the running quiz snapshot in SQLite.
    //    The snapshot records the deadline so the alarm handler knows when to
    //    transition to results. The question clock (timestamp) is set to NOW
    //    so the speed bonus and GIF sync with Slack's render time.
    const snapshot = quiz.toSnapshot();
    snapshot.questions[0].startedAt = Date.now();
    const snapshotWithDeadline = { ...snapshot, deadline };

    this.sql.exec(
      "INSERT INTO quizzes (message_ts, status, state) VALUES (?, 'running', ?)",
      messageTs,
      JSON.stringify(snapshotWithDeadline),
    );

    // 8. Set an alarm for when the answer window ends.
    await this.ctx.storage.setAlarm(deadline);

    return { ok: true, text: "Quiz started!", messageTs };
  }

  /** True if there is a quiz with status 'running' in the channel. */
  hasRunningQuiz(): boolean {
    const row = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM quizzes WHERE status = 'running'",
      )
      .one();
    return row.cnt > 0;
  }

  /** The channel this object belongs to, or null before its first use. */
  getChannelId(): string | null {
    const row = this.sql
      .exec<{ channel_id: string }>(
        "SELECT channel_id FROM channel WHERE id = 1",
      )
      .toArray()[0];
    return row?.channel_id ?? null;
  }

  // The object is addressed by a hash of the channel ID, so it can only learn
  // which channel that is from the first request that reaches it.
  private rememberChannel(channelId: string): void {
    this.sql.exec(
      "INSERT INTO channel (id, channel_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING",
      channelId,
    );
  }
}
