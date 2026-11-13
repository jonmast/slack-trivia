import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { WorkerConfig } from "./config";

const JEV_URL = "https://opencode.ai/inference/systemone/v1/systemone";

const CHOICE_TASK = "Which class does this item belong to?";

/**
 * Jev could not classify: no API key, no answer in time, an HTTP error, or a
 * reply that does not decode.
 */
export class JevUnavailableError extends Schema.TaggedError<JevUnavailableError>()(
  "JevUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Jev could not classify the items";
  }
}

/** One class an item can be sorted into. */
export type JevClass = {
  readonly name: string;
  readonly description: string;
};

/** Jev's verdict on one item: its top class and every class's probability. */
export type JevChoice = {
  readonly choice: string;
  readonly probabilities: ReadonlyMap<string, number>;
};

export type JevClassification = {
  /** The model that answered. */
  readonly model: string;
  /** One per item, in order; none where Jev left an item unanswered. */
  readonly choices: ReadonlyArray<Option.Option<JevChoice>>;
};

const ChoiceAnswer = Schema.Struct({
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
});

const ClassifyReply = Schema.Struct({
  model: Schema.optional(Schema.String),
  answers: Schema.Record(Schema.String, ChoiceAnswer),
});

const decodeReply = Schema.decodeUnknownEffect(ClassifyReply);

/** Wire IDs for classes and items: Jev's keys, never shown to anyone. */
const classId = (index: number) => `c${index}`;

const itemId = (index: number) => `i${index}`;

/** Jev's classifier, called through OpenCode Zen. */
export class Jev extends Context.Service<
  Jev,
  {
    /** Sort every item into one of `classes`, in a single request. */
    readonly classify: (
      purpose: string,
      classes: ReadonlyArray<JevClass>,
      items: ReadonlyArray<string>,
    ) => Effect.Effect<JevClassification, JevUnavailableError>;
  }
>()("slack-trivia/worker/Jev") {
  static readonly layer = Layer.effect(
    Jev,
    Effect.gen(function* () {
      const { opencodeApiKey, jevModel, jevTimeoutMs } = yield* WorkerConfig;

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
      );

      return Jev.of({
        classify: Effect.fn("Jev.classify")(
          function* (purpose, classes, items) {
            if (Redacted.value(opencodeApiKey) === "") {
              return yield* Effect.fail("OPENCODE_API_KEY is not set");
            }

            const criteria = Object.fromEntries(
              classes.map((_, index) => [classId(index), null]),
            );

            const body = {
              model: jevModel,
              state: {
                purpose,
                classes: classes.map(({ description }, index) => ({
                  id: classId(index),
                  description,
                })),
              },
              questions: Object.fromEntries(
                items.map((text, index) => [
                  itemId(index),
                  {
                    type: "choice",
                    instructions: { task: CHOICE_TASK, item: { text } },
                    criteria,
                  },
                ]),
              ),
            };

            const response = yield* client.execute(
              HttpClientRequest.post(JEV_URL).pipe(
                HttpClientRequest.bearerToken(opencodeApiKey),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            );

            const reply = yield* decodeReply(yield* response.json);
            const names = new Map(classes.map(({ name }, index) => [classId(index), name]));

            const choiceFor = (index: number): Option.Option<JevChoice> => {
              const answer = reply.answers[itemId(index)];
              const choice = answer && names.get(answer.choice);

              if (!answer || !choice) return Option.none();

              const probabilities = new Map(
                Object.entries(answer.probabilities).flatMap(([id, p]) => {
                  const name = names.get(id);

                  return name ? [[name, p] as const] : [];
                }),
              );

              return Option.some({ choice, probabilities });
            };

            return {
              model: reply.model ?? jevModel,
              choices: items.map((_, index) => choiceFor(index)),
            };
          },
          Effect.timeout(Duration.millis(jevTimeoutMs)),
          Effect.mapError((cause) => new JevUnavailableError({ cause })),
        ),
      });
    }),
  );
}
