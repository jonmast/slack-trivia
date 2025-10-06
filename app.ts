require("dotenv").config();

import { App } from "@slack/bolt";
import { TriviaStore, parseTs } from "./src/trivia-core";
import { SlackQuiz } from "./src/slack-quiz";

// Initializes your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const STORE = new TriviaStore();

let CURRENT_QUIZ: SlackQuiz;

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
    CURRENT_QUIZ = new SlackQuiz(client, logger, STORE);
    await CURRENT_QUIZ.initialize(event.user);
  } catch (error) {
    logger.error(error);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  // Start your app
  await app.start(port);

  app.logger.info(`⚡️ Bolt app is running on ${port}!`);
})();
