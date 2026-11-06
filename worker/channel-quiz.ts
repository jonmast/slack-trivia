import { Clock, Effect, Match, Option, Schema } from "effect";
import type { AnyMessageBlock } from "slack-cloudflare-workers";
import {
  Quiz,
  parseQuizzoArgs,
  type QuestionSource,
  type TriviaQuestion,
} from "../src/trivia-core";
import {
  renderChannelQuestion,
  renderChannelResults,
  renderFinalSummary,
} from "../src/slack-ui";
import { countdownGifUrl } from "../src/countdown";
import { WorkerConfig } from "./config";
import { QuizStore, type QuizRecord } from "./quiz-store";
import {
  SlackClient,
  type SlackApiError,
  type SlackRequestError,
} from "./slack-client";
import { TriviaApi } from "./trivia-api";

export type StartQuizResult = {
  ok: boolean;
  text: string;
  /** Present only on success so the Worker knows the message was posted. */
  messageTs?: string;
};

/** The object was asked to edit a message before it learned its channel. */
export class ChannelUnknownError extends Schema.TaggedError<ChannelUnknownError>()(
  "ChannelUnknownError",
  {},
) {
  override get message(): string {
    return "Channel object does not know its channel";
  }
}

export class NoCurrentQuestionError extends Schema.TaggedError<NoCurrentQuestionError>()(
  "NoCurrentQuestionError",
  {},
) {
  override get message(): string {
    return "Running quiz has no current question";
  }
}

const NOT_ENOUGH_QUESTIONS =
  "Could not load enough trivia questions. Please try again shortly.";

const POST_FAILED = "Failed to post the first question. Please try again.";

/** Hands out already-fetched questions in order, consuming the queue. */
function questionSource(queue: TriviaQuestion[]): QuestionSource {
  return {
    get: () => Option.fromUndefinedOr(queue.shift()),
  };
}

/** Rebuild a stored quiz; later questions are drawn from `pending`, consuming it. */
function restore(record: QuizRecord, pending = [...record.pending]) {
  return Quiz.fromSnapshot(record, questionSource(pending));
}

/**
 * Start a channel quiz. Parses `/quizzo` arguments, fetches the requested
 * number of questions from The Trivia API in a single request, posts the
 * first question via `chat.postMessage`, and stores the running quiz in
 * SQLite before returning.
 */
export const startQuiz = Effect.fn("startQuiz")(
  function* (channelId: string, text: string, origin: string) {
    const store = yield* QuizStore;
    yield* store.rememberChannel(channelId);

    const { numQuestions, timeoutSecs } = yield* parseQuizzoArgs(text);

    if (yield* store.hasRunningQuiz) {
      return refuse(
        "A quiz is already running in this channel. Wait for it to finish before starting another.",
      );
    }

    // Exactly the requested number of questions, in one API request.
    const fetched = yield* (yield* TriviaApi).fetchQuestions(numQuestions);

    if (fetched.length < numQuestions) return refuse(NOT_ENOUGH_QUESTIONS);

    const queue = [...fetched];
    const quiz = new Quiz(questionSource(queue), numQuestions, timeoutSecs);
    // The queue holds at least `numQuestions` (>= 1) questions, so the first
    // one is always there.
    const question = yield* Effect.orDie(quiz.startQuiz());
    const gifUrl = countdownGifUrl(origin, timeoutSecs, question.question.id);

    const messageTs = yield* (yield* SlackClient).postMessage(
      channelId,
      renderChannelQuestion(question, timeoutSecs, 1, numQuestions, gifUrl),
      `Question 1/${numQuestions}: ${question.question.question.text}`,
    );

    // The clock starts now, after the post round-trip, so the speed bonus and
    // the countdown GIF match what Slack shows rather than when we asked.
    const now = yield* Clock.currentTimeMillis;
    const deadline = now + timeoutSecs * 1000;
    question.timestamp = new Date(now);

    yield* store.insertRunning(messageTs, {
      ...quiz.toSnapshot(),
      phase: "question",
      deadline,
      // Whatever `quiz.startQuiz()` did not take is what later questions come
      // from: a restarted object has no other source for them.
      pending: queue,
      origin,
    });

    yield* store.setAlarm(deadline);

    const started: StartQuizResult = {
      ok: true,
      text: "Quiz started!",
      messageTs,
    };

    return started;
  },
  Effect.catchTags({
    InvalidQuizzoArgsError: (error) => Effect.succeed(refuse(error.message)),
    TriviaApiError: () => Effect.succeed(refuse(NOT_ENOUGH_QUESTIONS)),
    SlackRequestError: postFailed,
    SlackApiError: postFailed,
  }),
);

function refuse(text: string): StartQuizResult {
  return { ok: false, text };
}

function postFailed(error: SlackRequestError | SlackApiError) {
  return Effect.logError("Failed to post the first question:", error).pipe(
    Effect.as(refuse(POST_FAILED)),
  );
}

/**
 * Record a participant's answer. The answer belongs to the question the
 * block ID names, not to whatever the quiz is showing now, so a click
 * delivered after the quiz advanced still counts for the question it was
 * for; the speed bonus is measured from that question's stored start and
 * floors at zero, so a late answer still earns the base point.
 *
 * Synchronous throughout — store reads and writes only, no Slack or alarm
 * calls — because `ChannelObject.submitAnswer` runs it with `runSync`.
 */
export const submitAnswer = Effect.fn("submitAnswer")(
  function* (
    userId: string,
    answerId: string,
    questionId: string,
    answeredAt: number,
  ) {
    const store = yield* QuizStore;
    const running = yield* store.loadRunning;

    if (Option.isNone(running)) {
      yield* Effect.log(
        `Answer from ${userId} for question ${questionId} but no running quiz; ignoring`,
      );

      return;
    }

    const { messageTs, record } = running.value;
    const quiz = yield* restore(record);

    yield* quiz.submitAnswer(userId, answerId, new Date(answeredAt), questionId);
    yield* store.save(messageTs, { ...record, ...quiz.toSnapshot() });
  },
  (effect, userId) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to record answer from ${userId}:`, error),
      ),
    ),
);

/**
 * A participant's recap of the finished quiz hosted by `messageTs`.
 *
 * The lookup is by the quiz row's primary key — the timestamp of the message
 * the quiz was played in, which is what the summary's Recap button carries —
 * never by "the channel's latest quiz", so an old summary opens the quiz it
 * belongs to. Rows are never deleted, so those buttons keep working.
 *
 * Returns null when no finished quiz is hosted by that message, and when the
 * user never answered in it: neither has a recap to show. A stored quiz that
 * can no longer be read has none either.
 */
export const getRecap = Effect.fn("getRecap")(
  function* (userId: string, messageTs: string) {
    const record = yield* (yield* QuizStore).loadFinished(messageTs);

    if (Option.isNone(record)) return null;

    const quiz = yield* restore(record.value);

    if (!quiz.getUserScore(userId)) return null;

    return quiz.getRecap(userId);
  },
  (effect, _userId, messageTs) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to load the recap for ${messageTs}:`, error).pipe(
          Effect.as(null),
        ),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Alarm-driven progression
// ---------------------------------------------------------------------------

const updateChannelMessage = Effect.fn("updateChannelMessage")(function* (
  messageTs: string,
  blocks: AnyMessageBlock[],
  text: string,
) {
  const channelId = yield* (yield* QuizStore).channelId;

  if (Option.isNone(channelId)) {
    return yield* new ChannelUnknownError();
  }

  // An HTTP-level failure (a rate limit, a 5xx, a dropped connection) is a
  // SlackRequestError, so the alarm is retried; only Slack refusing the edit
  // itself (a SlackApiError) means the message is beyond saving.
  yield* (yield* SlackClient).updateMessage(
    channelId.value,
    messageTs,
    blocks,
    text,
  );
});

/** Replace the question with its results and wait out the results window. */
const showResults = Effect.fn("showResults")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  const { resultsSecs } = yield* WorkerConfig;
  const quiz = yield* restore(record);
  const question = quiz.getCurrentQuestion();

  if (!question) {
    return yield* new NoCurrentQuestionError();
  }

  const { current, total } = quiz.getProgress();

  const gifUrl = countdownGifUrl(
    record.origin,
    resultsSecs,
    `${question.question.id}-results`,
  );

  yield* updateChannelMessage(
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
  const now = yield* Clock.currentTimeMillis;
  const deadline = Math.max(record.deadline, now) + resultsSecs * 1000;
  yield* store.save(messageTs, { ...record, phase: "results", deadline });
  yield* store.setAlarm(deadline);
});

/** Replace the results with the next question; fails when the quiz is done. */
const advance = Effect.fn("advance")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  const pending = [...record.pending];
  const quiz = yield* restore(record, pending);
  const question = yield* quiz.nextQuestion();
  const { current, total } = quiz.getProgress();

  const gifUrl = countdownGifUrl(
    record.origin,
    record.timeoutSecs,
    question.question.id,
  );

  yield* updateChannelMessage(
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
  const now = yield* Clock.currentTimeMillis;
  question.timestamp = new Date(now);
  const deadline = now + record.timeoutSecs * 1000;

  yield* store.save(messageTs, {
    ...quiz.toSnapshot(),
    phase: "question",
    deadline,
    pending,
    origin: record.origin,
  });

  yield* store.setAlarm(deadline);
});

/**
 * Give up on a quiz whose stored state cannot be read: there is no
 * leaderboard to show, but the channel is released.
 */
const abandon = Effect.fn("abandon")(function* (
  messageTs: string,
  error: Error,
) {
  const store = yield* QuizStore;
  yield* Effect.logError("Stored quiz is unreadable; abandoning it:", error);
  yield* store.abandon(messageTs);
  yield* store.deleteAlarm;
});

/**
 * End the quiz: the row is marked finished and the alarm cleared first, so a
 * channel whose message can no longer be updated is still released, and the
 * final summary is a best-effort attempt on top.
 */
const complete = Effect.fn("complete")(
  function* (messageTs: string, record: QuizRecord) {
    const store = yield* QuizStore;
    const quiz = yield* restore(record);

    quiz.endQuiz();

    yield* store.finish(messageTs, {
      ...record,
      ...quiz.toSnapshot(),
      phase: "complete",
    });

    yield* store.deleteAlarm;

    yield* updateChannelMessage(
      messageTs,
      renderFinalSummary(
        quiz.getLeaderboard(),
        quiz.getMaxQuestions(),
        messageTs,
      ),
      "🎉 Trivia quiz completed! Thanks for playing!",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to render final summary:", error),
      ),
    );
  },
  (effect, messageTs) =>
    effect.pipe(
      Effect.catchTag(
        ["UnsupportedSnapshotVersionError", "InvalidQuizSnapshotError"],
        (error) => abandon(messageTs, error),
      ),
    ),
);

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
 *
 * Fails only with a `SlackRequestError`, something transient (a rate limit, a
 * network blip): the alarm handler lets it out so the platform retries the
 * alarm rather than killing a live quiz. Everything else that stops the quiz
 * from advancing ends it instead.
 */
export const alarm: Effect.Effect<
  void,
  SlackRequestError,
  QuizStore | SlackClient | WorkerConfig
> = Effect.gen(function* () {
  const store = yield* QuizStore;
  const running = yield* store.loadRunning;

  if (Option.isNone(running)) return;

  const { messageTs, record } = running.value;

  if ((yield* Clock.currentTimeMillis) < record.deadline) {
    yield* store.setAlarm(record.deadline);

    return;
  }

  const transition = Match.value(record.phase).pipe(
    Match.when("question", () => showResults(messageTs, record)),
    Match.when("results", () =>
      advance(messageTs, record).pipe(
        Effect.catchTag("QuizCompleteError", () =>
          complete(messageTs, record),
        ),
      ),
    ),
    Match.orElse(() => Effect.void),
  );

  yield* transition.pipe(
    // A message that can no longer be updated, a question source that ran
    // dry or a snapshot that cannot be rebuilt ends the quiz rather than
    // leaving the channel in a half state.
    Effect.catchTag(
      [
        "SlackApiError",
        "ChannelUnknownError",
        "QuestionsExhaustedError",
        "NoCurrentQuestionError",
        "UnsupportedSnapshotVersionError",
        "InvalidQuizSnapshotError",
      ],
      (error) =>
        Effect.logError("Quiz failed to advance; ending quiz:", error).pipe(
          Effect.andThen(complete(messageTs, record)),
        ),
    ),
  );
}).pipe(
  // A row that does not decode would otherwise fail every alarm and hold the
  // channel forever.
  Effect.catchTag("UndecodableQuizRecordError", (error) =>
    abandon(error.messageTs, error),
  ),
  Effect.withSpan("alarm"),
);
