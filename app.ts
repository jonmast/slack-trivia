require("dotenv").config();

import { App } from "@slack/bolt";
import { TriviaStore, parseTs, parseQuizzoArgs } from "./src/trivia-core";
import { SlackQuiz } from "./src/slack-quiz";
import { ChannelQuizzes } from "./src/channel-quizzes";
import { renderRecapModal } from "./src/slack-ui";

// Socket Mode is the default whenever an app-level token is configured (local
// dev). Set SLACK_SOCKET_MODE=false to force HTTP mode (e.g. Docker).
const isSocketMode =
  process.env.SLACK_SOCKET_MODE !== undefined
    ? process.env.SLACK_SOCKET_MODE === "true"
    : !!process.env.SLACK_APP_TOKEN;
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(isSocketMode
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { port }),
});

const STORE = new TriviaStore();

const CHANNEL_QUIZZES = new ChannelQuizzes();

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
  if (!channelId) {
    logger.info(`Answer from ${userId} outside a channel; ignoring`);
    return;
  }

  const channelQuiz = CHANNEL_QUIZZES.running(channelId);
  if (!channelQuiz) {
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
});

app.action("recap", async ({ ack, body, client, respond, logger }) => {
  await ack();
  if (body.type !== "block_actions") {
    logger.error("Unrecognized event", body);
    return;
  }

  const action = body.actions[0]!;
  if (action.type !== "button") {
    logger.error("Unexpected action type", action.type);
    return;
  }

  const messageTs = action.value;
  const channelId = body.channel?.id;
  const quiz =
    channelId && messageTs ? CHANNEL_QUIZZES.finished(channelId, messageTs) : undefined;
  if (!quiz) {
    await respond({
      response_type: "ephemeral",
      text: "That quiz's recap is no longer available.",
    });
    return;
  }

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: renderRecapModal(quiz.getRecap(body.user.id)),
    });
  } catch (error) {
    logger.error("Failed to open recap:", error);
  }
});

app.command("/quizzo", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const channelId = command.channel_id;
  logger.info("/quizzo", { channel: channelId, user: command.user_id, text: command.text });

  if (CHANNEL_QUIZZES.running(channelId)) {
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
    // No onQuizEnd eviction: the finished quiz must stay in CHANNEL_QUIZZES
    // so the final summary's Recap button can read it (see ChannelQuizzes).
    undefined,
    numQuestions,
    timeoutSecs,
  );
  CHANNEL_QUIZZES.replace(channelId, channelQuiz);

  try {
    await channelQuiz.startChannelQuiz(command.user_id);
  } catch (error) {
    logger.error("Error starting channel quiz:", error);
    // Don't leave the channel locked with a quiz that never started.
    CHANNEL_QUIZZES.discard(channelId, channelQuiz);
    channelQuiz.abort();
    const detail = error instanceof Error ? error.message : "";
    await respond({
      response_type: "ephemeral",
      text: `Sorry, there was an error starting the trivia quiz. ${detail}`.trim(),
    });
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
    "📝 Registered handlers: slash command /quizzo, actions radio_sel, recap",
  );
  app.logger.info("⏱ Countdown GIFs are pre-rendered and served by the Worker deployment.");
})();
