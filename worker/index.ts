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

    app.action<"radio_buttons">(
      { type: "radio_buttons", action_id: "radio_sel" },
      // The answer is recorded in the ack handler, not a lazy one: the object's
      // output gate holds this RPC's return until the write commits, so Slack
      // cannot confirm a click whose answer was never stored.
      async ({ payload }) => {
        const action = payload.actions[0];
        const answerId = action?.selected_option?.value;
        // A click on the channel message carries its channel; anything else
        // (a click in a view) has no quiz to belong to.
        const channelId = "channel" in payload ? payload.channel?.id : undefined;
        if (!answerId || !channelId) return "";

        const channel = env.CHANNEL_OBJECT.get(
          env.CHANNEL_OBJECT.idFromName(channelId),
        );
        await channel.submitAnswer(
          payload.user.id,
          answerId,
          action.block_id,
          // Slack's click time, not ours: the speed bonus must not be charged
          // for delivery lag.
          Number(action.action_ts) * 1000,
        );
        return "";
      },
    );

    return await app.run(request, ctx);
  },
};
