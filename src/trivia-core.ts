import crypto from "node:crypto";
import { Effect, Option, Schema } from "effect";

/**
 * A question as The Trivia API returns it, cut down to the fields the app
 * reads; decoding drops the rest. Running quizzes store their pending
 * questions and decode them again on every alarm, so checking fields nothing
 * uses would let an API change, or a row stored before one, strand a live quiz.
 */
export const TriviaQuestion = Schema.Struct({
  id: Schema.String,
  correctAnswer: Schema.String,
  incorrectAnswers: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
  question: Schema.Struct({
    text: Schema.String,
  }),
});

export type TriviaQuestion = typeof TriviaQuestion.Type;

export const Answer = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
});

export type Answer = typeof Answer.Type;

export type Response = {
  userId: string;
  answerId: string;
  timestamp: Date;
};

export type UserScore = {
  userId: string;
  /** Whole points: one per correct answer. */
  score: number;
  /** Kept apart from `score`: it only breaks ties on points. */
  speedBonus: number;
  totalAnswered: number;
};

export type RecapOption = {
  text: string;
  selected: boolean;
  correct: boolean;
};

export type RecapQuestion = {
  text: string;
  options: RecapOption[];
  answered: boolean;
  points: number;
  speedBonus: number;
};

export class QuizCompleteError extends Schema.TaggedError<QuizCompleteError>()(
  "QuizCompleteError",
  {},
) {
  override get message(): string {
    return "Quiz has reached the maximum number of questions";
  }
}

/** The question source ran dry before the quiz asked all its questions. */
export class QuestionsExhaustedError extends Schema.TaggedError<QuestionsExhaustedError>()(
  "QuestionsExhaustedError",
  {},
) {
  override get message(): string {
    return "No questions available";
  }
}

export class NoActiveQuizError extends Schema.TaggedError<NoActiveQuizError>()(
  "NoActiveQuizError",
  {},
) {
  override get message(): string {
    return "No active quiz";
  }
}

export class QuestionNotFoundError extends Schema.TaggedError<QuestionNotFoundError>()(
  "QuestionNotFoundError",
  { questionId: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return "Question not found";
  }
}

export class UnsupportedSnapshotVersionError extends Schema.TaggedError<UnsupportedSnapshotVersionError>()(
  "UnsupportedSnapshotVersionError",
  { version: Schema.Number },
) {
  override get message(): string {
    return `Unsupported quiz snapshot version ${this.version}`;
  }
}

/** A snapshot that decoded but contradicts itself, so it cannot be rebuilt. */
export class InvalidQuizSnapshotError extends Schema.TaggedError<InvalidQuizSnapshotError>()(
  "InvalidQuizSnapshotError",
  { message: Schema.String },
) {}

/** `/quizzo` text that does not parse; `message` is shown to the user as is. */
export class InvalidQuizzoArgsError extends Schema.TaggedError<InvalidQuizzoArgsError>()(
  "InvalidQuizzoArgsError",
  { message: Schema.String },
) {}

export type QuizState = {
  users: Set<string>;
  currentQuestion: Question | null;
  questions: Question[];
  isActive: boolean;
  maxQuestions: number;
};

export type Question = {
  question: TriviaQuestion;
  answers: Answer[];
  correctAnswer: Answer;
  responses: Response[];
  timestamp: Date;
};

/** Anything a quiz can draw its next trivia question from; none once it runs dry. */
export type QuestionSource = {
  get(): Option.Option<TriviaQuestion>;
};

export const QUIZ_SNAPSHOT_VERSION = 2;

export const ResponseSnapshot = Schema.Struct({
  userId: Schema.String,
  answerId: Schema.String,
  /** Epoch milliseconds; `Date` does not survive a JSON round-trip. */
  at: Schema.Number,
});

export type ResponseSnapshot = typeof ResponseSnapshot.Type;

export const QuestionSnapshot = Schema.Struct({
  question: TriviaQuestion,
  answers: Schema.Array(Answer),
  correctAnswerId: Schema.String,
  /** Epoch milliseconds the answer window started at. */
  startedAt: Schema.Number,
  responses: Schema.Array(ResponseSnapshot),
});

export type QuestionSnapshot = typeof QuestionSnapshot.Type;

/**
 * A quiz as plain JSON: no `Date`, no `Map`, no `Set`, no class instances, so a
 * caller can store it with `JSON.stringify`, decode it with this schema and
 * rebuild it with `Quiz.fromSnapshot`. Version 1 also stored running score
 * totals; decoding drops them.
 */
export const QuizSnapshot = Schema.Struct({
  version: Schema.Int,
  maxQuestions: Schema.Int,
  timeoutSecs: Schema.Int,
  isActive: Schema.Boolean,
  currentQuestionIndex: Schema.NullOr(Schema.Int),
  questions: Schema.Array(QuestionSnapshot),
  users: Schema.Array(Schema.String),
});

export type QuizSnapshot = typeof QuizSnapshot.Type;

/** How far a quiz has progressed: questions asked out of the configured total. */
export type QuizProgress = {
  current: number;
  total: number;
};

export const TIMEOUT_SECS = 5;
export const SPEED_BONUS_MAX = 0.2;
export const MAX_QUESTIONS = 20;
export const MAX_TIMEOUT_SECS = 60;

/** How long the per-question results screen stays up before the next question. */
export const RESULTS_SECS = 5;

export type QuizzoArgs = { numQuestions: number; timeoutSecs: number };

export const QUIZZO_USAGE =
  "Usage: `/quizzo [num_questions] [seconds]s`\nExample: `/quizzo 5 10s`";

/**
 * Parse `/quizzo [num_questions] [seconds]s` text. Fails with a message the
 * caller can respond with ephemerally.
 */
export const parseQuizzoArgs = Effect.fn("parseQuizzoArgs")(function* (
  text: string,
): Effect.fn.Return<QuizzoArgs, InvalidQuizzoArgsError> {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const args: QuizzoArgs = { numQuestions: 3, timeoutSecs: TIMEOUT_SECS };

  if (parts.length > 0) {
    const n = Number(parts[0]);

    if (!Number.isInteger(n) || n < 1 || n > MAX_QUESTIONS) {
      return yield* new InvalidQuizzoArgsError({
        message: `Invalid number of questions. Please provide a number between 1 and ${MAX_QUESTIONS}.\n${QUIZZO_USAGE}`,
      });
    }

    args.numQuestions = n;
  }

  if (parts.length > 1) {
    const match = /^(\d+)s$/.exec(parts[1]);
    const secs = match ? Number(match[1]) : NaN;

    if (!match) {
      return yield* new InvalidQuizzoArgsError({
        message: `Invalid time format. Seconds must be suffixed with 's'.\n${QUIZZO_USAGE}`,
      });
    }

    if (secs < 1 || secs > MAX_TIMEOUT_SECS) {
      return yield* new InvalidQuizzoArgsError({
        message: `Invalid timeout. Please provide seconds between 1 and ${MAX_TIMEOUT_SECS}.\n${QUIZZO_USAGE}`,
      });
    }

    args.timeoutSecs = secs;
  }

  return args;
});

export function withId(text: string): Answer {
  return {
    id: crypto.randomUUID(),
    text,
  };
}

export function shuffleAnswers(
  correctAnswer: Answer,
  incorrectAnswers: Answer[],
): Answer[] {
  // Fisher-Yates: uniform shuffle (sort with a random comparator is biased).
  const answers = [correctAnswer, ...incorrectAnswers];

  for (let i = answers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }

  return answers;
}

export function createQuestion(apiQuestion: TriviaQuestion): Question {
  const correctAnswer = withId(apiQuestion.correctAnswer);
  const incorrectAnswers = apiQuestion.incorrectAnswers.map(withId);
  const answers = shuffleAnswers(correctAnswer, incorrectAnswers);

  return {
    question: apiQuestion,
    correctAnswer,
    answers,
    timestamp: new Date(),
    responses: [],
  };
}

function snapshotQuestion(question: Question): QuestionSnapshot {
  return {
    question: structuredClone(question.question),
    answers: question.answers.map((answer) => ({ ...answer })),
    correctAnswerId: question.correctAnswer.id,
    startedAt: question.timestamp.getTime(),
    responses: question.responses.map((response) => ({
      userId: response.userId,
      answerId: response.answerId,
      at: response.timestamp.getTime(),
    })),
  };
}

const restoreQuestion = Effect.fnUntraced(function* (
  snapshot: QuestionSnapshot,
): Effect.fn.Return<Question, InvalidQuizSnapshotError> {
  const answers = snapshot.answers.map((answer) => ({ ...answer }));

  const correctAnswer = answers.find(
    (answer) => answer.id === snapshot.correctAnswerId,
  );

  if (!correctAnswer) {
    return yield* new InvalidQuizSnapshotError({
      message: `Snapshot question ${snapshot.question.id} has no correct answer`,
    });
  }

  return {
    question: structuredClone(snapshot.question),
    answers,
    correctAnswer,
    timestamp: new Date(snapshot.startedAt),
    responses: snapshot.responses.map((response) => ({
      userId: response.userId,
      answerId: response.answerId,
      timestamp: new Date(response.at),
    })),
  };
});

export function isCorrectAnswer(question: Question, answerId: string): boolean {
  return question.correctAnswer.id === answerId;
}

/** Leaderboard order: most points first, with the speed bonus breaking ties. */
export function compareRank(a: UserScore, b: UserScore): number {
  return b.score - a.score || b.speedBonus - a.speedBonus;
}

type Earned = { points: number; speedBonus: number };

const NOTHING_EARNED: Earned = { points: 0, speedBonus: 0 };

export function getRemainingTime(
  question: Question,
  timeoutSeconds: number = TIMEOUT_SECS,
): number {
  const elapsed = (Number(new Date()) - Number(question.timestamp)) / 1000;

  return Math.max(0, timeoutSeconds - elapsed);
}

export function hasExpired(
  question: Question,
  timeoutSeconds: number = TIMEOUT_SECS,
): boolean {
  return getRemainingTime(question, timeoutSeconds) <= 0;
}

export function getElapsedTime(
  question: Question,
  fromTimestamp?: Date,
): number {
  const referenceTime = fromTimestamp || new Date();

  return (Number(referenceTime) - Number(question.timestamp)) / 1000;
}

export class Quiz {
  private state: QuizState;
  private store: QuestionSource;
  private timeoutSecs: number;

  constructor(
    store: QuestionSource,
    maxQuestions: number = 3,
    timeoutSecs: number = TIMEOUT_SECS,
  ) {
    this.store = store;
    this.timeoutSecs = timeoutSecs;
    this.state = {
      users: new Set(),
      currentQuestion: null,
      questions: [],
      isActive: false,
      maxQuestions,
    };
  }

  /** The whole quiz as plain JSON, ready to be stored. */
  toSnapshot(): QuizSnapshot {
    const currentIndex = this.state.currentQuestion
      ? this.state.questions.indexOf(this.state.currentQuestion)
      : -1;

    return {
      version: QUIZ_SNAPSHOT_VERSION,
      maxQuestions: this.state.maxQuestions,
      timeoutSecs: this.timeoutSecs,
      isActive: this.state.isActive,
      currentQuestionIndex: currentIndex >= 0 ? currentIndex : null,
      questions: this.state.questions.map(snapshotQuestion),
      users: Array.from(this.state.users),
    };
  }

  /**
   * Rebuild a quiz from a stored snapshot. The rebuilt quiz shares nothing with
   * the snapshot, so mutating one never touches the other. Questions not yet
   * asked are not part of a snapshot: the caller supplies the question source
   * the rebuilt quiz draws the rest of its questions from.
   */
  static readonly fromSnapshot = Effect.fn("Quiz.fromSnapshot")(function* (
    snapshot: QuizSnapshot,
    store: QuestionSource,
  ): Effect.fn.Return<
    Quiz,
    UnsupportedSnapshotVersionError | InvalidQuizSnapshotError
  > {
    if (snapshot.version !== QUIZ_SNAPSHOT_VERSION && snapshot.version !== 1) {
      return yield* new UnsupportedSnapshotVersionError({
        version: snapshot.version,
      });
    }

    const quiz = new Quiz(store, snapshot.maxQuestions, snapshot.timeoutSecs);
    const questions = yield* Effect.forEach(snapshot.questions, restoreQuestion);
    const index = snapshot.currentQuestionIndex;

    if (index !== null && !questions[index]) {
      return yield* new InvalidQuizSnapshotError({
        message: `Quiz snapshot has no question at index ${index}`,
      });
    }

    const currentQuestion = index === null ? null : questions[index];

    quiz.state = {
      users: new Set(snapshot.users),
      currentQuestion,
      questions,
      isActive: snapshot.isActive,
      maxQuestions: snapshot.maxQuestions,
    };

    return quiz;
  });

  addUser(userId: string): void {
    this.state.users.add(userId);
  }

  removeUser(userId: string): void {
    this.state.users.delete(userId);
  }

  getUsers(): string[] {
    return Array.from(this.state.users);
  }

  readonly startQuiz = Effect.fn("Quiz.startQuiz")(function* (
    this: Quiz,
  ): Effect.fn.Return<Question, QuizCompleteError | QuestionsExhaustedError> {
    this.state.isActive = true;

    return yield* this.nextQuestion();
  });

  readonly nextQuestion = Effect.fn("Quiz.nextQuestion")(function* (
    this: Quiz,
  ): Effect.fn.Return<Question, QuizCompleteError | QuestionsExhaustedError> {
    if (this.isComplete()) {
      return yield* new QuizCompleteError();
    }

    const apiQuestion = this.store.get();

    if (Option.isNone(apiQuestion)) {
      return yield* new QuestionsExhaustedError();
    }

    const question = createQuestion(apiQuestion.value);
    this.state.currentQuestion = question;
    this.state.questions.push(question);

    return question;
  });

  private speedBonus(question: Question, answeredAt: Date): number {
    const elapsed = getElapsedTime(question, answeredAt);

    return Math.max(
      0,
      ((this.timeoutSecs - elapsed) / this.timeoutSecs) * SPEED_BONUS_MAX,
    );
  }

  /** What a response earns: a point and a speed bonus if correct, else nothing. */
  private earned(
    question: Question,
    response: Pick<Response, "answerId" | "timestamp">,
  ): Earned {
    return isCorrectAnswer(question, response.answerId)
      ? { points: 1, speedBonus: this.speedBonus(question, response.timestamp) }
      : NOTHING_EARNED;
  }

  /**
   * Record a user's answer. When `questionId` is given the answer is credited
   * to that question (Slack may deliver a click after the question has already
   * advanced); speed bonus floors at 0, so late answers score the base point.
   */
  readonly submitAnswer = Effect.fn("Quiz.submitAnswer")(function* (
    this: Quiz,
    userId: string,
    answerId: string,
    timestamp: Date,
    questionId?: string,
  ): Effect.fn.Return<boolean, NoActiveQuizError | QuestionNotFoundError> {
    if (!this.state.isActive) {
      return yield* new NoActiveQuizError();
    }

    const question = questionId
      ? this.state.questions.find((q) => q.question.id === questionId)
      : this.state.currentQuestion;

    if (!question) {
      return yield* new QuestionNotFoundError({ questionId });
    }

    const response: Response = { userId, answerId, timestamp };

    const existingIndex = question.responses.findIndex(
      (r) => r.userId === userId,
    );

    // Only a user's latest answer to a question counts.
    if (existingIndex >= 0) {
      question.responses[existingIndex] = response;
    } else {
      question.responses.push(response);
    }

    return isCorrectAnswer(question, answerId);
  });

  /** A user's per-question account of the quiz so far, in question order. */
  getRecap(userId: string): RecapQuestion[] {
    return this.state.questions.map((question) => {
      const response = question.responses.find((r) => r.userId === userId);
      const earned = response ? this.earned(question, response) : NOTHING_EARNED;

      return {
        text: question.question.question.text,
        options: question.answers.map((answer) => ({
          text: answer.text,
          selected: response?.answerId === answer.id,
          correct: isCorrectAnswer(question, answer.id),
        })),
        answered: !!response,
        points: earned.points,
        speedBonus: earned.speedBonus,
      };
    });
  }

  getCurrentQuestion(): Question | null {
    return this.state.currentQuestion;
  }

  getQuestions(): Question[] {
    return [...this.state.questions];
  }

  /**
   * Every participant's totals, summed from the answers that currently count.
   * Participants are the users who joined plus anyone who answered.
   */
  getUserScores(): UserScore[] {
    const scores = new Map<string, UserScore>();

    const scoreFor = (userId: string): UserScore => {
      let score = scores.get(userId);

      if (!score) {
        score = { userId, score: 0, speedBonus: 0, totalAnswered: 0 };
        scores.set(userId, score);
      }

      return score;
    };

    for (const userId of this.state.users) {
      scoreFor(userId);
    }

    for (const question of this.state.questions) {
      for (const response of question.responses) {
        const score = scoreFor(response.userId);
        const earned = this.earned(question, response);
        score.score += earned.points;
        score.speedBonus += earned.speedBonus;
        score.totalAnswered += 1;
      }
    }

    return Array.from(scores.values());
  }

  getUserScore(userId: string): UserScore | undefined {
    return this.getUserScores().find((score) => score.userId === userId);
  }

  isActive(): boolean {
    return this.state.isActive;
  }

  endQuiz(): void {
    this.state.isActive = false;
  }

  getTimeoutSecs(): number {
    return this.timeoutSecs;
  }

  getLeaderboard(): UserScore[] {
    return this.getUserScores().sort(compareRank);
  }

  isComplete(): boolean {
    return this.state.questions.length >= this.state.maxQuestions;
  }

  getMaxQuestions(): number {
    return this.state.maxQuestions;
  }

  getProgress(): QuizProgress {
    return {
      current: this.state.questions.length,
      total: this.state.maxQuestions,
    };
  }
}
