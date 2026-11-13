import { Clock, Duration, Effect, Match, Option, Schema } from "effect";
import type { AnyMessageBlock } from "slack-cloudflare-workers";
import {
  Quiz,
  parseQuizzoArgs,
  type QuestionSource,
  type RecapQuestion,
  type TriviaQuestion,
} from "../src/trivia-core";
import {
  renderChannelCancelled,
  renderChannelExtended,
  renderChannelQuestion,
  renderChannelReady,
  renderChannelResults,
  renderFinalSummary,
} from "../src/slack-ui";
import { countdownGifUrl } from "../src/countdown";
import { WorkerConfig } from "./config";
import type { Jev } from "./jev";
import { QuizStore, type QuizRecord } from "./quiz-store";
import { askable, screenQuestions } from "./screening";
import { ScreeningLog } from "./screening-log";
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
class ChannelUnknownError extends Schema.TaggedError<ChannelUnknownError>()(
  "ChannelUnknownError",
  {},
) {
  override get message(): string {
    return "Channel object does not know its channel";
  }
}

class NoCurrentQuestionError extends Schema.TaggedError<NoCurrentQuestionError>()(
  "NoCurrentQuestionError",
  {},
) {
  override get message(): string {
    return "Running quiz has no current question";
  }
}

const NOT_ENOUGH_QUESTIONS =
  "Could not load enough trivia questions. Please try again shortly.";

const POST_FAILED = "Failed to post the quiz. Please try again.";

/** Hands out already-fetched questions in order, consuming the queue. */
function questionSource(queue: TriviaQuestion[]): QuestionSource {
  return {
    get: () => Option.fromUndefinedOr(queue.shift()),
  };
}

/** Rebuild a stored quiz; later questions are drawn from `pending`, consuming it. */
function restore(record: QuizRecord, pending: TriviaQuestion[]) {
  return Quiz.fromSnapshot(record, questionSource(pending));
}

/** Questions fetched per question asked, so screening has some to reject. */
const CANDIDATES_PER_QUESTION = 2;

/** The pause between searches for more questions on an extended ready screen. */
const SEARCH_INTERVAL_MS = 2000;

/**
 * Start a channel quiz. Parses `/quizzo` arguments, fetches twice the
 * requested number of questions from The Trivia API in a single request,
 * posts the ready screen via `chat.postMessage`, and stores the quiz, running
 * but with no question asked yet, in SQLite before returning.
 *
 * The quiz is stored in its `screening` phase, with the alarm that ends the
 * ready screen already set, and the fetched questions are then screened
 * while the countdown runs. Should the object go away before screening is
 * done, that alarm screens them instead, late; either way the alarm that
 * ends the ready screen asks the first question.
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

    const fetched = yield* (yield* TriviaApi).fetchQuestions(
      numQuestions * CANDIDATES_PER_QUESTION,
    );

    // Too few to ask even unscreened: nothing to start with.
    if (fetched.length < numQuestions) return refuse(NOT_ENOUGH_QUESTIONS);

    const quiz = new Quiz(questionSource([]), numQuestions, timeoutSecs);
    const { readySecs } = yield* WorkerConfig;

    // At least `numQuestions` (>= 1) questions were fetched, so the first one
    // is always there to key the GIF on.
    const gifUrl = countdownGifUrl(origin, readySecs, `${fetched[0].id}-ready`);

    const messageTs = yield* (yield* SlackClient).postMessage(
      channelId,
      renderChannelReady(numQuestions, timeoutSecs, readySecs, gifUrl),
      `Trivia is starting: first question in ${readySecs} seconds`,
    );

    // Counted from after the post round-trip, like every other phase, so the
    // countdown GIF matches what Slack shows.
    const deadline = (yield* Clock.currentTimeMillis) + readySecs * 1000;

    yield* store.insertRunning(messageTs, {
      ...quiz.toSnapshot(),
      phase: "screening",
      deadline,
      // Every question waits here until it is asked: a restarted object has no
      // other source for them.
      pending: fetched,
      origin,
    });

    yield* store.setAlarm(deadline);

    yield* screen(messageTs).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to screen questions; the ready alarm will retry:", error),
      ),
    );

    return { ok: true, text: "Quiz started!", messageTs };
  },
  Effect.catchTags({
    InvalidQuizzoArgsError: (error) => Effect.succeed(refuse(error.message)),
    TriviaApiError: (error) =>
      Effect.logError("Failed to fetch trivia questions:", error).pipe(
        Effect.as(refuse(NOT_ENOUGH_QUESTIONS)),
      ),
    SlackRequestError: postFailed,
    SlackApiError: postFailed,
  }),
);

function refuse(text: string): StartQuizResult {
  return { ok: false, text };
}

function postFailed(error: SlackRequestError | SlackApiError) {
  return Effect.logError("Failed to post the ready screen:", error).pipe(
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
    const quiz = yield* restore(record, [...record.pending]);

    // Slack's click time unless it did not parse; NaN would be stored as `null`.
    const at = Number.isFinite(answeredAt)
      ? answeredAt
      : yield* Clock.currentTimeMillis;

    yield* quiz.submitAnswer(userId, answerId, new Date(at), questionId);
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
 * A recap, or why there is none: the user never answered in that quiz, or
 * there is no readable finished quiz hosted by that message.
 */
export type RecapLookup =
  | { found: true; recap: RecapQuestion[] }
  | { found: false; reason: "not-participant" | "unavailable" };

const UNAVAILABLE: RecapLookup = { found: false, reason: "unavailable" };

/**
 * A participant's recap of the finished quiz hosted by `messageTs`.
 *
 * The lookup is by the quiz row's primary key — the timestamp of the message
 * the quiz was played in, which is what the summary's Recap button carries —
 * never by "the channel's latest quiz", so an old summary opens the quiz it
 * belongs to. Rows are never deleted, so those buttons keep working.
 */
export const getRecap = Effect.fn("getRecap")(
  function* (userId: string, messageTs: string) {
    const record = yield* (yield* QuizStore).loadFinished(messageTs);

    if (Option.isNone(record)) return UNAVAILABLE;

    const quiz = yield* restore(record.value, [...record.value.pending]);

    if (!quiz.getUserScore(userId)) {
      return { found: false, reason: "not-participant" } satisfies RecapLookup;
    }

    return { found: true, recap: quiz.getRecap(userId) } satisfies RecapLookup;
  },
  (effect, _userId, messageTs) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to load the recap for ${messageTs}:`, error).pipe(
          Effect.as(UNAVAILABLE),
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
  const quiz = yield* restore(record, [...record.pending]);
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

/**
 * Replace the ready screen with the first question, or the results with the
 * next one; fails when the quiz is done.
 */
const advance = Effect.fn("advance")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  const pending = [...record.pending];
  const quiz = yield* restore(record, pending);

  const question = yield* record.phase === "results"
    ? quiz.nextQuestion()
    : quiz.startQuiz();

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

/** How many more questions must pass screening before the quiz can start. */
function shortfall(record: QuizRecord): number {
  return record.maxQuestions - record.questions.length - record.pending.length;
}

const screeningQuiz = Effect.fn("screeningQuiz")(function* (messageTs: string) {
  const channelId = yield* (yield* QuizStore).channelId;

  if (Option.isNone(channelId)) {
    return yield* new ChannelUnknownError();
  }

  return { channelId: channelId.value, messageTs };
});

/** The running quiz hosted by `messageTs`, if it is still being screened. */
const loadScreening = Effect.fn("loadScreening")(function* (messageTs: string) {
  const running = yield* (yield* QuizStore).loadRunning;

  return Option.flatMap(running, (quiz) =>
    quiz.messageTs === messageTs && quiz.record.phase === "screening"
      ? Option.some(quiz.record)
      : Option.none(),
  );
});

/**
 * Screen the questions fetched at start, keeping only those that may be
 * asked, and leave the ready screen to end when it was going to. The record
 * is read again once Jev has answered, and left alone if screening finished
 * meanwhile: started by `startQuiz` and, after an eviction or a slow Jev, by
 * the ready alarm, screening can run twice, but only the run that moves the
 * quiz on is kept and recorded. The quiz is saved before its verdicts are
 * recorded, so a slow D1 never holds it up.
 */
const screen = Effect.fn("screen")(function* (messageTs: string) {
  const store = yield* QuizStore;
  const before = yield* loadScreening(messageTs);

  if (Option.isNone(before)) return;

  const quiz = yield* screeningQuiz(messageTs);
  const candidates = before.value.pending;
  const verdicts = yield* screenQuestions(candidates);
  const after = yield* loadScreening(messageTs);

  if (Option.isNone(after)) return;

  yield* store.save(messageTs, {
    ...after.value,
    phase: "ready",
    pending: askable(verdicts),
  });

  // A no-op while the countdown runs; when the ready alarm is the one
  // screening, the countdown is over and this ends the ready screen next.
  yield* store.setAlarm(after.value.deadline);
  yield* (yield* ScreeningLog).record(quiz, verdicts);
});

/**
 * The countdown ran out before screening cleared enough questions: say so on
 * the ready screen and keep looking, starting at once.
 */
const extend = Effect.fn("extend")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  const { extendedReadySecs } = yield* WorkerConfig;

  yield* updateChannelMessage(
    messageTs,
    renderChannelExtended(record.maxQuestions, record.timeoutSecs),
    "Finding good questions is taking longer than expected",
  );

  const now = yield* Clock.currentTimeMillis;

  yield* store.save(messageTs, {
    ...record,
    phase: "extended",
    deadline: now,
    extendedUntil: now + extendedReadySecs * 1000,
  });

  yield* store.setAlarm(now);
});

/**
 * Give up on a quiz that no question passed screening for: the row is marked
 * finished and the alarm cleared first, like `complete`, and the apology is a
 * best-effort attempt on top.
 */
const cancel = Effect.fn("cancel")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  yield* Effect.logWarning("No question passed screening; cancelling the quiz");
  yield* store.finish(messageTs, { ...record, phase: "complete" });
  yield* store.deleteAlarm;

  yield* updateChannelMessage(
    messageTs,
    renderChannelCancelled(),
    "Sorry, no quiz this time: we couldn't find any good questions.",
  ).pipe(
    Effect.catch((error) => Effect.logError("Failed to post the apology:", error)),
  );
});

/**
 * The extended ready screen is over: start with the questions that passed,
 * on a fresh countdown that says the quiz is shorter, or cancel if none did.
 */
const settle = Effect.fn("settle")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  if (record.pending.length === 0) {
    return yield* cancel(messageTs, record);
  }

  const store = yield* QuizStore;
  const { readySecs } = yield* WorkerConfig;
  const total = record.questions.length + record.pending.length;

  const gifUrl = countdownGifUrl(
    record.origin,
    readySecs,
    `${record.pending[0].id}-shortened`,
  );

  const found =
    total === 1 ? "1 good question" : `${total} good questions`;

  yield* updateChannelMessage(
    messageTs,
    renderChannelReady(
      total,
      record.timeoutSecs,
      readySecs,
      gifUrl,
      `🔎 We only found ${found}, so this quiz is shorter than planned.`,
    ),
    `Trivia is starting with ${found}: first question in ${readySecs} seconds`,
  );

  const deadline = (yield* Clock.currentTimeMillis) + readySecs * 1000;

  yield* store.save(messageTs, {
    ...record,
    maxQuestions: total,
    phase: "ready",
    deadline,
  });

  yield* store.setAlarm(deadline);
});

/**
 * One more search on an extended ready screen: fetch and screen enough
 * questions to cover the shortfall twice over, skipping any already
 * waiting to be asked, then start the quiz if they do, or search again shortly. Once
 * the extended ready screen has run its course, settle for what passed; a
 * search still under way then is abandoned.
 *
 * What a search found is saved before the quiz is started, so a start that
 * fails transiently is retried without searching again.
 */
const search = Effect.fn("search")(function* (
  messageTs: string,
  record: QuizRecord,
) {
  const store = yield* QuizStore;
  const now = yield* Clock.currentTimeMillis;
  const until = record.extendedUntil ?? now;

  if (shortfall(record) <= 0) return yield* advance(messageTs, record);

  if (now >= until) return yield* settle(messageTs, record);

  const quiz = yield* screeningQuiz(messageTs);

  const known = new Set(record.pending.map((question) => question.id));

  const verdicts = yield* (yield* TriviaApi)
    .fetchQuestions(shortfall(record) * CANDIDATES_PER_QUESTION)
    .pipe(
      Effect.catchTag("TriviaApiError", (error) =>
        Effect.logWarning("Failed to fetch more trivia questions:", error).pipe(
          Effect.as([]),
        ),
      ),
      Effect.flatMap((fetched) =>
        screenQuestions(fetched.filter((question) => !known.has(question.id))),
      ),
      Effect.timeoutOption(Duration.millis(until - now)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logWarning(
              "The extended ready screen ran out mid-search",
            ).pipe(Effect.as([])),
          onSome: Effect.succeed,
        }),
      ),
    );

  const found = {
    ...record,
    pending: [...record.pending, ...askable(verdicts)],
  };

  yield* store.save(messageTs, found);
  yield* (yield* ScreeningLog).record(quiz, verdicts);

  if (shortfall(found) <= 0) return yield* advance(messageTs, found);

  const later = yield* Clock.currentTimeMillis;

  if (later >= until) return yield* settle(messageTs, found);

  const deadline = Math.min(later + SEARCH_INTERVAL_MS, until);

  yield* store.save(messageTs, { ...found, deadline });
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
    const quiz = yield* restore(record, [...record.pending]);

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
  QuizStore | SlackClient | WorkerConfig | TriviaApi | Jev | ScreeningLog
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
    Match.when("screening", () => screen(messageTs)),
    Match.when("ready", () =>
      shortfall(record) > 0
        ? extend(messageTs, record)
        : advance(messageTs, record),
    ),
    Match.when("extended", () => search(messageTs, record)),
    Match.when("question", () => showResults(messageTs, record)),
    Match.when("results", () => advance(messageTs, record)),
    Match.orElse(() => Effect.void),
  );

  yield* transition.pipe(
    Effect.catchTag("QuizCompleteError", () => complete(messageTs, record)),
    // A message that can no longer be updated or a question source that ran
    // dry ends the quiz rather than leaving the channel in a half state.
    Effect.catchTag(
      [
        "SlackApiError",
        "ChannelUnknownError",
        "QuestionsExhaustedError",
        "NoCurrentQuestionError",
      ],
      (error) =>
        Effect.logError("Quiz failed to advance; ending quiz:", error).pipe(
          Effect.andThen(complete(messageTs, record)),
        ),
    ),
    // A snapshot that cannot be rebuilt has no leaderboard to end on.
    Effect.catchTag(
      ["UnsupportedSnapshotVersionError", "InvalidQuizSnapshotError"],
      (error) => abandon(messageTs, error),
    ),
  );
}).pipe(
  // A row that does not decode would otherwise fail every alarm and hold the
  // channel forever.
  Effect.catchTag("UndecodableQuizRecordError", (error) =>
    abandon(error.messageTs, error),
  ),
  Effect.tapError((error) =>
    Effect.logWarning(`${error.message}; the alarm will be retried:`, error),
  ),
  Effect.withSpan("alarm"),
);
