import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "./env";
import { renderRecapModal } from "../src/slack-ui";

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

    app.action<"button">(
      { type: "button", action_id: "recap" },
      // Slack's trigger_id is only valid for a few seconds, so the modal is
      // opened here rather than in a lazy listener.
      async ({ context, payload }) => {
        const action = payload.actions[0];
        // The button carries the timestamp of the message its quiz was played
        // in; that is the row's primary key, so an old summary opens its own
        // quiz rather than the channel's latest.
        const messageTs = action?.value;
        const channelId = "channel" in payload ? payload.channel?.id : undefined;

        const recap =
          messageTs && channelId
            ? await env.CHANNEL_OBJECT.get(
                env.CHANNEL_OBJECT.idFromName(channelId),
              ).getRecap(payload.user.id, messageTs)
            : null;

        if (!recap) {
          await context.respond?.({
            response_type: "ephemeral",
            text: "That quiz's recap is no longer available.",
          });

          return "";
        }

        try {
          await context.client.views.open({
            trigger_id: payload.trigger_id,
            view: renderRecapModal(recap),
          });
        } catch (error) {
          console.error("Failed to open recap:", error);
        }

        return "";
      },
    );

    return await app.run(request, ctx);
  },
};
