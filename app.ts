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
          const success = channelQuiz.submitAnswer(userId, answer, parseTs(action.action_ts), questionId);
          
          if (success === false) {
            await respond({
              response_type: "ephemeral",
              text: "You've already answered this question!",
            });
          } else {
            await respond({
              response_type: "ephemeral",
              text: "Answer submitted! ✅",
            });
          }
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
      CURRENT_QUIZ.submitAnswer(userId, answer, parseTs(action.action_ts), questionId);
    } catch (error) {
      logger.info("Home tab answer submission failed - quiz likely ended:", error);
    }
  } else {
    logger.error("Unrecognized event", body);
  }
});

app.command("/quizzo", async ({ command, ack, respond, client, logger }) => {
  await ack();
  
  try {
    const channelId = command.channel_id;
    
    // Check if there's already a quiz running in this channel
    if (CHANNEL_QUIZZES.has(channelId)) {
      await respond({
        response_type: "ephemeral",
        text: "A trivia quiz is already running in this channel! Please wait for it to finish.",
      });
      return;
    }
    
    // Create new channel quiz with cleanup callback
    const channelQuiz = new SlackQuiz(client, logger, STORE, channelId, () => {
      cleanupChannelQuiz(channelId);
    });
    CHANNEL_QUIZZES.set(channelId, channelQuiz);
    
    // Start the quiz
    await channelQuiz.startChannelQuiz(command.user_id);
    
    await respond({
      response_type: "in_channel",
      text: `🧠 Trivia quiz started by <@${command.user_id}>! Get ready for the first question...`,
    });
    
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
  const port = process.env.PORT || 3000;
  // Start your app
  await app.start(port);

  app.logger.info(`⚡️ Bolt app is running on ${port}!`);
})();
