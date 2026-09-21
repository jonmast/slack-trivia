import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "./env";

export { ChannelObject } from "./channel-object";

export const SLACK_EVENTS_PATH = "/slack/events";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const origin = new URL(request.url).origin;
    const app = new SlackApp({
      env,
      routes: { events: SLACK_EVENTS_PATH },
    }).command(
      "/quizzo",
      // Ack within Slack's 3 seconds; the reply comes back on response_url.
      async () => "",
      async ({ context, payload }) => {
        const channelId = payload.channel_id;
        const channel = env.CHANNEL_OBJECT.get(
          env.CHANNEL_OBJECT.idFromName(channelId),
        );
        try {
          const result = await channel.startQuiz(
            channelId,
            payload.text ?? "",
            origin,
            env.SLACK_BOT_TOKEN ?? "",
          );
          // On success the question is already posted in the channel;
          // only send an ephemeral for errors so users aren't double-pinged.
          if (!result.ok) {
            await context.respond({
              response_type: "ephemeral",
              text: result.text,
            });
          }
        } catch (error) {
          const text =
            error instanceof Error
              ? error.message
              : "An unexpected error occurred. Please try again.";
          await context.respond({
            response_type: "ephemeral",
            text,
          });
        }
      },
    );

    return await app.run(request, ctx);
  },
};
