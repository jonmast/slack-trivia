import { DurableObject } from "cloudflare:workers";
import { Config, ConfigProvider, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  alarm,
  getRecap,
  startQuiz,
  submitAnswer,
  type RecapLookup,
  type StartQuizResult,
} from "./channel-quiz";
import { WorkerConfig } from "./config";
import type { Env } from "./env";
import { Jev } from "./jev";
import { WorkerLogger } from "./logger";
import { ChannelStorage, QuizStore } from "./quiz-store";
import { ScreeningDatabase, ScreeningLog } from "./screening-log";
import { SlackClient } from "./slack-client";
import { TriviaApi } from "./trivia-api";

/** Everything a channel quiz program runs against, built from the object's bindings. */
function channelLayer(ctx: DurableObjectState, env: Env) {
  const platform = Layer.mergeAll(
    Layer.succeed(ChannelStorage)(ctx.storage),
    Layer.succeed(ScreeningDatabase)(env.DB),
    FetchHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
  );

  const config = WorkerConfig.layer.pipe(Layer.provide(platform));

  return Layer.mergeAll(
    QuizStore.layer,
    TriviaApi.layer,
    SlackClient.layer.pipe(Layer.provide(config)),
    Jev.layer.pipe(Layer.provide(config)),
    ScreeningLog.layer,
    config,
    WorkerLogger,
    // Slack, The Trivia API and Jev are not part of our traces: no trace headers.
    Layer.succeed(HttpClient.TracerPropagationEnabled)(false),
  ).pipe(Layer.provide(platform));
}

/**
 * One Durable Object per Slack channel, addressed by `idFromName(channelId)`.
 * It owns everything that channel's quizzes need. Each RPC method runs one
 * program from `channel-quiz.ts` against services built once per instance.
 */
export class ChannelObject extends DurableObject<Env> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    QuizStore | TriviaApi | SlackClient | WorkerConfig | Jev | ScreeningLog,
    Config.ConfigError
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = ManagedRuntime.make(channelLayer(ctx, env));
    // No request is served until the schema exists.
    ctx.blockConcurrencyWhile(async () => {
      this.runtime.runSync(QuizStore.use((store) => store.migrate));
    });
  }

  /** Start a channel quiz; see `startQuiz` in `channel-quiz.ts`. */
  startQuiz(
    channelId: string,
    text: string,
    origin: string,
  ): Promise<StartQuizResult> {
    return this.runtime.runPromise(startQuiz(channelId, text, origin));
  }

  /**
   * Record a participant's answer; see `submitAnswer` in `channel-quiz.ts`.
   *
   * Deliberately synchronous: nothing is awaited between the state change and
   * the write, so the write coalesces into one transaction and the Durable
   * Object's output gate holds the Slack ack until it commits. It runs with
   * `runSync` as a tripwire, not a guard: a program that waited on anything
   * would make the call throw `AsyncFiberError`, surfacing the mistake in
   * tests, but the suspended fiber is left running and could still write
   * after the RPC has thrown.
   */
  submitAnswer(
    userId: string,
    answerId: string,
    questionId: string,
    answeredAt: number,
  ): void {
    this.runtime.runSync(submitAnswer(userId, answerId, questionId, answeredAt));
  }

  /** A participant's recap of the quiz hosted by `messageTs`; see `getRecap`. */
  getRecap(userId: string, messageTs: string): RecapLookup {
    return this.runtime.runSync(getRecap(userId, messageTs));
  }

  /**
   * The due phase transition; see `alarm` in `channel-quiz.ts`. A transient
   * failure rejects, so the platform retries the alarm.
   */
  alarm(): Promise<void> {
    return this.runtime.runPromise(alarm);
  }

  /** True if there is a quiz with status 'running' in the channel. */
  hasRunningQuiz(): boolean {
    return this.runtime.runSync(QuizStore.use((store) => store.hasRunningQuiz));
  }

  /** The channel this object belongs to, or null before its first use. */
  getChannelId(): string | null {
    return Option.getOrNull(
      this.runtime.runSync(QuizStore.use((store) => store.channelId)),
    );
  }
}
