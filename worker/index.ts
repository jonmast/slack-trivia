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
        const result = await channel.startQuiz(channelId, payload.text ?? "");
        await context.respond({
          response_type: "ephemeral",
          text: result.text,
        });
      },
    );

    return await app.run(request, ctx);
  },
};
