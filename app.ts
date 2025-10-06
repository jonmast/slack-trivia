require("dotenv").config();

import { App, Logger } from "@slack/bolt";
import { WebClient, HomeView } from "@slack/web-api";
import {
  TriviaStore,
  Quiz,
  createQuestion,
  parseTs,
  TIMEOUT_SECS,
  getRemainingTime,
  hasExpired,
  type Question,
  type Answer,
  type Response,
  type UserScore
} from "./src/trivia-core";

// Initializes your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const STORE = new TriviaStore();

class SlackQuiz {
  private quiz: Quiz
  private tick: NodeJS.Timeout
  private cachedRender: string | undefined
  private state:
    | { type: "initial" }
    | {
        type: "question"
        question: Question
        viewId: string
      }
    | {
        type: "results"
        question: Question
        viewId: string
      }

  constructor(
    private client: WebClient,
    private logger: Logger,
  ) {
    this.quiz = new Quiz(STORE)
    this.state = { type: "initial" }
    // Listed rate is "100+", with burst
    this.tick = setInterval(() => {
      this.updateView()
    }, 100)
  }

  async initialize(user: string): Promise<void> {
    this.quiz.addUser(user)
    const question = this.quiz.startQuiz()

    const view = await this.client.views.publish({
      user_id: user,
      view: renderQuestion(question, 30),
    })

    if (view.ok) {
      if (!view.view?.id) {
        throw new Error("No view returned")
      }

      this.state = {
        type: "question",
        question,
        viewId: view.view.id,
      }
    } else {
      // TODO: real error handling
      console.error(view.error)
    }
  }

  async advance() {
    const question = this.quiz.nextQuestion()

    if (this.state.type !== "question" && this.state.type !== "results") {
      throw new Error("Cannot advance from non-question state")
    }

    this.state = {
      type: "question",
      question: question,
      viewId: this.state.viewId,
    }
  }

  updateView(): void {
    if (this.state.type === "initial") {
      console.log("pending initialization")
    } else if (this.state.type === "question") {
      const remaining = getRemainingTime(this.state.question, TIMEOUT_SECS)
      if (remaining <= 0) {
        this.state = {
          type: "results",
          question: this.state.question,
          viewId: this.state.viewId,
        }
        return this.updateView()
      }

      const rendered = renderQuestion(this.state.question, remaining)
      const json = JSON.stringify(rendered)

      if (json === this.cachedRender) {
        this.logger.debug("No change in view")
      } else {
        this.cachedRender = json
        this.client.views.update({
          view: rendered,
          view_id: this.state.viewId,
        })
      }
    } else if (this.state.type === "results") {
      const elapsed =
        (Number(new Date()) - Number(this.state.question.timestamp)) / 1000
      if (elapsed - TIMEOUT_SECS > 5) {
        this.advance()
        return
      } else {
        const userScores = this.quiz.getUserScores()
        this.client.views.update({
          view: renderResults(this.state.question, userScores),
          view_id: this.state.viewId,
        })
      }
      this.logger.info("Results")
    } else {
      throw new Error("Invalid state")
    }
  }

  abort() {
    clearInterval(this.tick)
    this.quiz.endQuiz()
  }

  submitAnswer(userId: string, answerId: string, timestamp: Date) {
    if (this.state.type !== "question") {
      throw new Error("Cannot submit answer from non-question state")
    }

    this.quiz.addUser(userId) // Ensure user is added to quiz
    return this.quiz.submitAnswer(userId, answerId, timestamp)
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
