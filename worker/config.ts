import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { MAX_TIMEOUT_SECS, RESULTS_SECS } from "../src/timing";

/**
 * Countdown GIFs are pre-rendered for every whole second up to
 * `MAX_TIMEOUT_SECS`, so an override outside that range would point the
 * results frame at an image that was never built; those fall back.
 */
const resultsSecs = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECS })),
  "RESULTS_SECS",
).pipe(Config.orElse(() => Config.succeed(RESULTS_SECS)));

/** The channel object's settings, read from its env bindings. */
export class WorkerConfig extends Context.Service<
  WorkerConfig,
  {
    readonly slackBotToken: Redacted.Redacted<string>;
    /** How long results stay up before the next question, in seconds. */
    readonly resultsSecs: number;
  }
>()("slack-trivia/worker/WorkerConfig") {
  static readonly layer = Layer.effect(
    WorkerConfig,
    Effect.gen(function* () {
      return WorkerConfig.of({
        // Failing here would fail every RPC, answers and recaps included,
        // since the object builds its services once; a missing token only
        // fails the Slack calls, which Slack refuses as `not_authed`.
        slackBotToken: yield* Config.Redacted("SLACK_BOT_TOKEN").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        resultsSecs: yield* resultsSecs,
      });
    }),
  );
}
