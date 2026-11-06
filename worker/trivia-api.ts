import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TriviaQuestion } from "../src/trivia-core";

const TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions";

/** The Trivia API could not be reached, or sent something other than questions. */
export class TriviaApiError extends Schema.TaggedError<TriviaApiError>()(
  "TriviaApiError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not fetch trivia questions";
  }
}

const decodeQuestions = Schema.decodeUnknownEffect(
  Schema.Array(TriviaQuestion),
);

export class TriviaApi extends Context.Service<
  TriviaApi,
  {
    /** Up to `count` questions in one request; the API may return fewer. */
    readonly fetchQuestions: (
      count: number,
    ) => Effect.Effect<readonly TriviaQuestion[], TriviaApiError>;
  }
>()("slack-trivia/worker/TriviaApi") {
  static readonly layer = Layer.effect(
    TriviaApi,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
      );

      return TriviaApi.of({
        fetchQuestions: Effect.fn("TriviaApi.fetchQuestions")(
          function* (count) {
            const response = yield* client.get(TRIVIA_API_URL, {
              urlParams: { limit: count },
            });

            return yield* decodeQuestions(yield* response.json);
          },
          Effect.mapError((cause) => new TriviaApiError({ cause })),
        ),
      });
    }),
  );
}
