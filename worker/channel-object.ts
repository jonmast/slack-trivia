import { DurableObject } from "cloudflare:workers";
import { Config, ConfigProvider, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { RecapQuestion } from "../src/trivia-core";
import {
  alarm,
  getRecap,
  startQuiz,
  submitAnswer,
  type StartQuizResult,
} from "./channel-quiz";
import { WorkerConfig } from "./config";
import type { Env } from "./env";
import { WorkerLogger } from "./logger";
import { ChannelStorage, QuizStore } from "./quiz-store";
import { SlackClient } from "./slack-client";
import { TriviaApi } from "./trivia-api";

export type { StartQuizResult } from "./channel-quiz";

/** Everything a channel quiz program runs against, built from the object's bindings. */
function channelLayer(ctx: DurableObjectState, env: Env) {
  const platform = Layer.mergeAll(
    Layer.succeed(ChannelStorage)(ctx.storage),
    FetchHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
  );

  const config = WorkerConfig.layer.pipe(Layer.provide(platform));

  return Layer.mergeAll(
    QuizStore.layer,
    TriviaApi.layer,
    SlackClient.layer.pipe(Layer.provide(config)),
    config,
    WorkerLogger,
    // Slack and The Trivia API are not part of our traces: no trace headers.
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
    QuizStore | TriviaApi | SlackClient | WorkerConfig,
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
   * Object's output gate holds the Slack ack until it commits. That is why it
   * runs with `runSync`, which throws rather than suspend if the program ever
   * tried to wait on anything.
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
  getRecap(userId: string, messageTs: string): RecapQuestion[] | null {
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
