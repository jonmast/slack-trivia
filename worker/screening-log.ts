import { Clock, Context, Effect, Layer } from "effect";
import type { Verdict } from "./screening";

/** The D1 database every channel records its screening verdicts in. */
export class ScreeningDatabase extends Context.Service<
  ScreeningDatabase,
  D1Database
>()("slack-trivia/worker/ScreeningDatabase") {}

/** Where a quiz's verdicts belong: its channel and the message it is played in. */
export type ScreeningQuiz = {
  readonly channelId: string;
  readonly messageTs: string;
};

/**
 * The record of every screening verdict: a structured log line each, and a
 * `screenings` row each in D1. Never fails: a verdict that cannot be stored
 * is logged as such, and the quiz carries on.
 */
export class ScreeningLog extends Context.Service<
  ScreeningLog,
  {
    readonly record: (
      quiz: ScreeningQuiz,
      verdicts: ReadonlyArray<Verdict>,
    ) => Effect.Effect<void>;
  }
>()("slack-trivia/worker/ScreeningLog") {
  static readonly layer = Layer.effect(
    ScreeningLog,
    Effect.gen(function* () {
      const db = yield* ScreeningDatabase;

      const insert = db.prepare(`
        INSERT INTO screenings (
          question_id, channel_id, message_ts, question, options,
          correct_answer, outcome, class, probabilities, model, screened_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      return ScreeningLog.of({
        record: Effect.fn("ScreeningLog.record")(function* (quiz, verdicts) {
          if (verdicts.length === 0) return;

          const screenedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

          const rows = verdicts.map(({ question, outcome, screeningClass, probabilities, model }) => ({
            questionId: question.id,
            channelId: quiz.channelId,
            messageTs: quiz.messageTs,
            question: question.question.text,
            options: [question.correctAnswer, ...question.incorrectAnswers],
            correctAnswer: question.correctAnswer,
            outcome,
            class: screeningClass,
            probabilities: probabilities && Object.fromEntries(probabilities),
            model,
            screenedAt,
          }));

          yield* Effect.forEach(rows, (row) =>
            Effect.log(`Screening verdict: ${row.outcome}`).pipe(
              Effect.annotateLogs({ screening: row }),
            ),
          );

          yield* Effect.tryPromise(() =>
            db.batch(
              rows.map((row) =>
                insert.bind(
                  row.questionId,
                  row.channelId,
                  row.messageTs,
                  row.question,
                  JSON.stringify(row.options),
                  row.correctAnswer,
                  row.outcome,
                  row.class,
                  row.probabilities && JSON.stringify(row.probabilities),
                  row.model,
                  row.screenedAt,
                ),
              ),
            ),
          ).pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to record screening verdicts:", error),
            ),
          );
        }),
      });
    }),
  );
}
