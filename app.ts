require("dotenv").config();

import { App } from "@slack/bolt";
import { TriviaStore, parseTs } from "./src/trivia-core";
import { SlackQuiz } from "./src/slack-quiz";

// Helper function to clean up finished channel quizzes
function cleanupChannelQuiz(channelId: string) {
  const quiz = CHANNEL_QUIZZES.get(channelId);
  if (quiz) {
    quiz.abort();
    CHANNEL_QUIZZES.delete(channelId);
  }
}

// Initializes your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const STORE = new TriviaStore();

let CURRENT_QUIZ: SlackQuiz;
const CHANNEL_QUIZZES = new Map<string, SlackQuiz>(); // channelId -> SlackQuiz

app.action("radio_sel", async ({ ack, body, logger, respond }) => {
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

    const userId = body.user.id;
    const channelId = body.channel?.id;
    const questionId = action.block_id;

    // Check if this is a channel quiz
    if (channelId) {
      const channelQuiz = CHANNEL_QUIZZES.get(channelId);
      if (channelQuiz) {
        try {
          channelQuiz.submitAnswer(
            userId,
            answer,
            parseTs(action.action_ts),
            questionId,
          );
        } catch (error) {
          logger.error("Error submitting channel answer:", error);
          await respond({
            response_type: "ephemeral",
            text: "Error submitting your answer. Please try again.",
          });
        }
        return;
      }

      await respond({
        response_type: "ephemeral",
        text: "No active quiz found in this channel.",
      });
      return;
    }

    // Home tab quiz (no channel ID) - just log errors, can't respond
    if (!CURRENT_QUIZ) {
      logger.info("No active quiz for home tab answer submission");
      return;
    }

    try {
      CURRENT_QUIZ.submitAnswer(
        userId,
        answer,
        parseTs(action.action_ts),
        questionId,
      );
    } catch (error) {
      logger.info(
        "Home tab answer submission failed - quiz likely ended:",
        error,
      );
    }
  } else {
    logger.error("Unrecognized event", body);
  }
});

app.command("/quizzo", async ({ command, ack, respond, client, logger }) => {
  await ack();
  
  logger.info("🎯 /quizzo command received!", {
    channel: command.channel_id,
    user: command.user_id,
    text: command.text,
  });

  try {
    const channelId = command.channel_id;

    if (CHANNEL_QUIZZES.has(channelId)) {
      await respond({
        response_type: "ephemeral",
        text: "A trivia quiz is already running in this channel! Please wait for it to finish.",
      });
      return;
    }

    const args = command.text.trim().split(/\s+/).filter(arg => arg.length > 0);
    
    let numQuestions = 3;
    let timeoutSecs = 5;

    if (args.length > 0) {
      const parsedQuestions = parseInt(args[0], 10);
      if (isNaN(parsedQuestions) || parsedQuestions < 1 || parsedQuestions > 20) {
        await respond({
          response_type: "ephemeral",
          text: "Invalid number of questions. Please provide a number between 1 and 20.\nUsage: `/quizzo [num_questions] [seconds]s`\nExample: `/quizzo 5 10s`",
        });
        return;
      }
      numQuestions = parsedQuestions;
    }

    if (args.length > 1) {
      const timeArg = args[1];
      if (!timeArg.endsWith('s')) {
        await respond({
          response_type: "ephemeral",
          text: "Invalid time format. Seconds must be suffixed with 's'.\nUsage: `/quizzo [num_questions] [seconds]s`\nExample: `/quizzo 5 10s`",
        });
        return;
      }
      const parsedSeconds = parseInt(timeArg.slice(0, -1), 10);
      if (isNaN(parsedSeconds) || parsedSeconds < 1 || parsedSeconds > 60) {
        await respond({
          response_type: "ephemeral",
          text: "Invalid timeout. Please provide seconds between 1 and 60.\nUsage: `/quizzo [num_questions] [seconds]s`\nExample: `/quizzo 5 10s`",
        });
        return;
      }
      timeoutSecs = parsedSeconds;
    }

    const channelQuiz = new SlackQuiz(client, logger, STORE, channelId, () => {
      cleanupChannelQuiz(channelId);
    }, numQuestions, timeoutSecs);
    CHANNEL_QUIZZES.set(channelId, channelQuiz);

    await channelQuiz.startChannelQuiz(command.user_id);
  } catch (error) {
    logger.error("Error starting channel quiz:", error);
    await respond({
      response_type: "ephemeral",
      text: "Sorry, there was an error starting the trivia quiz. Please try again.",
    });
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
  // Start your app (Socket Mode - no port needed)
  await app.start();

  app.logger.info(`⚡️ Bolt app is running in Socket Mode!`);
  app.logger.info(
    `📝 Registered handlers: slash command /quizzo, event app_home_opened, action radio_sel`,
  );
})();
