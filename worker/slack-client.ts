import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { AnyMessageBlock } from "slack-cloudflare-workers";
import { WorkerConfig } from "./config";

const SLACK_API_URL = "https://slack.com/api";

/**
 * Slack could not be reached or answered with an HTTP error (a rate limit, a
 * 5xx, a dropped connection, a body that is not a Slack reply). Transient:
 * the same call may well succeed if retried.
 */
export class SlackRequestError extends Schema.TaggedError<SlackRequestError>()(
  "SlackRequestError",
  { method: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.method} request failed`;
  }
}

/**
 * Slack answered and refused the call (`ok: false`), for example
 * `message_not_found`. Permanent: retrying will not change its mind.
 */
export class SlackApiError extends Schema.TaggedError<SlackApiError>()(
  "SlackApiError",
  { method: Schema.String, error: Schema.String },
) {
  override get message(): string {
    return `${this.method} failed: ${this.error}`;
  }
}

/** The JSON body of `chat.postMessage` and `chat.update`. */
type MessageBody = {
  channel: string;
  ts?: string;
  blocks: AnyMessageBlock[];
  /** Fallback for notifications and accessibility. */
  text: string;
};

const Refused = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.optional(Schema.String),
});

const PostMessageReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ts: Schema.String }),
  Refused,
]);

const UpdateReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Refused,
]);

export class SlackClient extends Context.Service<
  SlackClient,
  {
    /** `chat.postMessage`; succeeds with the new message's timestamp. */
    readonly postMessage: (
      channel: string,
      blocks: AnyMessageBlock[],
      text: string,
    ) => Effect.Effect<string, SlackRequestError | SlackApiError>;
    /** `chat.update` of the message posted at `ts`. */
    readonly updateMessage: (
      channel: string,
      ts: string,
      blocks: AnyMessageBlock[],
      text: string,
    ) => Effect.Effect<void, SlackRequestError | SlackApiError>;
  }
>()("slack-trivia/worker/SlackClient") {
  static readonly layer = Layer.effect(
    SlackClient,
    Effect.gen(function* () {
      const { slackBotToken } = yield* WorkerConfig;

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
      );

      const call = <A, RD>(
        method: string,
        body: MessageBody,
        reply: Schema.Decoder<A, RD>,
      ) =>
        client
          .execute(
            HttpClientRequest.post(`${SLACK_API_URL}/${method}`).pipe(
              HttpClientRequest.bearerToken(slackBotToken),
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          )
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(reply)),
            Effect.mapError((cause) => new SlackRequestError({ method, cause })),
          );

      const refused = (method: string, error: string | undefined) =>
        new SlackApiError({ method, error: error ?? "unknown" });

      return SlackClient.of({
        postMessage: Effect.fn("SlackClient.postMessage")(function* (
          channel,
          blocks,
          text,
        ) {
          const reply = yield* call(
            "chat.postMessage",
            { channel, blocks, text },
            PostMessageReply,
          );

          if (!reply.ok) {
            return yield* refused("chat.postMessage", reply.error);
          }

          return reply.ts;
        }),

        updateMessage: Effect.fn("SlackClient.updateMessage")(function* (
          channel,
          ts,
          blocks,
          text,
        ) {
          const reply = yield* call(
            "chat.update",
            { channel, ts, blocks, text },
            UpdateReply,
          );

          if (!reply.ok) {
            return yield* refused("chat.update", reply.error);
          }
        }),
      });
    }),
  );
}
