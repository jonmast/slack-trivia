import { Context, Effect, Layer, Option, Schema } from "effect";
import { QuizSnapshot, TriviaQuestion } from "../src/trivia-core";

/** The Durable Object's own storage: its SQLite database and its alarm. */
export class ChannelStorage extends Context.Service<
  ChannelStorage,
  DurableObjectStorage
>()("slack-trivia/worker/ChannelStorage") {}

/**
 * Where a quiz is in its cycle. A `ready` phase ends when the first question
 * is due, a `question` phase at the answer window's deadline, a `results`
 * phase that many seconds later; `complete` sets no alarm.
 */
const Phase = Schema.Literals(["ready", "question", "results", "complete"]);

/**
 * The `state` column: the quiz snapshot plus what only the channel object
 * needs — which phase it is in, the absolute epoch-ms deadline that phase's
 * alarm is set to, the questions fetched at start but not yet asked, and the
 * origin the countdown GIFs are served from (there is no request to derive it
 * from when an alarm fires).
 */
export const QuizRecord = Schema.Struct({
  ...QuizSnapshot.fields,
  phase: Phase,
  deadline: Schema.Number,
  pending: Schema.Array(TriviaQuestion),
  origin: Schema.String,
});

export type QuizRecord = typeof QuizRecord.Type;

/** The channel's running quiz, keyed by the message it is played in. */
type RunningQuiz = {
  messageTs: string;
  record: QuizRecord;
};

/** A stored quiz row whose `state` no longer decodes as a `QuizRecord`. */
export class UndecodableQuizRecordError extends Schema.TaggedError<UndecodableQuizRecordError>()(
  "UndecodableQuizRecordError",
  { messageTs: Schema.String, message: Schema.String },
) {}

const decodeQuizRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(QuizRecord),
);

/**
 * The channel object's persistence: its SQLite tables and its alarm. Every
 * method but the alarm ones is synchronous, so a caller that awaits nothing
 * between a state change and its write keeps both in one transaction.
 */
export class QuizStore extends Context.Service<
  QuizStore,
  {
    readonly migrate: Effect.Effect<void>;
    readonly rememberChannel: (channelId: string) => Effect.Effect<void>;
    /** The channel this object belongs to; none before its first use. */
    readonly channelId: Effect.Effect<Option.Option<string>>;
    /** True if there is a quiz with status 'running' in the channel. */
    readonly hasRunningQuiz: Effect.Effect<boolean>;
    readonly insertRunning: (
      messageTs: string,
      record: QuizRecord,
    ) => Effect.Effect<void>;
    readonly loadRunning: Effect.Effect<
      Option.Option<RunningQuiz>,
      UndecodableQuizRecordError
    >;
    readonly loadFinished: (
      messageTs: string,
    ) => Effect.Effect<Option.Option<QuizRecord>, UndecodableQuizRecordError>;
    readonly save: (messageTs: string, record: QuizRecord) => Effect.Effect<void>;
    readonly finish: (
      messageTs: string,
      record: QuizRecord,
    ) => Effect.Effect<void>;
    /** Mark a quiz finished without rewriting its state, which may be unreadable. */
    readonly abandon: (messageTs: string) => Effect.Effect<void>;
    readonly setAlarm: (deadline: number) => Effect.Effect<void>;
    readonly deleteAlarm: Effect.Effect<void>;
  }
>()("slack-trivia/worker/QuizStore") {
  static readonly layer = Layer.effect(
    QuizStore,
    Effect.gen(function* () {
      const storage = yield* ChannelStorage;
      const sql = storage.sql;

      const decodeRow = (messageTs: string, state: string) =>
        decodeQuizRecord(state).pipe(
          Effect.mapError(
            (error) =>
              new UndecodableQuizRecordError({
                messageTs,
                message: error.message,
              }),
          ),
        );

      const migrate = Effect.sync(() => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);

        const { version } = sql
          .exec<{ version: number }>(
            "SELECT COALESCE(MAX(id), 0) AS version FROM migrations",
          )
          .one();

        if (version < 1) {
          sql.exec(`
            CREATE TABLE channel (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              channel_id TEXT NOT NULL
            );
            INSERT INTO migrations (id) VALUES (1);
          `);
        }

        if (version < 2) {
          sql.exec(`
            CREATE TABLE quizzes (
              message_ts TEXT PRIMARY KEY,
              status TEXT NOT NULL CHECK (status = 'running' OR status = 'finished'),
              state TEXT NOT NULL
            );
            INSERT INTO migrations (id) VALUES (2);
          `);
        }
      });

      return QuizStore.of({
        migrate,

        // The object is addressed by a hash of the channel ID, so it can only
        // learn which channel that is from the first request that reaches it.
        rememberChannel: (channelId) =>
          Effect.sync(() => {
            sql.exec(
              "INSERT INTO channel (id, channel_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING",
              channelId,
            );
          }),

        channelId: Effect.sync(() =>
          Option.fromUndefinedOr(
            sql
              .exec<{ channel_id: string }>(
                "SELECT channel_id FROM channel WHERE id = 1",
              )
              .toArray()[0]?.channel_id,
          ),
        ),

        hasRunningQuiz: Effect.sync(() => {
          const row = sql
            .exec<{ cnt: number }>(
              "SELECT COUNT(*) AS cnt FROM quizzes WHERE status = 'running'",
            )
            .one();

          return row.cnt > 0;
        }),

        insertRunning: (messageTs, record) =>
          Effect.sync(() => {
            sql.exec(
              "INSERT INTO quizzes (message_ts, status, state) VALUES (?, 'running', ?)",
              messageTs,
              JSON.stringify(record),
            );
          }),

        loadRunning: Effect.suspend(() => {
          const row = sql
            .exec<{ message_ts: string; state: string }>(
              "SELECT message_ts, state FROM quizzes WHERE status = 'running'",
            )
            .toArray()[0];

          if (!row) return Effect.succeedNone;

          return decodeRow(row.message_ts, row.state).pipe(
            Effect.map((record) =>
              Option.some({ messageTs: row.message_ts, record }),
            ),
          );
        }),

        loadFinished: (messageTs) =>
          Effect.suspend(() => {
            const row = sql
              .exec<{ state: string }>(
                "SELECT state FROM quizzes WHERE message_ts = ? AND status = 'finished'",
                messageTs,
              )
              .toArray()[0];

            if (!row) return Effect.succeedNone;

            return decodeRow(messageTs, row.state).pipe(Effect.map(Option.some));
          }),

        save: (messageTs, record) =>
          Effect.sync(() => {
            sql.exec(
              "UPDATE quizzes SET state = ? WHERE message_ts = ?",
              JSON.stringify(record),
              messageTs,
            );
          }),

        finish: (messageTs, record) =>
          Effect.sync(() => {
            sql.exec(
              "UPDATE quizzes SET status = 'finished', state = ? WHERE message_ts = ?",
              JSON.stringify(record),
              messageTs,
            );
          }),

        abandon: (messageTs) =>
          Effect.sync(() => {
            sql.exec(
              "UPDATE quizzes SET status = 'finished' WHERE message_ts = ?",
              messageTs,
            );
          }),

        setAlarm: (deadline) => Effect.promise(() => storage.setAlarm(deadline)),

        deleteAlarm: Effect.promise(() => storage.deleteAlarm()),
      });
    }),
  );
}
