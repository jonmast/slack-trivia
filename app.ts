require("dotenv").config();

import { App, Logger } from "@slack/bolt";
import { WebClient, HomeView } from "@slack/web-api";
import crypto from "node:crypto";

// Initializes your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

type TriviaQuestion = {
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

class TriviaStore {
  private cache: TriviaQuestion[];

  constructor() {
    this.cache = [];
    fetch("https://the-trivia-api.com/v2/questions").then((response) => {
      response.json().then((data) => (this.cache = this.cache.concat(data)));
    });
  }

  private async fetchMore() {
    const response = await fetch(
      "https://the-trivia-api.com/v2/questions?limit=10",
    );
    const data = await response.json();
    this.cache = this.cache.concat(data);
  }

  get(): TriviaQuestion {
    if (this.cache.length < 3) {
      this.fetchMore();
    }
    return this.cache.pop()!;
  }
}

const STORE = new TriviaStore();

function parseTs(ts: string): Date {
  return new Date(Number(ts) * 1000);
}

type Response = {
  userId: string;
  answerId: string;
  timestamp: Date;
};

type Answer = {
  id: string;
  text: string;
};

type Question = {
  question: TriviaQuestion;
  answers: Answer[];
  correctAnswer: Answer;
  responses: Response[];
  timestamp: Date;
};

const TIMEOUT_SECS = 15;

class Quiz {
  private questions: Question[] = [];
  private tick: NodeJS.Timeout;
  private cachedRender: string | undefined;
  private state:
    | { type: "initial" }
    | {
        type: "question";
        question: Question;
        viewId: string;
      }
    | {
        type: "results";
        question: Question;
        viewId: string;
      };

  constructor(
    private client: WebClient,
    private logger: Logger,
  ) {
    this.state = { type: "initial" };
    // Listed rate is "100+", with burst
    this.tick = setInterval(() => {
      this.updateView();
    }, 100);
  }

  async initialize(user: string): Promise<void> {
    const question = this.loadQuestion();

    const view = await this.client.views.publish({
      user_id: user,
      view: renderQuestion(question, 30),
    });

    if (view.ok) {
      if (!view.view?.id) {
        throw new Error("No view returned");
      }

      this.state = {
        type: "question",
        question,
        viewId: view.view.id,
      };
    } else {
      // TODO: real error handling
      console.error(view.error);
    }
  }

  async advance() {
    const question = this.loadQuestion();

    if (this.state.type !== "question" && this.state.type !== "results") {
      throw new Error("Cannot advance from non-question state");
    }

    this.state = {
      type: "question",
      question: question,
      viewId: this.state.viewId,
    };
  }

  loadQuestion(): Question {
    const apiQuestion = STORE.get();
    const correctAnswer = withId(apiQuestion.correctAnswer);
    const answers = [
      correctAnswer,
      ...apiQuestion.incorrectAnswers.map(withId),
    ].sort(() => Math.random() - 0.5);

    const question = {
      question: apiQuestion,
      correctAnswer,
      answers,
      timestamp: new Date(),
      responses: [],
    };
    this.questions.push(question);

    return question;
  }

  updateView(): void {
    if (this.state.type === "initial") {
      console.log("pending initialization");
    } else if (this.state.type === "question") {
      let remaining =
        TIMEOUT_SECS -
        (Number(new Date()) - Number(this.state.question.timestamp)) / 1000;
      if (remaining <= 0) {
        this.state = {
          type: "results",
          question: this.state.question,
          viewId: this.state.viewId,
        };
        return this.updateView();
        // this.advance();
        // remaining = TIMEOUT_SECS;
      }

      const rendered = renderQuestion(this.state.question, remaining);
      const json = JSON.stringify(rendered);

      if (json === this.cachedRender) {
        this.logger.debug("No change in view");
      } else {
        this.cachedRender = json;
        this.client.views.update({
          view: rendered,
          view_id: this.state.viewId,
        });
      }
    } else if (this.state.type === "results") {
      const elapsed =
        (Number(new Date()) - Number(this.state.question.timestamp)) / 1000;
      if (elapsed - TIMEOUT_SECS > 5) {
        this.advance();
        return;
      } else {
        this.client.views.update({
          view: {
            type: "home",
            blocks: [
              {
                type: "section",
                text: {
                  type: "plain_text",
                  text: `Results\nCorrect: ${this.state.question.correctAnswer.id} - ${this.state.question.correctAnswer.text}\n\n${this.state.question.responses.map((r) => r.answerId).join("\n")}`,
                },
              },
            ],
          },
          view_id: this.state.viewId,
        });
      }
      this.logger.info("Results");
    } else {
      throw new Error("Invalid state");
    }
  }

  abort() {
    clearInterval(this.tick);
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date) {
    if (this.state.type !== "question") {
      throw new Error("Cannot submit answer from non-question state");
    }

    this.state.question.responses.push({
      userId,
      answerId,
      timestamp,
    });
  }
}

function renderQuestion(question: Question, countdown: number): HomeView {
  return {
    type: "home",
    blocks: [
      {
        block_id: question.question.id,
        type: "section",
        text: {
          type: "plain_text",
          text: `${question.question.question.text}\n ${countdown.toFixed(0)}`,
        },
        accessory: {
          type: "radio_buttons",
          action_id: "radio_sel",
          options: question.answers.map((answer) => ({
            value: answer.id,
            text: {
              type: "plain_text",
              text: answer.text.substring(0, 150),
            },
          })),
        },
      },
    ],
  };
}

function renderResults(question: Question): HomeView {
  return {
    type: "home",
    blocks: [
      {
        block_id: question.question.id,
        type: "section",
        text: {
          type: "plain_text",
          text: `${question.question.question.text}\n${question.correctAnswer.text}`,
        },
        accessory: {
          type: "radio_buttons",
          action_id: "radio_sel",
          options: question.answers.map((answer) => ({
            value: answer.id,
            text: {
              type: "plain_text",
              text: answer.text.substring(0, 150),
            },
          })),
        },
      },
    ],
  };
}

function withId(text: string): Answer {
  return {
    id: crypto.randomUUID(),
    text,
  };
}

let CURRENT_QUIZ: Quiz;

app.action("radio_sel", async ({ ack, body, logger }) => {
  if (body.type === "block_actions") {
    await ack();
    const action = body.actions[0]!;
    if (action.type !== "radio_buttons") {
      throw new Error("Unexpected action type");
    }
    const answer = action.selected_option?.value;

    if (!answer) {
      throw new Error("No answer selected");
    }

    CURRENT_QUIZ.submitAnswer(body.user.id, answer, parseTs(action.action_ts));
  } else {
    logger.error("Unrecognized event", body);
  }
});

app.event("app_home_opened", async ({ event, client, logger }) => {
  try {
    if (CURRENT_QUIZ) {
      CURRENT_QUIZ.abort();
    }
    CURRENT_QUIZ = new Quiz(client, logger);
    await CURRENT_QUIZ.initialize(event.user);
    // const question = STORE.get();
    // const answers = [question.correctAnswer, ...question.incorrectAnswers].sort(
    //   () => Math.random() - 0.5,
    // );

    // const init = Number(new Date()) + 30_000;

    // const interval = setInterval(() => {
    //   const remaining = init - Number(new Date());

    //   if (remaining < 1_000) {
    //     clearInterval(interval);
    //     return;
    //   }

    //   client.views.update({
    //     view: render(remaining / 1000).view,
    //     view_id: result.view?.id!,
    //   });
    // }, 1000);

    // logger.info(result);
  } catch (error) {
    logger.error(error);
  }
});

(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);

  app.logger.info("⚡️ Bolt app is running!");
})();
