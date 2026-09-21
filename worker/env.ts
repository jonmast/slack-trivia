import type { SlackEdgeAppEnv } from "slack-cloudflare-workers";
import type { ChannelObject } from "./channel-object";

export type Env = SlackEdgeAppEnv & {
  CHANNEL_OBJECT: DurableObjectNamespace<ChannelObject>;
  ASSETS: Fetcher;
};
