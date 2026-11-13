import { Effect, Option } from "effect";
import type { TriviaQuestion } from "../src/trivia-core";
import { Jev, type JevChoice, type JevClass } from "./jev";
import { ScreeningLog, type ScreeningQuiz } from "./screening-log";

/** Every class Jev sorts a question into; only `good` questions are asked. */
export const SCREENING_CLASSES: ReadonlyArray<JevClass> = [
  {
    name: "good",
    description:
      "A fair, well-formed trivia question: the wording is clear, the marked answer is correct and is the only defensible option, and the other three options are plausible wrong answers on the same topic. Choose this only when none of the other classes applies.",
  },
  {
    name: "misleading",
    description:
      "The question is readable but unfair: the marked answer is wrong, outdated by consensus or debatable; more than one option could reasonably be defended as correct; or the wording points towards a wrong option or hinges on a trick reading. Not for broken text (garbled) or answers that depend on today's date (stale).",
  },
  {
    name: "garbled",
    description:
      "The question cannot be read as intended: broken or truncated text, encoding damage or stray markup, a question that does not parse as a question, or options that do not answer what is asked (wrong type of thing, different topic, duplicates). Not for a readable question whose answer is merely wrong (misleading).",
  },
  {
    name: "stale",
    description:
      "The correct answer depends on when the question is asked: current office holders, reigning champions, latest releases, records that may since have been broken, ages, 'currently', 'most recent' or 'this year'. Not for historical facts that are fixed to a date stated or implied in the question.",
  },
  {
    name: "giveaway",
    description:
      "The question is otherwise fine but answers itself: one option is obviously the only plausible one because the others are absurd, from an unrelated category, or the answer is repeated in the question. Not for a question that is merely easy when every option is still plausible.",
  },
];

const SCREENING_PURPOSE =
  "Screen multiple-choice trivia questions for a team quiz before they are asked. Each item gives a question's category, its text and its four options with the correct one marked. Only questions that are fair, well-formed and answerable without knowing today's date should be asked; when in doubt, prefer rejecting a question over asking a bad one.";

/** The least probability of `good` a question is asked with. */
export const ACCEPT_PROBABILITY = 0.7;

/**
 * `served`: screened and cleared to be asked; `rejected`: screened and never
 * shown; `unscreened`: Jev could not judge it, so it may be asked anyway.
 */
export type ScreeningOutcome = "served" | "rejected" | "unscreened";

export type Verdict = {
  readonly question: TriviaQuestion;
  readonly outcome: ScreeningOutcome;
  /** Jev's top class; null when Jev gave none. */
  readonly screeningClass: string | null;
  readonly probabilities: ReadonlyMap<string, number> | null;
  /** The model that judged it; null when unscreened. */
  readonly model: string | null;
};

/** What Jev reads for one question: category, text and options, the correct one marked. */
export function screeningItem(question: TriviaQuestion): string {
  const options = [question.correctAnswer, ...question.incorrectAnswers]
    .sort((a, b) => a.localeCompare(b))
    .map((option) =>
      option === question.correctAnswer ? `- ${option} (correct)` : `- ${option}`,
    );

  return [
    `Category: ${question.category ?? "unknown"}`,
    `Question: ${question.question.text}`,
    "Options:",
    ...options,
  ].join("\n");
}

const unscreened = (question: TriviaQuestion): Verdict => ({
  question,
  outcome: "unscreened",
  screeningClass: null,
  probabilities: null,
  model: null,
});

/** A question Jev gave no usable answer for is unscreened, not rejected. */
function judge(
  question: TriviaQuestion,
  model: string,
  choice: Option.Option<JevChoice>,
): Verdict {
  if (Option.isNone(choice)) return unscreened(question);

  const { choice: screeningClass, probabilities } = choice.value;

  const accepted =
    screeningClass === "good" &&
    (probabilities.get("good") ?? 0) >= ACCEPT_PROBABILITY;

  return {
    question,
    outcome: accepted ? "served" : "rejected",
    screeningClass,
    probabilities,
    model,
  };
}

/**
 * Screen `candidates` with Jev in one request and record every verdict. When
 * Jev cannot be reached or errors, every candidate is unscreened: a quiz is
 * never held up on Jev. Never fails.
 */
export const screenQuestions = Effect.fn("screenQuestions")(function* (
  quiz: ScreeningQuiz,
  candidates: ReadonlyArray<TriviaQuestion>,
) {
  if (candidates.length === 0) return [];

  const verdicts = yield* (yield* Jev)
    .classify(SCREENING_PURPOSE, SCREENING_CLASSES, candidates.map(screeningItem))
    .pipe(
      Effect.map(({ model, choices }) =>
        candidates.map((question, index) =>
          judge(question, model, choices[index] ?? Option.none()),
        ),
      ),
      Effect.catchTag("JevUnavailableError", (error) =>
        Effect.logWarning("Jev is unavailable; questions go unscreened:", error).pipe(
          Effect.as(candidates.map(unscreened)),
        ),
      ),
    );

  yield* (yield* ScreeningLog).record(quiz, verdicts);

  return verdicts;
});

/** The questions a quiz may ask out of `verdicts`, in order. */
export function askable(verdicts: ReadonlyArray<Verdict>): TriviaQuestion[] {
  return verdicts.flatMap(({ question, outcome }) =>
    outcome === "rejected" ? [] : [question],
  );
}
