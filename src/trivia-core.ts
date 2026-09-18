import crypto from "node:crypto";

export type TriviaQuestion = {
  category: string;
  id: string;
  correctAnswer: string;
  incorrectAnswers: [string, string, string];
  question: {
    text: string;
  };
  tags: string[];
  type: "text_choice";
  difficulty: "easy" | "medium" | "hard";
  regions: string[];
  isNiche: boolean;
};

export type Answer = {
  id: string;
  text: string;
};

export type Response = {
  userId: string;
  answerId: string;
  timestamp: Date;
};

export type UserScore = {
  userId: string;
  score: number;
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
};

export class QuizCompleteError extends Error {
  constructor() {
    super("Quiz has reached the maximum number of questions");
    this.name = "QuizCompleteError";
  }
}

export type QuizState = {
  users: Set<string>;
  userScores: Map<string, UserScore>;
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

export const TIMEOUT_SECS = 5;
export const SPEED_BONUS_MAX = 0.2;
export const MAX_QUESTIONS = 20;
export const MAX_TIMEOUT_SECS = 60;
const TRIVIA_API_BASE_URL = "https://the-trivia-api.com/v2/questions";
const TRIVIA_API_MAX_LIMIT = 50;

async function fetchTriviaQuestions(limit?: number): Promise<TriviaQuestion[]> {
  try {
    const url = limit
      ? `${TRIVIA_API_BASE_URL}?limit=${Math.min(limit, TRIVIA_API_MAX_LIMIT)}`
      : TRIVIA_API_BASE_URL;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Failed to fetch trivia questions:", error);
    return [];
  }
}

export type QuizzoArgs = { numQuestions: number; timeoutSecs: number };

export const QUIZZO_USAGE =
  "Usage: `/quizzo [num_questions] [seconds]s`\nExample: `/quizzo 5 10s`";

/**
 * Parse `/quizzo [num_questions] [seconds]s` text. Returns an error string on
 * invalid input so the caller can respond ephemerally.
 */
export function parseQuizzoArgs(
  text: string,
): { ok: true; args: QuizzoArgs } | { ok: false; error: string } {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const args: QuizzoArgs = { numQuestions: 3, timeoutSecs: TIMEOUT_SECS };

  if (parts.length > 0) {
    const n = Number(parts[0]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUESTIONS) {
      return {
        ok: false,
        error: `Invalid number of questions. Please provide a number between 1 and ${MAX_QUESTIONS}.\n${QUIZZO_USAGE}`,
      };
    }
    args.numQuestions = n;
  }

  if (parts.length > 1) {
    const match = /^(\d+)s$/.exec(parts[1]);
    const secs = match ? Number(match[1]) : NaN;
    if (!match) {
      return {
        ok: false,
        error: `Invalid time format. Seconds must be suffixed with 's'.\n${QUIZZO_USAGE}`,
      };
    }
    if (secs < 1 || secs > MAX_TIMEOUT_SECS) {
      return {
        ok: false,
        error: `Invalid timeout. Please provide seconds between 1 and ${MAX_TIMEOUT_SECS}.\n${QUIZZO_USAGE}`,
      };
    }
    args.timeoutSecs = secs;
  }

  return { ok: true, args };
}

export function parseTs(ts: string): Date {
  return new Date(Number(ts) * 1000);
}

export function withId(text: string): Answer {
  return {
    id: crypto.randomUUID(),
    text,
  };
}

export class TriviaStore {
  private cache: TriviaQuestion[] = [];
  private inflight: Promise<void> | null = null;

  constructor() {
    this.fetchInitial();
  }

  private async fetchInitial() {
    const questions = await fetchTriviaQuestions();
    this.cache = this.cache.concat(questions);
  }

  /** Fetch more questions; concurrent calls share one in-flight request. */
  private fetchMore(limit: number = 10): Promise<void> {
    if (!this.inflight) {
      this.inflight = fetchTriviaQuestions(limit)
        .then((questions) => {
          this.cache = this.cache.concat(questions);
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /**
   * Make sure at least `count` questions are cached before a quiz starts, so a
   * quiz never dies mid-way with an empty cache. Resolves false if the API
   * couldn't supply enough questions.
   */
  async ensure(count: number): Promise<boolean> {
    if (this.cache.length >= count) return true;
    await this.fetchMore(Math.max(10, count - this.cache.length));
    if (this.cache.length >= count) return true;
    // One retry in case the first fetch was the constructor's initial fetch racing us.
    await this.fetchMore(Math.max(10, count - this.cache.length));
    return this.cache.length >= count;
  }

  get(): TriviaQuestion {
    if (this.cache.length < 3) {
      this.fetchMore().catch(() => {});
    }
    const question = this.cache.pop();
    if (!question) {
      throw new Error("No questions available");
    }
    return question;
  }

  getCacheSize(): number {
    return this.cache.length;
  }

  addToCache(questions: TriviaQuestion[]): void {
    this.cache = this.cache.concat(questions);
  }
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

export function isCorrectAnswer(question: Question, answerId: string): boolean {
  return question.correctAnswer.id === answerId;
}

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
  private store: TriviaStore;
  private timeoutSecs: number;

  constructor(
    store: TriviaStore,
    maxQuestions: number = 3,
    timeoutSecs: number = TIMEOUT_SECS,
  ) {
    this.store = store;
    this.timeoutSecs = timeoutSecs;
    this.state = {
      users: new Set(),
      userScores: new Map(),
      currentQuestion: null,
      questions: [],
      isActive: false,
      maxQuestions,
    };
  }

  addUser(userId: string): void {
    this.state.users.add(userId);
    if (!this.state.userScores.has(userId)) {
      this.state.userScores.set(userId, {
        userId,
        score: 0,
        totalAnswered: 0,
      });
    }
  }

  removeUser(userId: string): void {
    this.state.users.delete(userId);
  }

  getUsers(): string[] {
    return Array.from(this.state.users);
  }

  startQuiz(): Question {
    this.state.isActive = true;
    return this.nextQuestion();
  }

  nextQuestion(): Question {
    if (this.state.questions.length >= this.state.maxQuestions) {
      throw new QuizCompleteError();
    }

    const apiQuestion = this.store.get();
    const question = createQuestion(apiQuestion);
    this.state.currentQuestion = question;
    this.state.questions.push(question);

    return question;
  }

  private speedBonus(question: Question, answeredAt: Date): number {
    const elapsed = getElapsedTime(question, answeredAt);
    return Math.max(
      0,
      ((this.timeoutSecs - elapsed) / this.timeoutSecs) * SPEED_BONUS_MAX,
    );
  }

  /** Points a response earns: base point plus speed bonus if correct, else 0. */
  private pointsFor(
    question: Question,
    response: Pick<Response, "answerId" | "timestamp">,
  ): number {
    return isCorrectAnswer(question, response.answerId)
      ? 1 + this.speedBonus(question, response.timestamp)
      : 0;
  }

  /**
   * Record a user's answer. When `questionId` is given the answer is credited
   * to that question (Slack may deliver a click after the question has already
   * advanced); speed bonus floors at 0, so late answers score the base point.
   */
  submitAnswer(
    userId: string,
    answerId: string,
    timestamp: Date,
    questionId?: string,
  ): boolean {
    if (!this.state.isActive) {
      throw new Error("No active quiz");
    }

    const question = questionId
      ? this.state.questions.find((q) => q.question.id === questionId)
      : this.state.currentQuestion;

    if (!question) {
      throw new Error("Question not found");
    }

    const existingResponseIndex = question.responses.findIndex(
      (r) => r.userId === userId,
    );
    const existingResponse =
      existingResponseIndex >= 0
        ? question.responses[existingResponseIndex]
        : null;

    const userScore = this.state.userScores.get(userId);

    const response: Response = { userId, answerId, timestamp };

    if (existingResponse && userScore) {
      // Changing an answer: refund whatever the previous answer earned.
      userScore.score -= this.pointsFor(question, existingResponse);
      question.responses[existingResponseIndex] = response;
    } else {
      question.responses.push(response);
    }

    const previous = this.state.userScores.get(userId);
    this.state.userScores.set(userId, {
      userId,
      score: (previous?.score ?? 0) + this.pointsFor(question, response),
      totalAnswered: (previous?.totalAnswered ?? 0) + (existingResponse ? 0 : 1),
    });
    return isCorrectAnswer(question, answerId);
  }

  /** A user's per-question account of the quiz so far, in question order. */
  getRecap(userId: string): RecapQuestion[] {
    return this.state.questions.map((question) => {
      const response = question.responses.find((r) => r.userId === userId);
      return {
        text: question.question.question.text,
        options: question.answers.map((answer) => ({
          text: answer.text,
          selected: response?.answerId === answer.id,
          correct: isCorrectAnswer(question, answer.id),
        })),
        answered: !!response,
        points: response ? this.pointsFor(question, response) : 0,
      };
    });
  }

  getCurrentQuestion(): Question | null {
    return this.state.currentQuestion;
  }

  getQuestions(): Question[] {
    return [...this.state.questions];
  }

  getUserScores(): UserScore[] {
    return Array.from(this.state.userScores.values());
  }

  getUserScore(userId: string): UserScore | undefined {
    return this.state.userScores.get(userId);
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
    return this.getUserScores().sort((a, b) => b.score - a.score);
  }

  isComplete(): boolean {
    return this.state.questions.length >= this.state.maxQuestions;
  }

  getMaxQuestions(): number {
    return this.state.maxQuestions;
  }

  getProgress(): { current: number; total: number } {
    return {
      current: this.state.questions.length,
      total: this.state.maxQuestions,
    };
  }
}
