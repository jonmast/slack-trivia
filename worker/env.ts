import type { SlackEdgeAppEnv } from "slack-cloudflare-workers";
import type { ChannelObject } from "./channel-object";

export type Env = SlackEdgeAppEnv & {
  CHANNEL_OBJECT: DurableObjectNamespace<ChannelObject>;
  ASSETS: Fetcher;
  /**
   * How long results stay up before the next question, in seconds. Unset in
   * production; tests shorten it so a whole quiz runs in a few seconds.
   */
  RESULTS_SECS?: string;
};
