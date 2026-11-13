import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { MAX_TIMEOUT_SECS, READY_SECS, RESULTS_SECS } from "../src/timing";

/** The Jev model screening asks; the paid one, so screening outlives the free offer. */
const JEV_MODEL = "jev-1.13";

/** How long screening waits on Jev before asking questions unscreened, in ms. */
const JEV_TIMEOUT_MS = 6000;

/** How long an extended ready screen keeps looking for questions, in seconds. */
const EXTENDED_READY_SECS = 30;

/** A whole number of seconds from `name`, or `fallback` when unset or out of range. */
function secs(name: string, fallback: number, maximum: number) {
  return Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })),
    name,
  ).pipe(Config.orElse(() => Config.succeed(fallback)));
}

/**
 * Countdown GIFs are pre-rendered for every whole second up to
 * `MAX_TIMEOUT_SECS`, so an override outside that range would point the
 * frame at an image that was never built; those fall back.
 */
function countdownSecs(name: string, fallback: number) {
  return secs(name, fallback, MAX_TIMEOUT_SECS);
}

/** The channel object's settings, read from its env bindings. */
export class WorkerConfig extends Context.Service<
  WorkerConfig,
  {
    readonly slackBotToken: Redacted.Redacted<string>;
    /** How long results stay up before the next question, in seconds. */
    readonly resultsSecs: number;
    /** How long the ready screen stays up before the first question, in seconds. */
    readonly readySecs: number;
    /** The OpenCode Console key Jev is called with; empty when unset. */
    readonly opencodeApiKey: Redacted.Redacted<string>;
    readonly jevModel: string;
    readonly jevTimeoutMs: number;
    /** How long past its countdown the ready screen keeps looking for questions. */
    readonly extendedReadySecs: number;
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
        resultsSecs: yield* countdownSecs("RESULTS_SECS", RESULTS_SECS),
        readySecs: yield* countdownSecs("READY_SECS", READY_SECS),
        // Likewise, a missing key only leaves questions unscreened.
        opencodeApiKey: yield* Config.Redacted("OPENCODE_API_KEY").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        jevModel: JEV_MODEL,
        jevTimeoutMs: yield* Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
          "JEV_TIMEOUT_MS",
        ).pipe(Config.orElse(() => Config.succeed(JEV_TIMEOUT_MS))),
        extendedReadySecs: yield* secs(
          "EXTENDED_READY_SECS",
          EXTENDED_READY_SECS,
          120,
        ),
      });
    }),
  );
}
