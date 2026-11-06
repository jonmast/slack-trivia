import { DurableObject } from "cloudflare:workers";
import {
  MAX_TIMEOUT_SECS,
  RESULTS_SECS,
  Quiz,
  QuizCompleteError,
  parseQuizzoArgs,
  type Question,
  type QuestionSource,
  type QuizSnapshot,
  type RecapQuestion,
  type TriviaQuestion,
} from "../src/trivia-core";
import {
  renderChannelQuestion,
  renderChannelResults,
  renderFinalSummary,
} from "../src/slack-ui";
import { countdownGifUrl } from "../src/countdown";
import type { Env } from "./env";

const TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions";

/**
 * The quiz cannot go on: the channel message is unusable, or there is no
 * question left to ask. Anything else thrown during a transition is treated as
 * transient and left to the platform's alarm retries.
 */
class QuizFailedError extends Error {}

export type StartQuizResult = {
  ok: boolean;
  text: string;
  /** Present only on success so the Worker knows the message was posted. */
  messageTs?: string;
};

/**
 * Where a quiz is in its cycle. A `question` phase ends at the answer window's
 * deadline, a `results` phase that many seconds later; `complete` sets no alarm.
 */
type Phase = "question" | "results" | "complete";

/**
 * The `state` column: the quiz snapshot plus what only the channel object
 * needs — which phase it is in, the absolute epoch-ms deadline that phase's
 * alarm is set to, the questions fetched at start but not yet asked, and the
 * origin the countdown GIFs are served from (there is no request to derive it
 * from when an alarm fires).
 */
type QuizRecord = QuizSnapshot & {
  phase: Phase;
  deadline: number;
  pending: TriviaQuestion[];
  origin: string;
};

/** Hands out already-fetched questions in order, consuming the queue. */
function questionSource(queue: TriviaQuestion[]): QuestionSource {
  return {
    get(): TriviaQuestion {
      const next = queue.shift();

      if (!next) throw new Error("No questions available");

      return next;
    },
  };
}

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

    // 5. Create the quiz and post question 1.
    const quiz = new Quiz(questionSource(queue), numQuestions, timeoutSecs);
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

    const record: QuizRecord = {
      ...snapshot,
      phase: "question",
      deadline,
      // Whatever `quiz.startQuiz()` did not take is what later questions come
      // from: a restarted object has no other source for them.
      pending: queue,
      origin,
    };

    this.sql.exec(
      "INSERT INTO quizzes (message_ts, status, state) VALUES (?, 'running', ?)",
      messageTs,
      JSON.stringify(record),
    );

    // 8. Set an alarm for when the answer window ends.
    await this.ctx.storage.setAlarm(deadline);

    return { ok: true, text: "Quiz started!", messageTs };
  }

  /**
   * Record a participant's answer. The answer belongs to the question the
   * block ID names, not to whatever the quiz is showing now, so a click
   * delivered after the quiz advanced still counts for the question it was
   * for; the speed bonus is measured from that question's stored start and
   * floors at zero, so a late answer still earns the base point.
   *
   * Deliberately synchronous: nothing is awaited between the state change and
   * the write, so the write coalesces into one transaction and the Durable
   * Object's output gate holds the Slack ack until it commits.
   */
  submitAnswer(
    userId: string,
    answerId: string,
    questionId: string,
    answeredAt: number,
  ): void {
    const running = this.loadRunningQuiz();

    if (!running) {
      console.log(
        `Answer from ${userId} for question ${questionId} but no running quiz; ignoring`,
      );

      return;
    }

    const { messageTs, record } = running;
    const quiz = Quiz.fromSnapshot(record, questionSource([...record.pending]));

    try {
      quiz.submitAnswer(userId, answerId, new Date(answeredAt), questionId);
    } catch (error) {
      console.error(`Failed to record answer from ${userId}:`, error);

      return;
    }

    this.save(messageTs, { ...record, ...quiz.toSnapshot() });
  }

  /**
   * A participant's recap of the finished quiz hosted by `messageTs`.
   *
   * The lookup is by the quiz row's primary key — the timestamp of the message
   * the quiz was played in, which is what the summary's Recap button carries —
   * never by "the channel's latest quiz", so an old summary opens the quiz it
   * belongs to. Rows are never deleted, so those buttons keep working.
   *
   * Returns null when no finished quiz is hosted by that message, and when the
   * user never answered in it: neither has a recap to show.
   */
  getRecap(userId: string, messageTs: string): RecapQuestion[] | null {
    const row = this.sql
      .exec<{ state: string }>(
        "SELECT state FROM quizzes WHERE message_ts = ? AND status = 'finished'",
        messageTs,
      )
      .toArray()[0];

    if (!row) return null;

    const record: QuizRecord = JSON.parse(row.state);
    const quiz = Quiz.fromSnapshot(record, questionSource([...record.pending]));

    if (!quiz.getUserScore(userId)) return null;

    return quiz.getRecap(userId);
  }

  // ---------------------------------------------------------------------------
  // Alarm-driven progression
  // ---------------------------------------------------------------------------

  /**
   * The due phase transition, and nothing else. The handler loads the running
   * quiz, compares the stored phase's deadline to now, performs that one
   * transition, writes the snapshot and sets the next alarm.
   *
   * Two deliveries of the same alarm must not advance the quiz twice: because
   * alarms never fire early, a wake before the stored deadline means the
   * transition it was set for has already happened, so it re-arms the alarm
   * and returns without touching Slack. A wake long after a deadline performs
   * the due transition immediately — a question whose window expired while the
   * object was gone goes straight to results rather than being re-posted.
   */
  async alarm(): Promise<void> {
    const running = this.loadRunningQuiz();

    if (!running) return;

    const { messageTs, record } = running;

    if (Date.now() < record.deadline) {
      await this.ctx.storage.setAlarm(record.deadline);

      return;
    }

    try {
      if (record.phase === "question") {
        await this.showResults(messageTs, record);
      } else if (record.phase === "results") {
        await this.advance(messageTs, record);
      }
    } catch (error) {
      if (!(error instanceof QuizFailedError)) {
        // Something transient (a rate limit, a network blip). Let it out so the
        // platform retries the alarm rather than killing a live quiz.
        throw error;
      }

      // A message that can no longer be updated, or a question source that ran
      // dry, ends the quiz rather than leaving the channel in a half state.
      console.error("Quiz failed to advance; ending quiz:", error);
      await this.complete(messageTs, record);
    }
  }

  /** Replace the question with its results and wait out the results window. */
  private async showResults(
    messageTs: string,
    record: QuizRecord,
  ): Promise<void> {
    const quiz = Quiz.fromSnapshot(record, questionSource([...record.pending]));
    const question = quiz.getCurrentQuestion();

    if (!question) {
      throw new QuizFailedError("Running quiz has no current question");
    }

    const resultsSecs = this.resultsSecs();
    const { current, total } = quiz.getProgress();

    const gifUrl = countdownGifUrl(
      record.origin,
      resultsSecs,
      `${question.question.id}-results`,
    );

    await this.updateChannelMessage(
      messageTs,
      renderChannelResults(
        question,
        quiz.getLeaderboard(),
        Math.min(current, total),
        total,
        resultsSecs,
        gifUrl,
      ),
      `Answer: ${question.correctAnswer.text} — ${question.question.question.text}`,
    );

    // Results run for their full duration from the moment they appear, so a
    // quiz resumed long after its question expired still shows the answer for
    // as long as it says it will.
    const deadline = Math.max(record.deadline, Date.now()) + resultsSecs * 1000;
    this.save(messageTs, { ...record, phase: "results", deadline });
    await this.ctx.storage.setAlarm(deadline);
  }

  /** Replace the results with the next question, or finish the quiz. */
  private async advance(messageTs: string, record: QuizRecord): Promise<void> {
    const pending = [...record.pending];
    const quiz = Quiz.fromSnapshot(record, questionSource(pending));

    let question: Question;

    try {
      question = quiz.nextQuestion();
    } catch (error) {
      if (error instanceof QuizCompleteError) {
        await this.complete(messageTs, record);

        return;
      }

      // The stored questions ran out: retrying will not conjure more.
      throw new QuizFailedError(String(error));
    }

    const { current, total } = quiz.getProgress();

    const gifUrl = countdownGifUrl(
      record.origin,
      record.timeoutSecs,
      question.question.id,
    );

    await this.updateChannelMessage(
      messageTs,
      renderChannelQuestion(
        question,
        record.timeoutSecs,
        Math.min(current, total),
        total,
        gifUrl,
      ),
      `Trivia Question: ${question.question.question.text}`,
    );

    // The answer window opens once the edit is actually in the channel, so it
    // matches the countdown pie Slack renders rather than starting during the
    // API round-trip.
    question.timestamp = new Date();
    const deadline = Date.now() + record.timeoutSecs * 1000;
    this.save(messageTs, {
      ...quiz.toSnapshot(),
      phase: "question",
      deadline,
      pending,
      origin: record.origin,
    });
    await this.ctx.storage.setAlarm(deadline);
  }

  /**
   * End the quiz: the row is marked finished and the alarm cleared first, so a
   * channel whose message can no longer be updated is still released, and the
   * final summary is a best-effort attempt on top.
   */
  private async complete(
    messageTs: string,
    record: QuizRecord,
  ): Promise<void> {
    const quiz = Quiz.fromSnapshot(record, questionSource([...record.pending]));
    quiz.endQuiz();

    this.sql.exec(
      "UPDATE quizzes SET status = 'finished', state = ? WHERE message_ts = ?",
      JSON.stringify({
        ...record,
        ...quiz.toSnapshot(),
        phase: "complete",
      } satisfies QuizRecord),
      messageTs,
    );
    await this.ctx.storage.deleteAlarm();

    try {
      await this.updateChannelMessage(
        messageTs,
        renderFinalSummary(
          quiz.getLeaderboard(),
          quiz.getMaxQuestions(),
          messageTs,
        ),
        "🎉 Trivia quiz completed! Thanks for playing!",
      );
    } catch (error) {
      console.error("Failed to render final summary:", error);
    }
  }

  private async updateChannelMessage(
    messageTs: string,
    blocks: unknown[],
    text: string,
  ): Promise<void> {
    const channelId = this.getChannelId();

    if (!channelId) {
      throw new QuizFailedError("Channel object does not know its channel");
    }

    // An HTTP-level failure (a rate limit, a 5xx, a dropped connection) throws
    // a plain error, so the alarm is retried; only Slack refusing the edit
    // itself means the message is beyond saving.
    const response = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId, ts: messageTs, blocks, text }),
    });

    if (!response.ok) {
      throw new Error(`chat.update HTTP ${response.status}`);
    }

    const result = await response.json<{ ok: boolean; error?: string }>();

    if (!result.ok) {
      throw new QuizFailedError(
        `chat.update failed: ${result.error ?? "unknown"}`,
      );
    }
  }

  /**
   * Countdown GIFs are pre-rendered for every whole second up to
   * `MAX_TIMEOUT_SECS`, so an override outside that range would point the
   * results frame at an image that was never built; those fall back.
   */
  private resultsSecs(): number {
    const configured = Number(this.env.RESULTS_SECS);

    const valid =
      Number.isInteger(configured) &&
      configured >= 1 &&
      configured <= MAX_TIMEOUT_SECS;

    return valid ? configured : RESULTS_SECS;
  }

  private loadRunningQuiz(): {
    messageTs: string;
    record: QuizRecord;
  } | null {
    const row = this.sql
      .exec<{ message_ts: string; state: string }>(
        "SELECT message_ts, state FROM quizzes WHERE status = 'running'",
      )
      .toArray()[0];

    if (!row) return null;

    return { messageTs: row.message_ts, record: JSON.parse(row.state) };
  }

  private save(messageTs: string, record: QuizRecord): void {
    this.sql.exec(
      "UPDATE quizzes SET state = ? WHERE message_ts = ?",
      JSON.stringify(record),
      messageTs,
    );
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
