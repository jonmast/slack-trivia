require("dotenv").config();

import { App } from "@slack/bolt";
import { TriviaStore, parseTs, parseQuizzoArgs } from "./src/trivia-core";
import { SlackQuiz } from "./src/slack-quiz";
import { COUNTDOWN_ROUTE_PATH, countdownRouteHandler } from "./src/countdown";

// Socket Mode is the default whenever an app-level token is configured (local
// dev). Set SLACK_SOCKET_MODE=false to force HTTP mode (e.g. Docker).
const isSocketMode =
  process.env.SLACK_SOCKET_MODE !== undefined
    ? process.env.SLACK_SOCKET_MODE === "true"
    : !!process.env.SLACK_APP_TOKEN;
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
// Public base URL of this app (e.g. https://trivia.example.com). Channel
// questions embed an animated countdown served from /countdown/:secs.gif and
// Slack fetches it while posting, so this must be reachable from the internet.
// Required for /quizzo; the Home tab quiz works without it.
const countdownBaseUrl = process.env.COUNTDOWN_BASE_URL || undefined;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(isSocketMode
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { port }),
  // Served in both modes (SocketModeReceiver opens an HTTP listener for custom routes).
  customRoutes: [
    { path: COUNTDOWN_ROUTE_PATH, method: ["GET", "HEAD"], handler: countdownRouteHandler },
  ],
});

const STORE = new TriviaStore();

// One shared Home-tab quiz; everyone who opens the Home tab joins it.
let HOME_QUIZ: SlackQuiz | undefined;
// One quiz per channel.
const CHANNEL_QUIZZES = new Map<string, SlackQuiz>();

function cleanupChannelQuiz(channelId: string) {
  const quiz = CHANNEL_QUIZZES.get(channelId);
  if (quiz) {
    CHANNEL_QUIZZES.delete(channelId);
    quiz.abort();
  }
}

app.action("radio_sel", async ({ ack, body, logger }) => {
  await ack();
  if (body.type !== "block_actions") {
    logger.error("Unrecognized event", body);
    return;
  }

  const action = body.actions[0]!;
  if (action.type !== "radio_buttons") {
    logger.error("Unexpected action type", action.type);
    return;
  }
  const answer = action.selected_option?.value;
  if (!answer) {
    return;
  }

  const userId = body.user.id;
  const channelId = body.channel?.id;
  const questionId = action.block_id;
  const answeredAt = parseTs(action.action_ts);

  // Channel quiz: block_actions from a message carry the channel.
  if (channelId) {
    const channelQuiz = CHANNEL_QUIZZES.get(channelId);
    if (!channelQuiz || channelQuiz.isFinished()) {
      logger.info(`Answer from ${userId} in ${channelId} but no active quiz`);
      return;
    }

    try {
      const correct = channelQuiz.submitAnswer(
        userId,
        answer,
        answeredAt,
        questionId,
      );
      logger.info(`Answer from ${userId} in ${channelId}: ${correct ? "correct" : "wrong"}`);
    } catch (error) {
      logger.error("Error submitting channel answer:", error);
    }
    return;
  }

  // Home tab quiz: no channel and no response_url to talk back on.
  if (!HOME_QUIZ || HOME_QUIZ.isFinished()) {
    logger.info("No active home quiz for answer submission");
    return;
  }
  try {
    const correct = HOME_QUIZ.submitAnswer(userId, answer, answeredAt, questionId);
    logger.info(`Home answer from ${userId}: ${correct ? "correct" : "wrong"}`);
  } catch (error) {
    logger.error("Home tab answer submission failed:", error);
  }
});

app.command("/quizzo", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const channelId = command.channel_id;
  logger.info("/quizzo", { channel: channelId, user: command.user_id, text: command.text });

  if (!countdownBaseUrl) {
    await respond({
      response_type: "ephemeral",
      text: "Channel trivia isn't configured on this server (COUNTDOWN_BASE_URL is unset).",
    });
    return;
  }

  const existing = CHANNEL_QUIZZES.get(channelId);
  if (existing && !existing.isFinished()) {
    await respond({
      response_type: "ephemeral",
      text: "A trivia quiz is already running in this channel! Please wait for it to finish.",
    });
    return;
  }

  const parsed = parseQuizzoArgs(command.text);
  if (!parsed.ok) {
    await respond({ response_type: "ephemeral", text: parsed.error });
    return;
  }
  const { numQuestions, timeoutSecs } = parsed.args;

  const channelQuiz = new SlackQuiz(
    client,
    logger,
    STORE,
    channelId,
    () => {
      // Only clear the map entry if it's still this quiz.
      if (CHANNEL_QUIZZES.get(channelId) === channelQuiz) {
        CHANNEL_QUIZZES.delete(channelId);
      }
    },
    numQuestions,
    timeoutSecs,
    countdownBaseUrl,
  );
  CHANNEL_QUIZZES.set(channelId, channelQuiz);

  try {
    await channelQuiz.startChannelQuiz(command.user_id);
  } catch (error) {
    logger.error("Error starting channel quiz:", error);
    // Don't leave the channel locked with a quiz that never started.
    cleanupChannelQuiz(channelId);
    const detail = error instanceof Error ? error.message : "";
    await respond({
      response_type: "ephemeral",
      text: `Sorry, there was an error starting the trivia quiz. ${detail}`.trim(),
    });
  }
});

app.event("app_home_opened", async ({ event, client, logger }) => {
  // Fires for the Messages tab too; only the Home tab hosts the quiz.
  if (event.tab !== "home") {
    return;
  }
  logger.info("app_home_opened", { user: event.user });
  try {
    if (!HOME_QUIZ || HOME_QUIZ.isFinished()) {
      HOME_QUIZ = new SlackQuiz(client, logger, STORE);
    }
    await HOME_QUIZ.initialize(event.user);
  } catch (error) {
    logger.error("Failed to initialize home quiz:", error);
  }
});

(async () => {
  await app.start();

  app.logger.info(
    isSocketMode
      ? "⚡️ Bolt app is running in Socket Mode!"
      : `⚡️ Bolt app is running in HTTP mode on port ${port}!`,
  );
  app.logger.info(
    "📝 Registered handlers: slash command /quizzo, event app_home_opened, action radio_sel",
  );
  app.logger.info(
    countdownBaseUrl
      ? `⏱ Countdown GIFs served at ${countdownBaseUrl}/countdown/:secs.gif`
      : "⚠️ COUNTDOWN_BASE_URL unset; /quizzo is disabled until it is",
  );
})();
