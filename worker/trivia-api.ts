import { Context, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";
import { OPTION_TEXT_MAX } from "../src/slack-ui";
import { TriviaQuestion } from "../src/trivia-core";

const TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions";

/** How long a fetch may take before it counts as failed. */
const FETCH_TIMEOUT = Duration.seconds(5);

/**
 * The Trivia API could not be reached, did not answer in time, or sent
 * something other than questions.
 */
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

/** Slack would cut off a radio button label longer than this. */
function fitsSlack(question: TriviaQuestion): boolean {
  return [question.correctAnswer, ...question.incorrectAnswers].every(
    (answer) => answer.length <= OPTION_TEXT_MAX,
  );
}

export class TriviaApi extends Context.Service<
  TriviaApi,
  {
    /**
     * Up to `count` questions in one request; the API may return fewer, and
     * questions with an answer too long for Slack are dropped.
     */
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

            const questions = yield* decodeQuestions(yield* response.json);

            for (const question of questions) {
              if (fitsSlack(question)) continue;

              yield* Effect.log("Dropped question: an answer is too long for Slack").pipe(
                Effect.annotateLogs({ tooLong: question }),
              );
            }

            return questions.filter(fitsSlack);
          },
          Effect.timeout(FETCH_TIMEOUT),
          Effect.mapError((cause) => new TriviaApiError({ cause })),
        ),
      });
    }),
  );
}
