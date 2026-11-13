import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { WorkerConfig } from "./config";

const JEV_URL = "https://opencode.ai/inference/systemone/v1/systemone";

const CHOICE_TASK = "Which class does this item belong to?";

/**
 * Jev could not classify: no API key, no answer in time, an HTTP error, a
 * reply that does not decode, or one with no usable answer for any item.
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
  /**
   * One per item, in order; none where Jev's answer for an item is missing
   * or unusable. At least one is some.
   */
  readonly choices: ReadonlyArray<Option.Option<JevChoice>>;
};

/** Answers are decoded one by one, so one malformed answer spoils only its item. */
const ClassifyReply = Schema.Struct({
  model: Schema.optional(Schema.String),
  answers: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeReply = Schema.decodeUnknownEffect(ClassifyReply);

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Finite),
  }),
);

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

            // An answer is usable when it picks one of our classes and gives
            // that class's probability.
            const choiceFor = (index: number): Option.Option<JevChoice> =>
              Option.flatMap(
                decodeAnswer(reply.answers[itemId(index)]),
                (answer) => {
                  const choice = names.get(answer.choice);

                  const probabilities = new Map(
                    Object.entries(answer.probabilities).flatMap(([id, p]) => {
                      const name = names.get(id);

                      return name ? [[name, p] as const] : [];
                    }),
                  );

                  return choice && probabilities.has(choice)
                    ? Option.some({ choice, probabilities })
                    : Option.none();
                },
              );

            const choices = items.map((_, index) => choiceFor(index));

            if (!choices.some(Option.isSome)) {
              return yield* Effect.fail("Jev's reply has no usable answer");
            }

            return { model: reply.model ?? jevModel, choices };
          },
          Effect.timeout(Duration.millis(jevTimeoutMs)),
          Effect.mapError((cause) => new JevUnavailableError({ cause })),
        ),
      });
    }),
  );
}
